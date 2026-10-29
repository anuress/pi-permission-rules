import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRule, type Rule } from "../extensions/rules.ts";
import type { Config, Mode } from "../extensions/config.ts";
import { parse } from "../extensions/shell.ts";
import { decide, isUnattended, resolveMode, suggestRule, toBlock, type Env } from "../extensions/decide.ts";

const temp = mkdtempSync(join(tmpdir(), "ppr-"));
const rootPath = join(temp, "repo");
mkdirSync(rootPath);
const root = realpathSync(rootPath);
mkdirSync(join(root, "app"));
mkdirSync(join(root, "app", "sub"));
mkdirSync(join(root, "src"));
const sibling = join(temp, "sibling");
mkdirSync(sibling);
const link = join(temp, "repo-link");
symlinkSync(root, link);

function rules(...texts: string[]): Rule[] {
  return texts.map((text) => {
    const rule = parseRule(text);
    assert.ok(rule, `valid rule: ${text}`);
    return rule;
  });
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    allow: [], ask: [], deny: [], readOnlyCommands: [], unattended: "auto", sources: [], ignored: [],
    ...overrides,
  };
}

function env(mode: Mode = "default", overrides: Partial<Config> = {}, cwd = root): Env {
  return { root, cwd, mode, config: config(overrides), session: [] };
}

function run(tool: string, options: { command?: string; path?: string } = {}, state = env()) {
  return decide({ tool, ...options }, state);
}

function verdict(tool: string, expected: "allow" | "ask" | "deny", options: { command?: string; path?: string } = {}, state = env()) {
  const decision = run(tool, options, state);
  assert.equal(decision.verdict, expected, JSON.stringify({ tool, options, decision }));
  return decision;
}

