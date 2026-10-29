import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import type { Part } from "../extensions/shell.ts";
import { matchBash, matchPath, parseRule, toolFamily } from "../extensions/rules.ts";

function rule(text: string) {
  const parsed = parseRule(text);
  assert.ok(parsed, `expected valid rule: ${text}`);
  return parsed;
}

function part(text: string): Part {
  return { argv: text ? text.split(" ") : [], assignments: [], redirects: [], text, scope: "" };
}

test("parseRule parses bare and patterned tools and rejects malformed syntax", () => {
  assert.deepEqual(parseRule("Bash(git log:*)"), {
    tool: "Bash",
    pattern: "git log:*",
    text: "Bash(git log:*)",
  });
  assert.deepEqual(parseRule("Bash"), { tool: "Bash", text: "Bash" });
  assert.equal(parseRule("Bash("), null);
  assert.equal(parseRule("Bash()"), null);
  assert.equal(parseRule("Bash(x) trailing"), null);
  assert.equal(parseRule("Bash(x) trailing)"), null);
  assert.equal(parseRule("Bash(foo(bar)"), null);
  assert.equal(parseRule("Bash(foo))"), null);
  assert.deepEqual(parseRule("Bash( x )"), {
    tool: "Bash",
    pattern: " x ",
    text: "Bash( x )",
  });
  assert.deepEqual(parseRule("Bash(foo(bar))"), {
    tool: "Bash",
    pattern: "foo(bar)",
    text: "Bash(foo(bar))",
  });
  assert.deepEqual(parseRule("  mcp__x__y(pattern)  "), {
    tool: "mcp__x__y",
    pattern: "pattern",
    text: "  mcp__x__y(pattern)  ",
  });
  assert.equal(parseRule("1Bash"), null);
});

test("matchBash supports exact, prefix, glob, bare, and redirect-only matching", () => {
  assert.equal(matchBash(rule("Bash(git status)"), part("git status")), true);
  assert.equal(matchBash(rule("Bash(git status)"), part("git status -s")), false);
  assert.equal(matchBash(rule("Bash(git log:*)"), part("git log")), true);
  assert.equal(matchBash(rule("Bash(git log:*)"), part("git log -5")), true);
  assert.equal(matchBash(rule("Bash(git log:*)"), part("git logx")), false);
  assert.equal(matchBash(rule("Bash(git log:*x)"), part("git log")), false);
  assert.equal(matchBash(rule("Bash(git log:*x)"), part("git log:optionx")), true);
  assert.equal(matchBash(rule("Bash(./gradlew *)"), part("./gradlew :a:test")), true);
  assert.equal(matchBash(rule("Bash(a*b)"), part("a/x/b")), true);
  assert.equal(matchBash(rule("Bash(a?b)"), part("a?b")), true);
  assert.equal(matchBash(rule("Bash(a?b)"), part("aXb")), false);
  assert.equal(matchBash(rule("Bash"), part("anything")), true);
  assert.equal(matchBash(rule("Bash"), part("")), true);
  assert.equal(matchBash(rule("Bash(*)"), part("")), false);
  assert.equal(matchBash(rule("Read"), part("anything")), false);
});

test("matchPath resolves relative, absolute, home, and recursive globs", () => {
  const root = "/r";
  assert.equal(matchPath(rule("Edit(**/.env*)"), "/r/.env", root), true);
  assert.equal(matchPath(rule("Edit(**/.env*)"), "/r/a/b/.env.local", root), true);
  assert.equal(matchPath(rule("Edit(src/**)"), "/r/src/a/b.kt", root), true);
  assert.equal(matchPath(rule("Edit(src/**)"), "/r/lib/src/x", root), false);
  assert.equal(matchPath(rule("Read(/etc/**)"), "/etc/hosts", root), true);
  assert.equal(matchPath(rule("Read(~/.ssh/**)"), `${homedir()}/.ssh/id`, root), true);
});

test("path single-character globs do not cross directory separators", () => {
  assert.equal(matchPath(rule("Read(file.txt)"), "/r/file.txt", "/r"), true);
  assert.equal(matchPath(rule("Read(file.txt)"), "/r/fileXtxt", "/r"), false);
  assert.equal(matchPath(rule("Read(src/[a].ts)"), "/r/src/[a].ts", "/r"), true);
  assert.equal(matchPath(rule("Read(src/*.ts)"), "/r/src/a.ts", "/r"), true);
  assert.equal(matchPath(rule("Read(src/*.ts)"), "/r/src/nested/a.ts", "/r"), false);
  assert.equal(matchPath(rule("Read(src/?.ts)"), "/r/src/a.ts", "/r"), true);
  assert.equal(matchPath(rule("Read(src/?.ts)"), "/r/src/ab.ts", "/r"), false);
});

test("matchPath only supports Read and Edit families, with bare rules matching all paths", () => {
  assert.equal(matchPath(rule("Read"), "/any/path", "/r"), true);
  assert.equal(matchPath(rule("Edit"), "/any/path", "/r"), true);
  assert.equal(matchPath(rule("Bash(*)"), "/r/file", "/r"), false);
  assert.equal(matchPath(rule("Custom(*)"), "/r/file", "/r"), false);
});

test("toolFamily normalizes built-in tool names and preserves custom names", () => {
  assert.equal(toolFamily("bash"), "Bash");
  for (const name of ["read", "grep", "find", "ls"]) assert.equal(toolFamily(name), "Read");
  for (const name of ["edit", "write"]) assert.equal(toolFamily(name), "Edit");
  assert.equal(toolFamily("mcp__x__y"), "mcp__x__y");
  assert.equal(toolFamily("Bash"), "Bash");
});
