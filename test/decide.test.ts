import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    allow: [], ask: [], deny: [], ruleSources: new Map(), readOnlyCommands: [], unattended: "auto", sources: [], ignored: [],
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

test("decision items explain each evaluated part and resolved redirect", () => {
  const decision = verdict("bash", "ask", { command: "ls > /etc/hosts" }, env("acceptEdits"));
  assert.deepEqual(decision.items, [
    { kind: "part", label: "ls", verdict: "allow", rule: "allowed: read-only" },
    { kind: "redirect", label: realpathSync("/etc/hosts"), verdict: "ask", rule: "no allow rule", reason: "outside-project-root", sessionGrantDirectory: realpathSync("/etc") },
  ]);

  const compound = verdict("bash", "ask", { command: "git status && git push" });
  assert.deepEqual(compound.items, [
    { kind: "part", label: "git status", verdict: "allow", rule: "allowed: read-only" },
    { kind: "part", label: "git push", verdict: "ask", rule: "no allow rule" },
  ]);
});

test("decision items identify path, custom tool, and unsafe bash evaluations", () => {
  const write = verdict("write", "ask", { path: "src/a.kt" });
  assert.deepEqual(write.items, [
    { kind: "path", label: join(root, "src/a.kt"), verdict: "ask", rule: "no allow rule" },
  ]);
  const custom = verdict("web_search", "allow");
  assert.deepEqual(custom.items, [
    { kind: "tool", label: "web_search", verdict: "allow", rule: "allowed: custom tool" },
  ]);
  const read = verdict("read", "allow", { path: "../sibling/file" });
  assert.deepEqual(read.items[0], { kind: "path", label: join(realpathSync(sibling), "file"), verdict: "allow", rule: "allowed: read tool" });
  const configured = verdict("write", "allow", { path: "src/a.kt" }, env("default", { allow: rules("Edit(src/**)") }));
  assert.equal(configured.items[0].rule, "allowed: allow rule Edit(src/**)");
  const session = verdict("write", "allow", { path: "src/a.kt" }, { ...env(), session: rules("Edit(src/a.kt)") });
  assert.equal(session.items[0].rule, "allowed: session rule Edit(src/a.kt)");
  const inRoot = verdict("write", "allow", { path: "src/new.kt" }, env("acceptEdits"));
  assert.equal(inRoot.items[0].rule, "allowed: inside project root");
  const unsafe = verdict("bash", "ask", { command: "echo 'unterminated" });
  assert.ok(unsafe.items.some((item) => item.kind === "tool" && item.label === "echo 'unterminated" && item.verdict === "ask"));
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
    const expectedRule = command === ">" ? "unparsed: redirect without target"
      : command === "(" ? "unparsed: unmatched (" : "unparsed: empty command";
    assert.equal(decision.flags[0]?.rule, expectedRule, JSON.stringify({ command, decision }));
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
    ["rm a.txt", "Bash(rm a.txt:*)"],
    ["npm run build", "Bash(npm run:*)"],
    ["./gradlew :shop:test", null],
    ["curl https://x", null],
    ["python3 x.py", null],
    ["npx prettier --write .", null],
  ] as const) {
    const parsed = parse(command);
    assert.equal(suggestRule(parsed.parts[0]), expected, command);
  }
  for (const command of ["env ls", "command ls", "nohup ls", "time ls", "nice ls", "timeout 5 ls", "builtin cd", "xargs ls", "awk '{print}'", "gawk '{print}'", "sed -n p f", "find . -name x", "npx prettier --write ."]) {
    assert.equal(suggestRule(parse(command).parts[0]), null, command);
  }
  for (const [command, expected] of [
    ["gh pr merge 1", "Bash(gh pr merge:*)"],
    ["gh issue close 1", "Bash(gh issue close:*)"],
    ["git stash pop", "Bash(git stash pop:*)"],
    ["git remote add origin url", "Bash(git remote add:*)"],
  ] as const) assert.equal(suggestRule(parse(command).parts[0]), expected, command);
  assert.equal(suggestRule(parse("FOO=1 ls").parts[0]), null);
  for (const command of ['rm "$f"', 'git push "$REMOTE" x', "rm *.txt", "rm `echo file`", "rm $(echo file)", "rm $((1+2))", "ls *.kt", "echo a*b", "echo 'a*b'", "akasha $VERSION", "akasha `echo x`", "python3 -V", "gh api repos/o/r"]) {
    assert.equal(suggestRule(parse(command).parts[0]), null, command);
  }
  assert.equal(suggestRule(parse("").parts[0] ?? { argv: [], assignments: [], redirects: [], inputs: [], globs: [], dynamic: [], redirectGlobs: [], inputGlobs: [], text: "", scope: "" }), null);
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
  assert.deepEqual(toBlock({ verdict: "allow", flags: [], reason: "", items: [] }), { block: true, reason: "" });
});

