import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, type Ui } from "../extensions/prompt.ts";
import type { Call, Decision } from "../extensions/decide.ts";
import type { Mode } from "../extensions/config.ts";
import { matchBash, parseRule } from "../extensions/rules.ts";
import { parse } from "../extensions/shell.ts";

type UiCalls = { title: string; options: string[]; opts?: { timeout?: number } }[];

function fakeUi(answer: string | undefined, inputAnswer?: string): { ui: Ui; calls: UiCalls; inputs: string[] } {
  const calls: UiCalls = [];
  const inputs: string[] = [];
  return {
    calls,
    inputs,
    ui: {
      async select(title, options, opts) {
        calls.push({ title, options, ...(opts === undefined ? {} : { opts }) });
        return answer;
      },
      async input(title) {
        inputs.push(title);
        return inputAnswer;
      },
    },
  };
}

function decision(...suggestions: (string | null)[]): Decision {
  return {
    verdict: "ask",
    flags: suggestions.map((suggestion, index) => ({
      label: `part ${index + 1}`,
      rule: `rule ${index + 1}`,
      suggestion,
    })),
    reason: "",
    items: [],
  };
}

const noOption = "No, and tell pi what to do differently";

test("Bash prompt lists flags and offers deduplicated persistent rules", async () => {
  const persistent = "Yes, and don't ask again for Bash(git push:*) in this project";
  const { ui, calls } = fakeUi(persistent);
  const result = await ask(ui, { tool: "bash", command: "git push origin x" }, decision("Bash(git push:*)", "Bash(git push:*)"), "default");

  assert.deepEqual(calls[0].options, ["Yes", persistent, noOption]);
  assert.equal(calls[0].title, "Permission needed: bash\n- part 1 (rule 1)\n- part 2 (rule 2)");
  assert.deepEqual(result, { allow: true, grant: ["Bash(git push:*)"] });
});

test("Bash prompt joins distinct suggested rules in flag order", async () => {
  const label = "Yes, and don't ask again for Bash(git push:*), Bash(npm run:*) in this project";
  const { ui, calls } = fakeUi(label);
  const result = await ask(ui, { tool: "bash" }, decision("Bash(git push:*)", "Bash(npm run:*)"), "default");
  assert.deepEqual(calls[0].options, ["Yes", label, noOption]);
  assert.deepEqual(result, { allow: true, grant: ["Bash(git push:*)", "Bash(npm run:*)"] });
});

test("R43 offers exact persistent rules only for identical commands", async () => {
  for (const command of ["akasha --help", "make", "git"]) {
    const exact = `Bash(${command})`;
    const option = `Yes, and don't ask again for ${exact} in this project`;
    const { ui, calls } = fakeUi(option);
    const result = await ask(ui, { tool: "bash", command }, {
      verdict: "ask", flags: [{ label: command, rule: "no allow rule", suggestion: null }], reason: "",
      items: [{ kind: "part", label: command, verdict: "ask", rule: "no allow rule" }],
    }, "default");
    assert.deepEqual(calls[0].options, ["Yes", option, noOption]);
    assert.deepEqual(result, { allow: true, grant: [exact] });
  }

  const rule = parseRule("Bash(akasha --help)")!;
  assert.equal(matchBash(rule, parse("akasha --help").parts[0]), true);
  assert.equal(matchBash(rule, parse("akasha --help x").parts[0]), false);
  assert.equal(matchBash(rule, parse("akasha").parts[0]), false);
});

test("R43 suppresses exact rules for wrappers, dynamic text, globs, and unsafe parses", async () => {
  for (const command of [
    "bash --help", "sh --help", "zsh --help", "python -V", "python3 -V", "node --version", "ruby -v", "perl -v",
    "sudo true", "xargs grep x", "env true", "command true", "nohup true", "time true", "nice true", "timeout 2 true",
    "builtin echo x", "npx command", "eval true", "./bash --help", "awk '{print}'", "gawk '{print}'", "sed -n p", "find .", "exec echo x", "source file", ". file",
    'rm "$f"', "ls *.kt", "echo a*b", "echo 'a*b'", "akasha $VERSION", "akasha `echo x`", "FOO=1 make",
    "gh api repos/o/r", "git config core.pager x", "echo 'unterminated", "",
  ]) {
    const part = parse(command).parts[0];
    const label = part?.text ?? command;
    const { ui, calls } = fakeUi("Yes");
    await ask(ui, { tool: "bash", command }, {
      verdict: "ask", flags: [{ label, rule: "no allow rule", suggestion: null }], reason: "",
      items: [{ kind: "part", label, verdict: "ask", rule: "no allow rule" }],
    }, "default");
    assert.equal(calls[0].options.some((option) => option.startsWith("Yes, and don't ask again")), false, command);
  }
});

