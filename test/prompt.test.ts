import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, type Ui } from "../extensions/prompt.ts";
import type { Call, Decision } from "../extensions/decide.ts";
import type { Mode } from "../extensions/config.ts";

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
  const d: Decision = { verdict: "ask", flags: [{ label: "git push", rule: "no allow rule", suggestion: null }, { label: "out", rule: "Edit(out)", suggestion: null }], reason: "" };
  await ask(ui, { tool: "bash" } satisfies Call, d, "default" satisfies Mode);
  assert.equal(calls[0].title, "Permission needed: bash\n- git push (no allow rule)\n- out (Edit(out))");
});