test("C1 arithmetic and assignment expansion repros require approval or plan denial", () => {
  const repros = [
    "echo ${x:='a[$(touch P5)]'} $((x))",
    "x='a[$(touch PWN)]'; echo $((x))",
    "printf -v x \"%s\" 'a[$(touch P6)]'; echo $((x))",
    "test -v PWN",
    "[ -v PWN ]",
    "x='a[$(touch PWN)]'; echo ${y[x]}",
    "PATH=/tmp/evil; ls",
  ];
  for (const command of repros) {
    assert.equal(run("bash", { command }, env("acceptEdits")).verdict, "ask", command);
    assert.equal(run("bash", { command }, env("plan")).verdict, "deny", command);
  }
  assert.equal(run("bash", { command: "echo $((1+2))" }, env("plan")).verdict, "allow");
  const assignment = run("bash", { command: "X=1" }, env("acceptEdits"));
  assert.equal(assignment.verdict, "ask");
  assert.equal(assignment.flags[0].rule, "assignment statement");
  assert.equal(assignment.flags[0].suggestion, null);
});

test("C2 repeated cd in one scope makes later redirects unknown and single cd still works", () => {
  const repros = [
    `cd ~/.ssh || cd ${root}; echo k >> authorized_keys`,
    `cd ~/.ssh; cd ${root} & echo k >> authorized_keys`,
    `cd ~/.ssh; cd ${root} | true; echo k >> authorized_keys`,
  ];
  for (const command of repros) assert.equal(run("bash", { command }, env("acceptEdits")).verdict, "ask", command);
  verdict("bash", "allow", { command: "cd sub && echo x > out" }, env("acceptEdits"));
  verdict("bash", "ask", { command: `cd /etc; (cd ${root}; echo x > out)` }, env("acceptEdits"));
});

test("C3 gh api dangerous clusters are not read-only", () => {
  for (const command of ["gh api -iX DELETE repos/o/r/git/refs/heads/main", "gh api -iXDELETE repos/o/r", "gh api -ifa=b repos/o/r"]) {
    assert.equal(run("bash", { command }, env("acceptEdits")).verdict, "ask", command);
    assert.equal(run("bash", { command }, env("plan")).verdict, "deny", command);
  }
});

test("I1 path-qualified command names never use the built-in read-only allowlist", () => {
  for (const command of ["./ls", "bin/git status", "/tmp/x/cat f"]) {
    assert.equal(run("bash", { command }, env("acceptEdits")).verdict, "ask", command);
  }
});

test("I3 .git write targets always ask outside plan mode", () => {
  verdict("write", "ask", { path: ".git/config" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "echo x > .git/hooks/pre-commit" }, env("acceptEdits"));
  verdict("write", "deny", { path: ".git/config" }, env("plan"));
});

test("C4 darwin case-variant paths match read deny and edit ask rules", () => {
  if (process.platform !== "darwin") return;
  writeFileSync(join(root, "local.properties"), "secret");
  writeFileSync(join(root, ".env"), "secret");
  const state = env("acceptEdits", { deny: rules("Read(**/local.properties)"), ask: rules("Edit(**/.env*)") });
  verdict("read", "deny", { path: "LOCAL.PROPERTIES" }, state);
  verdict("write", "ask", { path: ".ENV" }, state);
  verdict("edit", "ask", { path: ".Env" }, state);
  verdict("bash", "ask", { command: "echo > .ENV" }, state);
});