test("spec decision rows: read-only commands, heredoc redirects, and shell parts", () => {
  verdict("bash", "allow", { command: "grep -nc '!!' *.kt" });
  verdict("bash", "allow", { command: "cat > note.md <<'EOF'\nrun git push and curl http://x\nEOF" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cat > note.md <<'EOF'\nrun git push and curl http://x\nEOF" }, env("default"));
  verdict("bash", "allow", { command: 'echo "git push origin"' });
  const multi = verdict("bash", "ask", { command: "git status && git push" });
  assert.deepEqual(multi.flags.map((f) => f.label), ["git push"]);
  assert.equal(multi.flags[0].suggestion, "Bash(git push:*)");
  verdict("bash", "ask", { command: "git status; rm -rf build" }, env("default", { allow: rules("Bash(git status)") }));
  const substitution = verdict("bash", "ask", { command: "echo $(curl http://x)" });
  assert.ok(substitution.flags.some((f) => f.label === "curl http://x"));
  const runner = verdict("bash", "ask", { command: 'bash -c "ls"' });
  assert.equal(runner.flags[0].suggestion, null);
  verdict("bash", "ask", { command: "echo 'unterminated" });
  verdict("bash", "allow", { command: "FOO=1 ./gradlew :app:test" }, env("default", { allow: rules("Bash(./gradlew *)") }));
  verdict("bash", "ask", { command: "git logx" }, env("default", { allow: rules("Bash(git log:*)") }));
  verdict("bash", "ask", { command: "ls > /etc/hosts" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "sed -i s/a/b/ f" });
  verdict("bash", "ask", { command: "find . -name x -delete" });
  verdict("bash", "ask", { command: "gh api repos/o/r -X PATCH -f sha=1" });
  verdict("bash", "ask", { command: "git branch -D x" });
  verdict("bash", "ask", { command: "env rm x" });
  verdict("bash", "allow", { command: "ls" }, env("plan"));
  verdict("bash", "allow", { command: "fumi inspect" }, env("default", { readOnlyCommands: ["fumi"] }));
  verdict("bash", "deny", { command: "./gradlew test" }, env("plan", { allow: rules("Bash(./gradlew *)") }));
});

test("spec decision rows: paths, modes, and read/write rules", () => {
  verdict("write", "deny", { path: "src/a.kt" }, env("plan"));
  verdict("write", "allow", { path: "src/a.kt" }, env("acceptEdits"));
  verdict("write", "ask", { path: "src/a.kt" }, env("default"));
  verdict("write", "ask", { path: ".env" }, env("acceptEdits", { ask: rules("Edit(**/.env*)") }));
  verdict("read", "allow", { path: "../sibling/x" });
  verdict("read", "deny", { path: "local.properties" }, env("default", { deny: rules("Read(**/local.properties)") }));
  verdict("write", "allow", { path: "lib/x.kt" }, env("acceptEdits", {}, join(root, "app")));
  verdict("write", "ask", { path: join(root, "src", "a.kt") }, env("acceptEdits", {
    ask: rules("Edit(src/**)"),
  }, join(root, "app")));
  verdict("write", "ask", { path: "src/../../x" }, env("acceptEdits"));
  verdict("write", "ask", { path: join(sibling, "x") }, env("acceptEdits"));
  verdict("write", "allow", { path: "a.kt" }, env("acceptEdits", {}, link));
});

test("tool paths normalize like pi core before physical-path checks", () => {
  verdict("write", "ask", { path: "~/.ssh/authorized_keys" }, env("acceptEdits"));
  verdict("write", "ask", { path: "~" }, env("acceptEdits"));
  verdict("write", "ask", { path: "@/etc/x" }, env("acceptEdits"));
  verdict("write", "allow", { path: "@src/a.kt" }, env("acceptEdits"));
  verdict("write", "ask", { path: "@src/a.kt" }, env("acceptEdits", { ask: rules("Edit(src/**)") }));
  verdict("write", "allow", { path: "src/a\u00a0b.kt" }, env("acceptEdits"));
  verdict("write", "ask", { path: "src/a\u00a0b.kt" }, env("acceptEdits", { ask: rules("Edit(src/a b.kt)") }));
  verdict("read", "deny", { path: "~/.ssh/id" }, env("acceptEdits", { deny: rules("Read(~/.ssh/**)") }));
  verdict("write", "ask", { path: "file:///etc/x" }, env("acceptEdits"));
});

test("unsafe bash parses ask, plan denies, and matching deny rules still win", () => {
  const normal = verdict("bash", "ask", { command: 'bash -c "echo ok"' });
  assert.equal(normal.flags[0].suggestion, null);
  verdict("bash", "deny", { command: 'bash -c "echo ok"' }, env("plan"));
  verdict("bash", "deny", { command: "git push origin x" }, env("acceptEdits", { deny: rules("Bash(git push:*)") }));
});

test("allow/session rules, deny precedence, and custom tool rules", () => {
  const session: Rule[] = rules("Bash(git push:*)");
  const state = { ...env(), session };
  verdict("bash", "allow", { command: "git push origin x" }, state);
  verdict("bash", "deny", { command: "git push origin x" }, { ...state, config: config({ deny: rules("Bash(git push:*)") }) });
  verdict("web_search", "allow");
  verdict("web_search", "allow", {}, env("plan"));
  verdict("web_search", "deny", {}, env("default", { deny: rules("web_search") }));
  verdict("write", "allow", { path: "session.kt" }, { ...env("default"), session: rules("Edit(session.kt)") });
});

test("dangerous environment assignments are not allowed by read-only or allow coverage", () => {
  const decision = verdict("bash", "ask", { command: "LD_PRELOAD=/tmp/x ls" }, env("default", { allow: rules("Bash") }));
  assert.equal(decision.flags[0].rule, "dangerous env LD_PRELOAD");
  assert.equal(decision.flags[0].suggestion, null);
});

test("cd tracking resolves relative redirects and treats unknown/outside directories as outside", () => {
  verdict("bash", "allow", { command: "cd sub && echo x > out" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd /etc && echo x > hosts" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "(cd /etc; echo x > hosts)" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "(cd /etc); echo x > out" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "echo $(cd /etc; echo x > hosts)" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "echo `cd /etc; echo x > hosts`" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "cd /etc && ls 2>&1" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd /etc && ls 2>& cat" }, env("acceptEdits"));
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    verdict("bash", "allow", { command: "ls 2>&1" }, env(mode));
  }
  verdict("bash", "ask", { command: "cd && echo x > a" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd $HOME && echo x > a" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "echo x > $HOME/a" }, { ...env("acceptEdits"), root: "/" });
  verdict("bash", "ask", { command: "echo x > ~root/f" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd ~root && echo x > f" }, env("acceptEdits"));
  verdict("write", "ask", { path: "~root/f" }, env("acceptEdits"));
  verdict("edit", "ask", { path: "~root/f" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd && cd sub && echo x > out" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "echo $(cd /etc); echo x > out" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "(cd /etc); echo x > out" }, env("acceptEdits"));
});

test("deny reason and toBlock cite the first deny, not an earlier ask", () => {
  const decision = verdict("bash", "deny", { command: "curl x; rm -rf build" }, env("acceptEdits", {
    ask: rules("Bash(curl:*)"), deny: rules("Bash(rm:*)"),
  }));
  assert.equal(decision.flags[0].label, "curl x");
  assert.match(decision.reason, /`rm -rf build` is denied \(Bash\(rm:\*\)\)/);
  assert.equal(toBlock(decision).reason, decision.reason);
});

test("empty or partless bash calls fail closed", () => {
  for (const command of [undefined, "", "(", "!", "|", ";", ">"] as const) {
    const decision = decide(command === undefined ? { tool: "bash" } : { tool: "bash", command }, env("acceptEdits"));
    assert.equal(decision.verdict, "ask", JSON.stringify({ command, decision }));
    assert.equal(decision.flags[0]?.rule, "unparsed: empty command", JSON.stringify({ command, decision }));
    assert.equal(decision.flags[0]?.suggestion, null);
  }

  const alphabet = ["a", "'", '"', "`", "$", "(", ")", "<", ">", "|", "&", ";", "\\", "\n", " ", "#", "="];
  for (let i = 0; i < 1000; i++) {
    let command = "";
    for (let j = 0, length = Math.floor(Math.random() * 20); j < length; j++) {
      command += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const parsed = parse(command);
    if (parsed.parts.length === 0 && parsed.unsafe === undefined) {
      assert.notEqual(decide({ tool: "bash", command }, env()).verdict, "allow", command);
    }
  }
});

test("a redirect deny beats session grants and flags only non-allowed parts", () => {
  const state = { ...env("acceptEdits"), session: rules("Bash(echo:*)", "Edit") };
  const denied = verdict("bash", "deny", { command: "echo x > out" }, { ...state, config: config({ deny: rules("Edit(out)") }) });
  assert.equal(denied.flags[0].label, join(root, "out"));
});

test("repo config entries stay inert in the decision engine (only supplied deny rules apply)", () => {
  const state = env("default", { deny: rules("Bash(curl:*)"), ignored: ["repo allow/defaultMode ignored"] });
  verdict("bash", "ask", { command: "rm x" }, state);
  verdict("bash", "deny", { command: "curl x" }, state);
});

test("suggestRule follows command-name heuristic and suppresses code runners", () => {
  for (const [command, expected] of [
    ["git push origin x", "Bash(git push:*)"],
    ["npm run build", "Bash(npm run:*)"],
    ["./gradlew :shop:test", "Bash(./gradlew:*)"],
    ["curl https://x", "Bash(curl:*)"],
    ["python3 x.py", null],
  ] as const) {
    const parsed = parse(command);
    assert.equal(suggestRule(parsed.parts[0]), expected, command);
  }
  assert.equal(suggestRule(parse("FOO=1 ls").parts[0]), null);
  assert.equal(suggestRule(parse("").parts[0] ?? { argv: [], assignments: [], redirects: [], text: "", scope: "" }), null);
});

test("resolveMode follows precedence and ignores invalid environment values with warning", () => {
  const cfg = config({ defaultMode: "default" });
  assert.deepEqual(resolveMode({}, cfg), { mode: "default" });
  assert.deepEqual(resolveMode({}, config()), { mode: "acceptEdits" });
  assert.deepEqual(resolveMode({ PI_PERMISSIONS_MODE: "plan" }, cfg), { mode: "plan" });
  assert.deepEqual(resolveMode({ PI_PERMISSIONS_MODE: "plan" }, cfg, "acceptEdits"), { mode: "acceptEdits" });
  const invalid = resolveMode({ PI_PERMISSIONS_MODE: "bogus" }, cfg);
  assert.equal(invalid.mode, "default");
  assert.match(invalid.warning ?? "", /bogus/);
  assert.equal(resolveMode({ PI_PERMISSIONS_MODE: "bogus" }, config()).mode, "acceptEdits");
});

test("isUnattended honors UI, explicit settings, and nakama environment", () => {
  assert.equal(isUnattended("auto", true, {}), false);
  assert.equal(isUnattended("auto", true, { NAKAMA_AGENT: "x" }), true);
  assert.equal(isUnattended("auto", true, { PI_PERMISSIONS_UNATTENDED: "1" }), true);
  assert.equal(isUnattended(false, false, {}), true);
  assert.equal(isUnattended(false, true, {}), false);
  assert.equal(isUnattended(true, true, {}), true);
});

test("toBlock uses the exact unattended approval message", () => {
  const denied = run("bash", { command: "git push origin x" });
  assert.deepEqual(toBlock(denied), {
    block: true,
    reason: "permission: `git push origin x` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
  });
  const explicitlyDenied = run("bash", { command: "git push origin x" }, env("default", { deny: rules("Bash(git push:*)") }));
  assert.deepEqual(toBlock(explicitlyDenied), {
    block: true,
    reason: "permission: `git push origin x` is denied (Bash(git push:*)). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
  });
  assert.deepEqual(toBlock({ verdict: "allow", flags: [], reason: "" }), { block: true, reason: "" });
});