test("R43 never attaches an exact Bash rule to a redirect flag", async () => {
  const command = "/tmp/path";
  const { ui, calls } = fakeUi("Yes");
  await ask(ui, { tool: "bash", command }, {
    verdict: "ask", flags: [{ label: command, rule: "no allow rule", suggestion: null }], reason: "",
    items: [{ kind: "redirect", label: command, verdict: "ask", rule: "no allow rule" }],
  }, "default");
  assert.deepEqual(calls[0].options, ["Yes", noOption]);
});

test("R43 does not offer an exact rule for an empty label", async () => {
  const { ui, calls } = fakeUi("Yes");
  await ask(ui, { tool: "bash", command: "akasha --help" }, {
    verdict: "ask", flags: [{ label: "", rule: "no allow rule", suggestion: null }], reason: "",
    items: [{ kind: "part", label: "", verdict: "ask", rule: "no allow rule" }],
  }, "default");
  assert.deepEqual(calls[0].options, ["Yes", noOption]);
});

test("any missing suggestion removes persistent option", async () => {
  const { ui, calls } = fakeUi("Yes");
  const result = await ask(ui, { tool: "bash" }, decision("Bash(git push:*)", null), "default");
  assert.deepEqual(calls[0].options, ["Yes", noOption]);
  assert.deepEqual(result, { allow: true });
});

test("default-mode Edit can switch session to acceptEdits", async () => {
  const switchOption = "Yes, allow all edits during this session";
  const { ui, calls } = fakeUi(switchOption);
  const result = await ask(ui, { tool: "write" }, decision(null), "default");
  assert.deepEqual(calls[0].options, ["Yes", switchOption, noOption]);
  assert.deepEqual(result, { allow: true, switchMode: "acceptEdits" });
});

test("R45 outside-root edit can grant its target directory for this session only", async () => {
  const directory = "/work/other-project";
  const option = `Yes, and allow edits in ${directory} during this session`;
  const { ui, calls } = fakeUi(option);
  const d: Decision = {
    verdict: "ask",
    flags: [{ label: `${directory}/file.ts`, rule: "no allow rule", suggestion: null, reason: "outside-project-root", sessionGrantDirectory: directory }],
    reason: "",
    items: [{ kind: "path", label: `${directory}/file.ts`, verdict: "ask", rule: "no allow rule", reason: "outside-project-root", sessionGrantDirectory: directory }],
  };
  const result = await ask(ui, { tool: "write", path: `${directory}/file.ts` }, d, "acceptEdits");
  assert.deepEqual(calls[0].options, ["Yes", option, noOption]);
  assert.deepEqual(result, { allow: true, sessionGrant: [`Edit(${directory}/**)`] });
});

test("R45 can grant an outside redirect target but not a Bash part", async () => {
  const directory = "/work/other-project";
  const option = `Yes, and allow edits in ${directory} during this session`;
  const outside = { label: `${directory}/file`, rule: "no allow rule", suggestion: null, reason: "outside-project-root" as const, sessionGrantDirectory: directory };
  const { ui, calls } = fakeUi(option);
  const redirect: Decision = {
    verdict: "ask", flags: [outside], reason: "",
    items: [
      { kind: "part", label: "echo x", verdict: "allow", rule: "allowed: read-only" },
      { kind: "redirect", label: outside.label, verdict: "ask", rule: outside.rule, reason: outside.reason, sessionGrantDirectory: directory },
    ],
  };
  assert.deepEqual(await ask(ui, { tool: "bash", command: "echo x > /work/other-project/file" }, redirect, "acceptEdits"), {
    allow: true, sessionGrant: [`Edit(${directory}/**)`],
  });
  assert.deepEqual(calls[0].options, ["Yes", option, noOption]);
});