test("I4 read rules apply to file operands and input redirects", () => {
  const state = env("acceptEdits", { deny: rules("Read(**/local.properties)") });
  for (const command of ["cat local.properties", "cat -n local.properties", "cat < local.properties", "head -5 local.properties", "grep -n key local.properties", "grep -f local.properties other.txt", "grep --file=local.properties other.txt", "grep -flocal.properties other.txt"]) {
    assert.equal(run("bash", { command }, state).verdict, "deny", command);
  }
});

test("R37 Read rules check every read-only argument and input redirect", () => {
  writeFileSync(join(root, "local.properties"), "secret");
  writeFileSync(join(root, "prog.sed"), "p");
  writeFileSync(join(root, "prog.awk"), "{print}");
  const state = env("acceptEdits", { deny: rules("Read(**/local.properties)") });
  const denied = [
    "sed -n p local.properties",
    "sed -n 's/a/b/p' local.properties",
    "sed -e p local.properties",
    "jq -f prog.jq local.properties",
    "cut -c1 local.properties",
    "sed -f prog.sed local.properties",
    "awk -f prog.awk local.properties",
    "grep -e local.properties README.md",
    "jq --arg=local.properties x . package.json",
    "cat < local.properties",
  ];
  for (const command of denied) {
    verdict("bash", "deny", { command }, state);
    verdict("bash", "deny", { command }, { ...state, mode: "plan" });
  }
  for (const command of ["sed -n p README.md", "cut -c1 README.md", "jq . package.json"]) {
    verdict("bash", "allow", { command }, state);
    verdict("bash", "allow", { command }, { ...state, mode: "plan" });
  }
  verdict("bash", "ask", { command: "cut -c1 local.properties" }, env("acceptEdits", { ask: rules("Read(**/local.properties)") }));
});

test("R38 operand-less cd options make the following directory unknown", () => {
  mkdirSync(join(root, "sub"), { recursive: true });
  const state = env("acceptEdits");
  for (const command of ["cd -P && echo x > f", "cd -L; echo x > f", "cd -LP; echo x > f", "cd -- && echo x > f", "cd -P -- && echo x > f", "pushd -n && echo x > f"]) {
    verdict("bash", "ask", { command }, state);
  }
  verdict("bash", "allow", { command: "cd -P sub && echo x > f" }, state);
  verdict("bash", "allow", { command: "cd -P -- sub && echo x > f" }, state);
  verdict("bash", "allow", { command: "cd -LP sub && echo x > f" }, state);
});

test("R39 gh api suggestions are suppressed without changing gh pr suggestions", () => {
  assert.equal(suggestRule(parse("gh api repos/o/r").parts[0]), null);
  assert.equal(suggestRule(parse("gh api -X GET repos/o/r").parts[0]), null);
  assert.equal(suggestRule(parse("gh pr merge 1").parts[0]), "Bash(gh pr merge:*)");
});

test("R40 suggestions handle gh and git global options without broad grants", () => {
  for (const command of ["gh -R o/r api repos/o/r", "/usr/bin/gh api repos/o/r", "git -C x push"]) {
    assert.equal(suggestRule(parse(command).parts[0]), null, command);
  }
  assert.equal(suggestRule(parse("git push origin x").parts[0]), "Bash(git push:*)");
  assert.equal(suggestRule(parse("gh pr merge 1").parts[0]), "Bash(gh pr merge:*)");
});

test("R41 never suggests a one-word prefix rule", () => {
  for (const command of ["git", "gh", "make", "docker --context x run img", "kubectl --kubeconfig x delete pod", "git config core.pager x"]) {
    assert.equal(suggestRule(parse(command).parts[0]), null, command);
  }
  for (const [command, expected] of [
    ["./gradlew test", "Bash(./gradlew test:*)"],
    ["git push origin x", "Bash(git push:*)"],
    ["npm run build", "Bash(npm run:*)"],
    ["gh pr merge 1", "Bash(gh pr merge:*)"],
  ] as const) assert.equal(suggestRule(parse(command).parts[0]), expected, command);
});

