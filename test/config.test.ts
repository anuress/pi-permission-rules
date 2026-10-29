import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGrant, loadConfig } from "../extensions/config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ppr-"));
}

function json(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test("global, project and repo config merge with repo config only tightening", () => {
  const temp = tempDir();
  try {
    const root = join(temp, "repo");
    const home = join(temp, "agent");
    const global = join(home, "permissions.json");
    const projectFile = join(home, "permissions", "repo.json");
    const repoFile = join(root, ".pi", "permissions.json");
    json(global, { permissions: { allow: ["Bash(global)"], ask: ["Edit(global)"], defaultMode: "default" }, readOnlyCommands: ["one"], unattended: false, askTimeoutSec: 5 });
    json(projectFile, { permissions: { allow: ["Bash(project)"], deny: ["Read(project)"], defaultMode: "plan" }, readOnlyCommands: ["two", "one"], unattended: "auto", askTimeoutSec: 10 });
    json(repoFile, { permissions: { allow: ["Bash(repo)"], ask: ["Edit(repo)"], deny: ["Read(repo)"], defaultMode: "acceptEdits" }, readOnlyCommands: ["three"], unattended: true, askTimeoutSec: 20 });

    const config = loadConfig({ global, project: projectFile, repo: repoFile });
    assert.deepEqual(config.allow.map((rule) => rule.text), ["Bash(global)", "Bash(project)"]);
    assert.deepEqual(config.ask.map((rule) => rule.text), ["Edit(global)", "Edit(repo)"]);
    assert.deepEqual(config.deny.map((rule) => rule.text), ["Read(project)", "Read(repo)"]);
    assert.equal(config.defaultMode, "plan");
    assert.deepEqual(config.readOnlyCommands, ["one", "two"]);
    assert.equal(config.unattended, "auto");
    assert.equal(config.askTimeoutSec, 10);
    assert.deepEqual(config.ignored, [
      `${repoFile}: allow (repo file can only add ask/deny)`,
      `${repoFile}: defaultMode (repo file can only add ask/deny)`,
      `${repoFile}: readOnlyCommands (repo file can only add ask/deny)`,
      `${repoFile}: unattended (repo file can only add ask/deny)`,
      `${repoFile}: askTimeoutSec (repo file can only add ask/deny)`,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("broken project JSON reports the source error and leaves global config available", () => {
  const temp = tempDir();
  try {
    const global = join(temp, "agent", "permissions.json");
    const projectFile = join(temp, "agent", "permissions", "repo.json");
    const repoFile = join(temp, "repo", ".pi", "permissions.json");
    json(global, { permissions: { allow: ["Bash(global)"] } });
    mkdirSync(join(projectFile, ".."), { recursive: true });
    writeFileSync(projectFile, "{");

    const config = loadConfig({ global, project: projectFile, repo: repoFile });
    assert.deepEqual(config.allow.map((rule) => rule.text), ["Bash(global)"]);
    assert.equal(config.sources[1].path, projectFile);
    assert.equal(config.sources[1].loaded, false);
    assert.match(config.sources[1].error ?? "", /invalid JSON/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("missing sources are reported unloaded without errors", () => {
  const temp = tempDir();
  try {
    const config = loadConfig({
      global: join(temp, "agent", "permissions.json"),
      project: join(temp, "agent", "permissions", "repo.json"),
      repo: join(temp, "repo", ".pi", "permissions.json"),
    });
    assert.equal(config.sources.length, 3);
    assert.ok(config.sources.every((source) => !source.loaded && source.error === undefined));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed rule strings are skipped and reported", () => {
  const temp = tempDir();
  try {
    const global = join(temp, "agent", "permissions.json");
    json(global, { permissions: { allow: ["Bash(ok)", "bad("], ask: [12] } });
    const config = loadConfig({ global, project: join(temp, "project.json"), repo: join(temp, "repo", ".pi", "permissions.json") });
    assert.deepEqual(config.allow.map((rule) => rule.text), ["Bash(ok)"]);
    assert.deepEqual(config.ignored, [
      `${global}: rule "bad(" (malformed)`,
      `${global}: rule "12" (malformed)`,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("invalid fields are skipped with ignored reasons", () => {
  const temp = tempDir();
  try {
    const global = join(temp, "agent", "permissions.json");
    json(global, { permissions: { defaultMode: "bypassPermissions" }, unattended: "yes", askTimeoutSec: 0, readOnlyCommands: ["fumi", 3] });
    const config = loadConfig({ global, project: join(temp, "project.json"), repo: join(temp, "repo", ".pi", "permissions.json") });
    assert.equal(config.defaultMode, undefined);
    assert.equal(config.unattended, "auto");
    assert.equal(config.askTimeoutSec, undefined);
    assert.deepEqual(config.readOnlyCommands, []);
    assert.deepEqual(config.ignored, [
      `${global}: defaultMode (invalid value)`,
      `${global}: readOnlyCommands (expected an array of strings)`,
      `${global}: unattended (invalid value)`,
      `${global}: askTimeoutSec (invalid value)`,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("addGrant creates parent path and writes permissions.allow", () => {
  const temp = tempDir();
  try {
    const file = join(temp, "missing", "permissions.json");
    addGrant(file, ["Bash(new)"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { permissions: { allow: ["Bash(new)"] } });
    assert.deepEqual(readdirSync(join(temp, "missing")), ["permissions.json"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("addGrant preserves keys, deduplicates and rereads a concurrent update", () => {
  const temp = tempDir();
  try {
    const file = join(temp, "permissions.json");
    json(file, { extra: 1, permissions: { ask: ["Edit(x)"], allow: ["Bash(existing)"] }, tail: true });
    const beforeKeys = Object.keys(JSON.parse(readFileSync(file, "utf8")));
    loadConfig({ global: file, project: join(temp, "project.json"), repo: join(temp, "repo", ".pi", "permissions.json") });
    const current = JSON.parse(readFileSync(file, "utf8"));
    current.permissions.allow.push("Bash(concurrent-B)");
    writeFileSync(file, JSON.stringify(current));
    addGrant(file, ["Bash(new-A)", "Bash(existing)"]);

    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(parsed), beforeKeys);
    assert.deepEqual(parsed.permissions.allow, ["Bash(existing)", "Bash(concurrent-B)", "Bash(new-A)"]);
    assert.deepEqual(parsed.permissions.ask, ["Edit(x)"]);
    assert.equal(parsed.tail, true);
    assert.ok(!readdirSync(temp).some((name) => name.endsWith(".tmp")));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("addGrant rejects existing invalid JSON without overwriting", () => {
  const temp = tempDir();
  try {
    const file = join(temp, "permissions.json");
    writeFileSync(file, "{");
    assert.throws(() => addGrant(file, ["Bash(new)"]), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(readFileSync(file, "utf8"), "{");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
