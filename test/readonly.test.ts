import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, type Part } from "../extensions/shell.ts";
import { CODE_RUNNERS, isReadOnly } from "../extensions/readonly.ts";

function part(text: string): Part {
  if (text === "") return { argv: [], redirects: [], text: "" };
  const parsed = parse(text);
  assert.ok(parsed.parts.length > 0, `expected a parsed command: ${text}`);
  return parsed.parts[0];
}

const readOnlyCases: [string, boolean][] = [
  // Every command name in the unconditional built-in list.
  ...[
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "pwd", "echo", "printf", "which", "file",
    "stat", "du", "df", "jq", "sort", "uniq", "cut", "tr", "diff", "cmp", "basename",
    "dirname", "realpath", "true", "test", "[", "date",
  ].map((command) => [command, true] as [string, boolean]),
  ["cd sub", true],
  ["which node", true],
  ["[ -f file ]", true],
  ["env rm x", false],
  ["/usr/bin/grep x", true],
  ["$COMMAND x", false],
  ["", true],
  ["sort input", true],
  ["sort -o output input", false],
  ["sort --output=output input", false],
  ["uniq input", true],
  ["uniq input output", false],
  ["date -s value", false],
  ["date --set=value", false],
  ["rg pattern file", true],
  ["rg --pre cat pattern", false],
  ["rg --pre=cat pattern", false],
  ["fd pattern", true],
  ...["-x", "--exec", "-X", "--exec-batch"].map(
    (flag) => [`fd ${flag} cmd`, false] as [string, boolean],
  ),

  // find: actions that can write or execute code are not read-only.
  ["find . -name '*.ts'", true],
  ["find . -fprint-output", false],
  ...["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"].map(
    (flag) => [`find . ${flag} x`, false] as [string, boolean],
  ),

  // sed: in-place edits, external scripts, and writing/execution commands are denied.
  ["sed -n 1p file", true],
  ["sed 's/a/b/g' file", true],
  ...["-i", "-i.bak", "--in-place", "--in-place=backup", "-f", "--file"].map(
    (flag) => [`sed ${flag} script file`, false] as [string, boolean],
  ),
  ["sed -e 'w output' file", false],
  ["sed -e 's/a/b/w output' file", false],
  ["sed -e 's/a/b/e' file", false],

  // awk: only a simple, inline, non-executing program is allowed.
  ["awk '{print $1}' file", true],
  ["awk -v x=1 -F , '{print x}' file", true],
  ["awk -f script.awk file", false],
  ["awk --file=script.awk", false],
  ["awk '{system(\"x\")}'", false],
  ["awk '{print x > \"out\"}'", false],
  ["awk '{print x | \"cmd\"}'", false],
  ["awk '{getline x}'", false],

  // git read subcommands and constrained operations.
  ...["status", "log", "show", "diff", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "merge-base", "cat-file", "describe", "shortlog", "reflog"].map(
    (subcommand) => [`git ${subcommand}`, true] as [string, boolean],
  ),
  ["git -C /x --no-pager -c a=b log", true],
  ["git -C /x push", false],
  ["git diff --output=f", false],
  ["git grep -O pager pattern", false],
  ["git grep --open-files-in-pager=pager pattern", false],
  ["git branch", true],
  ...["-a", "-r", "--list", "-v", "-vv", "--show-current"].map(
    (flag) => [`git branch ${flag}`, true] as [string, boolean],
  ),
  ["git branch --list 'feature*'", true],
  ["git branch -D x", false],
  ["git branch feature", false],
  ["git remote", true],
  ["git remote -v", true],
  ["git remote add origin url", false],
  ["git stash list", true],
  ["git stash pop", false],
  ...["--get", "--get-all", "--get-regexp", "--list", "-l"].map(
    (flag) => [`git config ${flag} x`, true] as [string, boolean],
  ),
  ["git config --edit", false],
  ["git config --get x --unset y", false],
  ["git config --list --add x y", false],
  ["git config x y", false],

  // gh read subcommands; gh api must remain a GET without mutation fields.
  ...["view", "list", "diff", "checks"].map(
    (action) => [`gh pr ${action} 1`, true] as [string, boolean],
  ),
  ...["view", "list"].map(
    (action) => [`gh issue ${action} 1`, true] as [string, boolean],
  ),
  ["gh pr merge 1", false],
  ["gh issue close 1", false],
  ["gh api repos/o/r", true],
  ["gh api repos/o/r --method GET", true],
  ["gh api repos/o/r -X GET", true],
  ["gh api repos/o/r -X PATCH", false],
  ["gh api repos/o/r --method=POST", false],
  ...["-f", "-F", "--field", "--raw-field", "--input"].map(
    (flag) => [`gh api repos/o/r ${flag} a=b`, false] as [string, boolean],
  ),
];

test("isReadOnly follows the built-in command allowlist", () => {
  for (const [text, expected] of readOnlyCases) {
    assert.equal(isReadOnly(part(text), []), expected, text || "empty argv");
  }
});

test("extra commands are matched by basename and allow arbitrary arguments", () => {
  assert.equal(isReadOnly(part("fumi search x"), ["fumi"]), true);
  assert.equal(isReadOnly(part("fumi search x"), []), false);
  assert.equal(isReadOnly(part("/usr/local/bin/fumi anything"), ["/opt/tools/fumi"]), true);
});

test("CODE_RUNNERS is exactly the no-persistent-option command set", () => {
  assert.deepEqual([...CODE_RUNNERS].sort(), [
    ".", "bash", "env", "eval", "exec", "node", "perl", "python", "python3", "ruby", "sh", "source", "sudo", "xargs", "zsh",
  ]);
  assert.ok(CODE_RUNNERS instanceof Set);
});