test("R45 identifies safe outside-project edits by the target worktree root", () => {
  const target = join(sibling, "nested");
  mkdirSync(target, { recursive: true });
  const calls: { args: string[]; cwd: string }[] = [];
  const state = {
    ...env("acceptEdits"),
    git(args: string[], cwd: string) {
      calls.push({ args, cwd });
      return sibling;
    },
  };
  const result = verdict("write", "ask", { path: join(target, "new.ts") }, state);
  assert.deepEqual(calls, [{ args: ["rev-parse", "--show-toplevel"], cwd: realpathSync(target) }]);
  assert.equal(result.flags[0].reason, "outside-project-root");
  assert.equal(result.flags[0].sessionGrantDirectory, realpathSync(sibling));

  const fallback = verdict("write", "ask", { path: join(target, "new.ts") }, {
    ...state,
    git: () => null,
  });
  assert.equal(fallback.flags[0].sessionGrantDirectory, realpathSync(target));
});

test("R45 outside-project session grant remains below deny, ask, and git protections", () => {
  const target = join(sibling, "nested", "file.ts");
  const grant = rules(`Edit(${realpathSync(sibling)}/**)`);
  const state = { ...env("acceptEdits"), session: grant };
  verdict("write", "allow", { path: target }, state);
  verdict("write", "deny", { path: target }, env("plan"));
  verdict("write", "deny", { path: target }, { ...state, config: config({ deny: rules(`Edit(${realpathSync(sibling)}/**)`) }) });
  verdict("write", "ask", { path: target }, { ...state, config: config({ ask: rules(`Edit(${realpathSync(sibling)}/**)`) }) });
  verdict("write", "ask", { path: ".git/config" }, { ...env("acceptEdits"), session: rules("Edit(**)") });

  const rootGrant = verdict("write", "ask", { path: "/" }, {
    ...env("acceptEdits"),
    git: () => "/",
  });
  assert.equal(rootGrant.flags[0].sessionGrantDirectory, undefined);
  for (const directory of [homedir(), dirname(homedir())]) {
    const unsafe = verdict("write", "ask", { path: join(sibling, "nested", "file.ts") }, {
      ...env("acceptEdits"),
      git: () => directory,
    });
    assert.equal(unsafe.flags[0].sessionGrantDirectory, undefined, directory);
  }
});

test("R46 xargs permits only safe options and bare read-only wrapped commands", () => {
  const allowed = [
    "find . -name '*.ts' | xargs grep -ln registerCommand",
    "xargs -0 -n 5 wc -l",
    "xargs -n5 grep -ln registerCommand",
    "xargs -L 3 -P2 -r cat",
    "xargs --null --no-run-if-empty -d, stat",
  ];
  for (const command of allowed) {
    verdict("bash", "allow", { command }, env("acceptEdits"));
    verdict("bash", "allow", { command }, env("plan"));
  }

  const rejected = [
    "xargs -I{} cat {}", "xargs -i cat", "xargs -a f grep x", "xargs -p cat", "xargs -o cat",
    "xargs -E end cat", "xargs -e end cat", "xargs -s 10 cat", "xargs --arg-file=f cat",
    "xargs --replace cat", "xargs --max-args 2 cat", "xargs --no-run-if-empty= cat",
    "xargs rg x", "xargs sort", "xargs file x", "xargs sed -n p", "xargs find .",
    "xargs awk '{print}'", "xargs sh -c x", "xargs rm x", "xargs /bin/grep x", "xargs",
    "xargs -n cat", "xargs -n 0 cat", "xargs grep *.txt", "xargs grep $(echo x)",
  ];
  for (const command of rejected) {
    verdict("bash", "ask", { command }, env("acceptEdits"));
    verdict("bash", "deny", { command }, env("plan"));
  }

  for (const ruleset of [rules("Read(**/secret)"), rules("Read")]) {
    const state = env("acceptEdits", { deny: ruleset });
    verdict("bash", "ask", { command: "xargs grep x" }, state);
    verdict("bash", "deny", { command: "xargs grep x" }, { ...state, mode: "plan" });
  }
  verdict("bash", "ask", { command: "xargs grep x" }, env("acceptEdits", { ask: rules("Read(**/secret)") }));
  assert.equal(suggestRule(parse("xargs grep x").parts[0]), null);
});

