import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, type Part } from "../extensions/shell.ts";
import { CODE_RUNNERS, isReadOnly } from "../extensions/readonly.ts";

function part(text: string): Part {
  if (text === "") return { argv: [], assignments: [], redirects: [], inputs: [], globs: [], dynamic: [], redirectGlobs: [], inputGlobs: [], text: "", scope: "" };
  const parsed = parse(text);
  assert.ok(parsed.parts.length > 0, `expected a parsed command: ${text}`);
  return parsed.parts[0];
}

const readOnlyCases: [string, boolean][] = [
  // Every command name in the unconditional built-in list.
  ...[
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "pwd", "echo", "printf", "which", "file",
    "stat", "du", "df", "jq", "sort", "uniq", "cut", "tr", "diff", "cmp", "basename",
    "dirname", "realpath", "read", "true", "false", ":", "test", "[", "date",
  ].map((command) => [command, true] as [string, boolean]),
  ["cd sub", true],
  ["which node", true],
  ["[ -f file ]", true],
  ["env rm x", false],
  ["/usr/bin/grep x", false],
  ["$COMMAND x", false],
  ["GIT_EXTERNAL_DIFF=/x git diff", false],
  ["LD_PRELOAD=/x ls", false],
  ["PAGER=/x git log", false],
  ["", true],
  ["sort input", true],
  ["sort -nr f", true],
  ["sort -rn f", true],
  ["sort -uk2 f", true],
  ["sort -t, -k2 f", true],
  ["sort --key=1,1 input", true],
  ...[
    "--check", "--debug", "--dictionary-order", "--field-separator=,", "--general-numeric-sort",
    "--human-numeric-sort", "--ignore-case", "--ignore-leading-blanks", "--ignore-nonprinting", "--key=1,1",
    "--merge", "--month-sort", "--numeric-sort", "--parallel=2", "--random-sort", "--reverse", "--stable",
    "--unique", "--version-sort", "--zero-terminated", "--buffer-size=1K",
  ].map((option) => [`sort ${option} f`, true] as [string, boolean]),
  ["sort --numeric-sort --reverse f", true],
  ["sort --num=f", false],
  ["sort --out=/tmp/x in", false],
  ["sort --compress-prog=/x f", false],
  ["sort --temp=/x f", false],
  ["sort --parallel --out=/tmp/x in", false],
  ["sort --output out.txt in", false],
  ["sort -uo out.txt in", false],
  ...[
    "--compress-program /tmp/evil", "--compress-program=/tmp/evil", "-T /tmp", "-T/tmp",
    "--temporary-directory /tmp", "--temporary-directory=/tmp", "-o f", "-of", "-uo f", "-no out", "-ro out",
    "--output f", "--output=f",
  ].map((options) => [`sort ${options} input`, false] as [string, boolean]),
  ["uniq input", true],
  ["uniq input output", false],
  ...[
    "--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated", "--all-repeated",
    "--all-repeated=separate", "--group", "--group=separate",
  ].map((option) => [`uniq ${option} file`, true] as [string, boolean]),
  ["uniq --count", true],
  ["uniq --all-repeated=separate", true],
  ["uniq --skip-fields 1 f", true],
  ["uniq --skip-chars=2 f", true],
  ["uniq --check-chars 3 f", true],
  ["uniq --cou f", false],
  ["date -s value", false],
  ["date -u", true],
  ["date -d 'last Sunday'", true],
  ["date -d'last Sunday'", true],
  ["date -ud 'last Sunday'", true],
  ["date -us 2020-01-01", false],
  ["date -su 2020-01-01", false],
  ["date --set=value", false],
  ["date --s 2020-01-01", false],
  ["date --iso-8601", true],
  ...[
    "--date=yesterday", "--rfc-3339=seconds", "--rfc-email", "--utc", "--universal",
    "--reference=/dev/null", "--debug",
  ].map((option) => [`date ${option}`, true] as [string, boolean]),
  ["rg pattern file", true],
  ["rg --pre cat pattern", false],
  ["rg --pre=cat pattern", false],
  ["fd pattern", true],
  ["file -C -m /tmp/x", false],
  ["file -bC -m /x", false],
  ["file -m/tmp/CMagic f", true],
  ["file -b f", true],
  ["file --mime-type f", true],
  ...[
    "--brief", "--mime", "--mime-encoding", "--dereference", "--no-dereference", "--keep-going", "--raw",
    "--print0", "--no-pad", "--separator=:", "--exclude=ascii", "--files-from=/dev/null", "--uncompress",
    "--special-files", "--extension", "--apple", "--no-buffer",
  ].map((option) => [`file ${option} f`, true] as [string, boolean]),
  ["file --comp f", false],
  ["file -Cm /tmp/x", false],
  ["file --compile", false],
  ["file --compile=/tmp/x", false],
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
  ["sed -nE 's/x/y/p' f", true],
  ["sed -En '1,3p' f", true],
  ["sed -nl 80 '1,3p' f", true],
  ["sed -rn '1,3p' f", true],
  ["sed 's/a/b/g' file", true],
  ...["-i", "-i.bak", "--in-place", "--in-place=backup", "-f", "--file"].map(
    (flag) => [`sed ${flag} script file`, false] as [string, boolean],
  ),
  ["sed -e 'w output' file", false],
  ["sed -e 's/a/b/w output' file", false],
  ["sed -e 's/a/b/e' file", false],
  ["sed \"1e touch /tmp/pwned\" file", false],
  ["sed '$w out' file", false],
  ["sed '/x/w out' file", false],
  ["sed -n '/a/,/b/W out' f", false],
  ["sed 's/a/b/w out' file", false],
  ["sed 's/a/b/e' file", false],
  ["sed -n 1,5p f", true],
  ["sed -n '/error/p' f", true],
  ["sed --quiet -n 1p f", true],
  ...[
    "--silent", "--regexp-extended", "--posix", "--null-data", "--zero-terminated", "--separate", "--debug", "--sandbox",
  ].map((option) => [`sed ${option} 's/a/b/g' f`, true] as [string, boolean]),
  ["sed --regexp-extended 's/a/b/g' f", true],
  ["sed --null-data 's/a/b/g' f", true],
  ["sed --expression=1p f", true],
  ["sed --in s/a/b/ f", false],
  ["sed --exp='1e id' f", false],
  ["sed --expression='1e id' f", false],
  ["sed -E 's/(a+)/\\1x/' f", true],
  ["sed 's/hello/world/g' f", true],
  ["sed 's#foo\\#bar#baz#g' f", true],
  ["sed '\\%error%p' f", true],
  ["sed 'y/ew/ab/' f", true],
  ["sed -ni 's/a/b/' f", false],
  ["sed -nie 's/a/b/' f", false],
  ["sed -E -i 's/a/b/' f", false],
  ["sed -iE 's/a/b/' f", false],
  ["sed '\\%x%e id' f", false],
  ["sed 's/a/b' f", false],
  ["sed 'y/a/b' f", false],
  ["sed /x f", false],

  // awk: only a simple, inline, non-executing program is allowed.
  ["awk '{print $1}' file", true],
  ["awk -v x=1 -F , '{print x}' file", true],
  ["awk -f script.awk file", false],
  ["awk --file=script.awk", false],
  ...["-i include.awk", "-iinclude.awk", "--include include.awk", "--include=include.awk", "-l library", "-llibrary", "--load library", "--load=library", "-E script.awk", "-Escript.awk", "--exec script.awk", "--exec=script.awk", "-p", "-p=/tmp/profile", "--profile", "--profile=/tmp/profile"].map(
    (options) => [`awk ${options} '{print}' file`, false] as [string, boolean],
  ),
  ["awk '@load \"/tmp/evil\"' file", false],
  ["awk '@include \"/tmp/other.awk\"' file", false],
  ["awk --lo x '{print}'", false],
  ["awk --inc x '{print}'", false],
  ["awk --non-decimal-data '{print}' f", true],
  ["awk --posix '{print}' f", true],
  ...[
    "--field-separator=,", "--assign=x=1", "--traditional", "--re-interval", "--characters-as-bytes",
    "--sandbox", "--lint",
  ].map((option) => [`awk ${option} '{print}' f`, true] as [string, boolean]),
  ["awk '{system(\"x\")}'", false],
  ["awk '{print x > \"out\"}'", false],
  ["awk '{print x | \"cmd\"}'", false],
  ["awk '{getline x}'", false],

  // git read subcommands and constrained operations.
  ...["status", "log", "show", "diff", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "merge-base", "cat-file", "describe", "shortlog", "reflog"].map(
    (subcommand) => [`git ${subcommand}`, true] as [string, boolean],
  ),
  ["git reflog -5", true],
  ["git reflog HEAD", true],
  ["git reflog show HEAD", true],
  ["git reflog show --oneline", true],
  ["git reflog expire --all", false],
  ["git reflog delete HEAD@{1}", false],
  ["git reflog drop HEAD", false],
  ["git reflog exists HEAD", false],
  ["git reflog -- expire --all", false],
  ["git reflog -- delete HEAD@{1}", false],
  ["git reflog -- show --output=/x", false],
  ["git reflog -1 expire", false],
  ["git -C /x --no-pager log", true],
  ["git --git-dir=/x log", true],
  ["git --work-tree=/x log", true],
  ["git -C /x push", false],
  ...["-c diff.external=/x", "-c core.fsmonitor=/x", "-c color.ui=never", "-cfoo=bar", "--config-env", "--config-env=core.pager=ENV"].map(
    (options) => [`git ${options} diff`, false] as [string, boolean],
  ),
  ["git diff --output=f", false],
  ["git diff --out=f", false],
  ["git log --open", false],
  ["git grep --op pattern", false],
  ["git grep --open pattern", false],
  ["git diff --outp=/tmp/x", false],
  ["git log --oneline -5", true],
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
  ["gh api -XGET repos/o/r", true],
  ["gh api -XPOST repos/o/r", false],
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

test("extra commands match argv[0] exactly and allow arbitrary arguments", () => {
  assert.equal(isReadOnly(part("fumi search x"), ["fumi"]), true);
  assert.equal(isReadOnly(part("fumi search x"), []), false);
  assert.equal(isReadOnly(part("/usr/local/bin/fumi anything"), ["/opt/tools/fumi"]), false);
});

test("CODE_RUNNERS is exactly the no-persistent-option command set", () => {
  assert.deepEqual([...CODE_RUNNERS].sort(), [
    ".", "bash", "env", "eval", "exec", "node", "perl", "python", "python3", "ruby", "sh", "source", "sudo", "xargs", "zsh",
  ]);
  assert.ok(CODE_RUNNERS instanceof Set);
});

test("read-only commands reject path-qualified and configured command names", () => {
  for (const command of ["./ls", "bin/git status", "/tmp/x/cat f"]) {
    assert.equal(isReadOnly(part(command), []), false, command);
  }
  assert.equal(isReadOnly(part("/usr/bin/grep x"), []), false);
  assert.equal(isReadOnly(part("/usr/local/bin/fumi x"), ["fumi"]), false);
  assert.equal(isReadOnly(part("/usr/local/bin/fumi x"), ["/usr/local/bin/fumi"]), true);
  assert.equal(isReadOnly(part("fumi x"), ["fumi"]), true);
});

test("unquoted glob operands block checked read-only commands only", () => {
  for (const command of ["find *", "sed -n p *", "sort *", "rg TODO *", "fd TODO *", "git log *", "file *", "uniq *", "date *", "awk '{print}' *"]) {
    assert.equal(isReadOnly(part(command), []), false, command);
  }
  for (const command of ["ls *.kt", "cat *.md", "grep x *.kt", "wc -l *.ts", "cat '*.md'"]) {
    assert.equal(isReadOnly(part(command), []), true, command);
  }
});

test("read, true, false and colon builtins are read-only without filtering read options", () => {
  for (const command of ["read variable", "read -r variable", "read -u fd variable", "true", "false", ":"]) {
    assert.equal(isReadOnly(part(command), []), true, command);
  }
});

test("printf -v and test -v are not read-only", () => {
  for (const command of ["printf -v x hi", "test -v x", "[ -v x ]"]) {
    assert.equal(isReadOnly(part(command), []), false, command);
  }
  assert.equal(isReadOnly(part("printf hi"), []), true);
});

test("sed and awk variable scripts are not treated as literal read-only programs", () => {
  for (const command of ["sed $x f", "sed -e $x f", "awk $x f", "awk $(cat script.awk) f"]) {
    assert.equal(isReadOnly(part(command), []), false, command);
  }
});

test("gh api requires only explicitly read-only options and GET method", () => {
  for (const command of ["gh api -iX DELETE repos/o/r/git/refs/heads/main", "gh api -iXDELETE repos/o/r", "gh api -ifa=b repos/o/r"]) {
    assert.equal(isReadOnly(part(command), []), false, command);
  }
  for (const command of ["gh api -i repos/o/r", "gh api -H Accept:json repos/o/r", "gh api -q .name repos/o/r", "gh api -X GET repos/o/r", "gh api -iXGET repos/o/r", "gh api --method=GET repos/o/r"]) {
    assert.equal(isReadOnly(part(command), []), true, command);
  }
});