test("R45 does not offer an outside-root grant for mixed reasons, Bash parts, or other modes", async () => {
  const outside = { label: "/work/file", rule: "no allow rule", suggestion: null, reason: "outside-project-root" as const, sessionGrantDirectory: "/work" };
  const mixed = { ...outside, label: "rm x", reason: undefined, sessionGrantDirectory: undefined };
  for (const [tool, flags, mode] of [
    ["write", [outside, mixed], "acceptEdits"],
    ["bash", [outside, { ...outside, label: "rm x", reason: undefined, sessionGrantDirectory: undefined }], "acceptEdits"],
    ["write", [outside], "default"],
  ] as const) {
    const { ui, calls } = fakeUi("Yes");
    const flagsOnly = flags.some((flag) => flag.reason === "outside-project-root")
      ? flags.map((flag) => ({ ...flag, reason: flag.reason === "outside-project-root" ? "outside-project-root" as const : undefined }))
      : flags;
    const items = flagsOnly.map((flag) => ({
      kind: tool === "bash" ? (flag.reason ? "redirect" as const : "part" as const) : "path" as const,
      label: flag.label, verdict: "ask" as const, rule: flag.rule,
      ...(flag.reason === undefined ? {} : { reason: flag.reason, sessionGrantDirectory: flag.sessionGrantDirectory }),
    }));
    await ask(ui, { tool }, { verdict: "ask", flags: flagsOnly, reason: "", items }, mode);
    assert.equal(calls[0].options.includes("Yes, and allow edits in /work during this session"), false);
    assert.equal(calls[0].options.at(-1), noOption);
  }
});

test("Edit outside-root ask in acceptEdits mode has no session switch", async () => {
  const { ui, calls } = fakeUi("Yes");
  await ask(ui, { tool: "edit" }, decision(null), "acceptEdits");
  assert.deepEqual(calls[0].options, ["Yes", noOption]);
});

test("Read and custom tool asks offer only Yes and No", async () => {
  for (const tool of ["read", "web_search"]) {
    const { ui, calls } = fakeUi("Yes");
    await ask(ui, { tool }, decision("Bash(whatever:*)"), "default");
    assert.deepEqual(calls[0].options, ["Yes", noOption]);
  }
});

test("No asks for guidance and includes trimmed non-empty input", async () => {
  const { ui, inputs } = fakeUi(noOption, "  use gh api  ");
  const result = await ask(ui, { tool: "bash" }, decision(null), "default");
  assert.deepEqual(inputs, ["Tell pi what to do differently"]);
  assert.deepEqual(result, { allow: false, reason: "permission: denied by user: use gh api. It was not run." });
});

test("empty or undefined guidance is a plain deny", async () => {
  for (const inputAnswer of ["", "   ", undefined]) {
    const { ui } = fakeUi(noOption, inputAnswer);
    assert.deepEqual(await ask(ui, { tool: "bash" }, decision(null), "default"), {
      allow: false,
      reason: "permission: denied by user. It was not run.",
    });
  }
});

test("escape denies and an explicit timeout is reported", async () => {
  const noTimeout = fakeUi(undefined);
  assert.deepEqual(await ask(noTimeout.ui, { tool: "bash" }, decision(null), "default"), {
    allow: false,
    reason: "permission: denied by user. It was not run.",
  });
  assert.equal(noTimeout.calls[0].opts, undefined);

  const timed = fakeUi(undefined);
  assert.deepEqual(await ask(timed.ui, { tool: "bash" }, decision(null), "default", 4), {
    allow: false,
    reason: "permission: approval timed out. It was not run.",
  });
  assert.deepEqual(timed.calls[0].opts, { timeout: 4000 });
});

test("ordinary selection gets exact timeout opts only when configured", async () => {
  const { ui, calls } = fakeUi("Yes");
  assert.deepEqual(await ask(ui, { tool: "bash" }, decision(null), "default", 2.5), { allow: true });
  assert.deepEqual(calls[0].opts, { timeout: 2500 });
});

test("single Yes allows once", async () => {
  const { ui } = fakeUi("Yes");
  assert.deepEqual(await ask(ui, { tool: "bash" }, decision(null), "default"), { allow: true });
});

test("title formats no-rule and multiple flags", async () => {
  const { ui, calls } = fakeUi("Yes");
  const d: Decision = { verdict: "ask", flags: [{ label: "git push", rule: "no allow rule", suggestion: null }, { label: "out", rule: "Edit(out)", suggestion: null }], reason: "", items: [] };
  await ask(ui, { tool: "bash" } satisfies Call, d, "default" satisfies Mode);
  assert.equal(calls[0].title, "Permission needed: bash\n- git push (no allow rule)\n- out (Edit(out))");
});