test("R40 Read rules skip command arguments that do not read file contents", () => {
  writeFileSync(join(root, "local.properties"), "secret");
  const state = env("acceptEdits", { deny: rules("Read(**/local.properties)") });
  const commands = [
    "echo local.properties",
    "printf %s local.properties",
    "test -e local.properties",
    "[ -f local.properties ]",
    "cd local.properties",
    "pwd local.properties",
    "basename local.properties",
    "dirname local.properties",
    "realpath local.properties",
    "true local.properties",
    "which local.properties",
  ];
  for (const command of commands) {
    verdict("bash", "allow", { command }, state);
    verdict("bash", "allow", { command }, { ...state, mode: "plan" });
  }
  for (const command of ["cat local.properties", "sed -n p local.properties"]) {
    verdict("bash", "deny", { command }, state);
  }
});

test("I2 glob redirects and cd targets are unknown; safe glob reads stay read-only", () => {
  verdict("bash", "ask", { command: "echo x > *.txt" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "cd sub* && echo x > out" }, env("acceptEdits"));
  for (const command of ["ls *.kt", "cat *.md", "grep x *.kt", "wc -l *.ts"]) {
    verdict("bash", "allow", { command }, env("plan"));
  }
});

test("M6 standard output device redirects are exempt", () => {
  for (const target of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/3"]) {
    verdict("bash", "allow", { command: `echo x > ${target}` }, env("plan"));
  }
});

test("bash garbage fuzz is seeded, fail-closed, and reproducible", () => {
  const seed = 0x5eed1234;
  let state = seed;
  const alpha = ["a", "'", '"', "`", "$", "(", ")", "<", ">", "|", "&", ";", "\\", "\n", " ", "#", "="];
  for (let i = 0; i < 1000; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    let command = "";
    const length = state % 20;
    for (let j = 0; j < length; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      command += alpha[state % alpha.length];
    }
    try {
      assert.notEqual(run("bash", { command }, env("acceptEdits")).verdict, "allow", `seed=${seed} case=${i} command=${JSON.stringify(command)}`);
    } catch (error) {
      assert.fail(`seed=${seed} case=${i} command=${JSON.stringify(command)}: ${String(error)}`);
    }
  }
  for (const command of ["echo 'unterminated", "echo $(", "echo `", "cat <", "echo >", "(echo x", "echo $((x", "echo ${x:=a", "| rm -rf /", "$(rm -rf /)"]) {
    assert.notEqual(run("bash", { command }, env("acceptEdits")).verdict, "allow", command);
  }
});

test("brace-expanded cd and redirect targets are unknown", () => {
  verdict("bash", "ask", { command: "cd {/tmp,zz} && echo k > x" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "echo k > {/tmp/x,}" }, env("acceptEdits"));
});

test("pushd, popd and builtin cd make later relative redirects unknown even when the part is granted", () => {
  const state = { ...env("acceptEdits"), session: rules("Bash(pushd:*)", "Bash(popd:*)", "Bash(builtin cd:*)", "Bash(command cd:*)") };
  for (const command of ["pushd ~/.ssh; echo k >> authorized_keys", "popd; echo k >> authorized_keys", "builtin cd ~/.ssh; echo k >> authorized_keys", "command cd ~/.ssh; echo k >> authorized_keys"]) {
    assert.equal(run("bash", { command }, state).verdict, "ask", command);
  }
});

test("assignment statements honour deny rules", () => {
  verdict("bash", "deny", { command: "X=1" }, env("acceptEdits", { deny: rules("Bash") }));
});

test("for and select loops evaluate only their bodies and substitutions", () => {
  for (const command of [
    "for f in /tmp/a.jsonl; do wc -l \"$f\"; done",
    "for f in *.kt; do cat \"$f\"; done",
  ]) verdict("bash", "allow", { command }, env("acceptEdits"));
  verdict("bash", "allow", { command: "for f in /tmp/a.jsonl; do wc -l \"$f\"; done" }, env("plan"));
  verdict("bash", "allow", { command: "select f in a b; do echo $f; done" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "for f in ${x:=value}; do echo x; done" }, env("acceptEdits"));

  const rm = verdict("bash", "ask", { command: "for f in a b; do rm \"$f\"; done" }, env("acceptEdits"));
  assert.ok(rm.flags.some((flag) => flag.label === "rm $f"));
  assert.equal(rm.flags.find((flag) => flag.label === "rm $f")?.suggestion, null);
  assert.ok(rm.flags.every((flag) => !flag.label.includes("for") && !flag.suggestion?.includes("for")));
  verdict("bash", "ask", { command: "for f in $(curl x); do echo $f; done" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "for f in a; do echo x > /etc/f; done" }, env("acceptEdits"));
  assert.notEqual(run("bash", { command: "for ((i=0;i<3;i++)); do echo $i; done" }, env("acceptEdits")).verdict, "allow");
});

test("for/select headers require a separator and do or brace body", () => {
  for (const command of [
    "for f in a; { rm x; }",
    "for f in a; { rm x; }; echo do; ls",
    "select f in a; { rm x; }",
    "for f in a; echo hi",
    'for f in a; "do"; rm x',
    "for f in a; bleep do rm x; done",
    "for f in a; for g in b; do rm x; done",
    "for f in a b c do rm x; done",
  ]) assert.notEqual(run("bash", { command }, env("acceptEdits")).verdict, "allow", command);
  verdict("bash", "ask", { command: "for f in a; { rm x; }" }, env("acceptEdits"));
  const afterBrace = verdict("bash", "ask", { command: "for f in a; { rm x; }; echo do; ls" }, env("acceptEdits"));
  assert.ok(afterBrace.flags.some((flag) => flag.label === "rm x"));
  verdict("bash", "ask", { command: "for f in a; echo do; rm x" }, env("acceptEdits"));
  const selected = verdict("bash", "ask", { command: "select f in a; { rm x; }" }, env("acceptEdits"));
  assert.ok(selected.flags.some((flag) => flag.label === "rm x"));
  verdict("bash", "allow", { command: "for f in a; { cat f; }" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "for f do rm \"$f\"; done" }, env("acceptEdits"));
});

test("while read loops and ordinary conditional bodies are evaluated safely", () => {
  verdict("bash", "allow", { command: "while read l; do echo \"$l\"; done < f" }, env("acceptEdits"));
  verdict("bash", "deny", { command: "while read l; do echo \"$l\"; done < f" }, env("acceptEdits", { deny: rules("Read(**/f)") }));
  verdict("bash", "ask", { command: "while read l; do echo \"$l\"; done > /etc/x" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "if [ -f x ]; then cat x; fi" }, env("acceptEdits"));
});

test("case arms are syntax; branch commands and subject substitutions are evaluated", () => {
  verdict("bash", "allow", { command: "case x in a) echo hi;; b|c) echo b;; esac" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "case x in a) echo;;& b|c) echo;& esac" }, env("acceptEdits"));
  const rm = verdict("bash", "ask", { command: "case x in a) rm y;; esac" }, env("acceptEdits"));
  assert.ok(rm.flags.some((flag) => flag.label === "rm y"));
  verdict("bash", "ask", { command: "case $(curl x) in a) echo;; esac" }, env("acceptEdits"));
  verdict("bash", "ask", { command: "{ cat a; } > /etc/x" }, env("acceptEdits"));
});

test("compound closing redirects evaluate paths without empty-command flags", () => {
  for (const command of [
    "for x in a; do :; done > /etc/hosts",
    "if true; then :; fi > /etc/hosts",
    "case x in a) :;; esac > /etc/hosts",
    "{ :; } > /etc/hosts",
    "(:) > /etc/hosts",
  ]) {
    const result = verdict("bash", "ask", { command }, env("acceptEdits"));
    assert.ok(result.flags.some((flag) => flag.label === realpathSync("/etc/hosts")));
    assert.ok(result.flags.every((flag) => flag.rule !== "unparsed: empty command"));
  }
  verdict("bash", "deny", { command: "case x in a) :;; esac < f" }, env("acceptEdits", { deny: rules("Read(**/f)") }));
});

test("loop and read commands never produce persistent keyword suggestions", () => {
  const parts = parse("for f in a; do x; done").parts;
  assert.ok(parts.every((part) => !suggestRule(part)?.includes("for")));
  assert.equal(suggestRule(parse("read l").parts[0]), null);
});

test("dangerous loop variables are checked like environment assignments", () => {
  for (const command of ["for PATH in /tmp/evil; do ls; done", "for LD_PRELOAD in /tmp/evil.so; do ls; done", "select BASH_ENV in /tmp/x; do ls; done"]) {
    verdict("bash", "ask", { command }, env("acceptEdits"));
    verdict("bash", "deny", { command }, env("plan"));
  }
  verdict("bash", "allow", { command: "for f in a; do cat \"$f\"; done" }, env("acceptEdits"));
});

test("read assignment targets are checked like environment assignments", () => {
  for (const command of ["read PATH <<< /tmp/evil; ls", "echo /tmp/evil | { read PATH; ls; }", "read -r LD_PRELOAD < f; ls", "read -a PATH", "read -p prompt IFS"]) {
    assert.notEqual(run("bash", { command }, env("acceptEdits")).verdict, "allow", command);
  }
  verdict("bash", "allow", { command: "read -r line" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "read -p PATH line" }, env("acceptEdits"));
});

test("a cd in a loop body or a branch that may not run leaves the directory unknown", () => {
  for (const command of ["for f in a b c; do cd ..; done; echo x > out", "while false; do cd ..; done; echo x > out"]) {
    assert.notEqual(run("bash", { command }, env("acceptEdits", {}, join(root, "app", "sub"))).verdict, "allow", command);
  }
  for (const command of [`if false; then cd ${root}; fi; echo x > out`, `case x in y) cd ${root};; esac; echo x > out`]) {
    assert.notEqual(run("bash", { command }, env("acceptEdits", {}, sibling)).verdict, "allow", command);
  }
  verdict("bash", "allow", { command: "cd app; echo x > out" }, env("acceptEdits"));
});

test("a compound redirect is opened before a cd in the body runs", () => {
  assert.notEqual(run("bash", { command: "{ cd app; } > out" }, env("acceptEdits", { deny: rules("Edit(out)") })).verdict, "allow");
  assert.notEqual(run("bash", { command: "{ cd ..; } > out" }, env("acceptEdits", {}, join(root, "app"))).verdict, "allow");
});

test("fix round 1: brace groups, loop-body redirects and wrapped read stay closed", () => {
  assert.notEqual(run("bash", { command: "for f in a b c; { { echo; }; cd ..; }; echo x > out" }, env("acceptEdits", {}, join(root, "app", "sub"))).verdict, "allow");
  for (const command of ["for f in a b c d; do echo x > out; cd ..; done", "while true; do echo x > out; cd ..; done"]) {
    assert.notEqual(run("bash", { command }, env("acceptEdits", {}, join(root, "app"))).verdict, "allow", command);
  }
  assert.notEqual(run("bash", { command: "builtin read PATH <<< /tmp/evil; ls" }, env("acceptEdits", { allow: rules("Bash(builtin read:*)") })).verdict, "allow");
  assert.notEqual(run("bash", { command: "command read PATH <<< /tmp/evil; ls" }, env("acceptEdits", { allow: rules("Bash(command read:*)") })).verdict, "allow");
  verdict("bash", "allow", { command: "cd app; echo x > out" }, env("acceptEdits"));
  verdict("bash", "allow", { command: "{ cd app; }; echo x > out" }, env("acceptEdits"));
});
