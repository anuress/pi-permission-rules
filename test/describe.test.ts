import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, explain, type PermissionState } from "../extensions/describe.ts";
import { loadConfig } from "../extensions/config.ts";
import { parse } from "../extensions/shell.ts";
import { resolveMode } from "../extensions/decide.ts";
import { keyFilename } from "../extensions/project.ts";

test("describe lists project, source status, ignored entries, mode origin and unattended", () => {
  const temp = mkdtempSync(join(tmpdir(), "ppr-describe-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const global = join(temp, "global.json");
  const project = join(temp, "permissions", "project.json");
  const repo = join(root, ".pi", "permissions.json");
  mkdirSync(join(temp, "permissions"));
  writeFileSync(global, JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }));
  writeFileSync(project, "{");
  mkdirSync(join(root, ".pi"));
  writeFileSync(repo, JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } }));
  const config = loadConfig({ global, project, repo });
  const state: PermissionState = {
    project: { root, key: root }, config, cwd: root, projectFile: project, session: [],
    sessionMode: undefined, processEnv: { PI_PERMISSIONS_MODE: "plan", NAKAMA_AGENT: "worker" }, hasUI: true,
  };
  const output = describe(state);

  assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, new RegExp(keyFilename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, new RegExp(`${global}.*loaded`, "s"));
  assert.match(output, new RegExp(`${project}.*error:`, "s"));
  assert.match(output, new RegExp(`${repo}.*loaded`, "s"));
  assert.match(output, /ignored/i);
  assert.match(output, /plan.*PI_PERMISSIONS_MODE/);
  assert.match(output, /unattended:\s*yes/i);
});

test("explain gives a verdict and matching rule for each shell part", () => {
  const temp = mkdtempSync(join(tmpdir(), "ppr-explain-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const config = loadConfig({ global: join(temp, "missing-global.json"), project: join(temp, "missing-project.json"), repo: join(root, ".pi", "permissions.json") });
  const env = { root, cwd: root, mode: resolveMode({}, config).mode, config, session: [] };
  const output = explain("git status && git push", env);

  assert.match(output, /part git status → allow \(allowed: read-only\)/i);
  assert.match(output, /part git push → ask \(no allow rule\)/i);
  assert.match(output, /overall.*ask/i);
  assert.equal(parse("git status && git push").parts.length, 2);
});

test("explain includes redirect targets and fails closed on unsafe parses", () => {
  const temp = mkdtempSync(join(tmpdir(), "ppr-explain-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const config = loadConfig({ global: join(temp, "missing-global.json"), project: join(temp, "missing-project.json"), repo: join(root, ".pi", "permissions.json") });
  const env = { root, cwd: root, mode: "default" as const, config, session: [] };

  assert.match(explain("echo x > out", env), /redirect .*\/out → ask \(no allow rule\)/i);
  const variableRedirect = explain("echo x > $OUT", env);
  assert.match(variableRedirect, /redirect \/\$OUT → ask \(no allow rule\)/);
  assert.match(variableRedirect, /Overall: ask/);
  assert.match(explain("echo 'unterminated", env), /tool echo 'unterminated → ask \(unparsed:/i);
});

test("explain uses each item recorded by one full decision with resolved redirects", () => {
  const temp = mkdtempSync(join(tmpdir(), "ppr-explain-resolved-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const config = loadConfig({ global: join(temp, "missing-global.json"), project: join(temp, "missing-project.json"), repo: join(root, ".pi", "permissions.json") });
  const env = { root, cwd: root, mode: "acceptEdits" as const, config, session: [] };
  const output = explain("ls > /etc/hosts", env);

  assert.match(output, /part ls → allow \(allowed: read-only\)/);
  assert.match(output, new RegExp(`redirect ${realpathSync("/etc/hosts")} → ask \\(no allow rule\\)`));
  assert.match(output, /Overall: ask/);
});

test("explain displays quoted separators as a single part using the full decision", () => {
  const temp = mkdtempSync(join(tmpdir(), "ppr-explain-quoted-"));
  const root = join(temp, "repo");
  mkdirSync(root);
  const global = join(temp, "global.json");
  writeFileSync(global, JSON.stringify({ permissions: { allow: ["Bash(echo a; b)"] } }));
  const config = loadConfig({ global, project: join(temp, "missing-project.json"), repo: join(root, ".pi", "permissions.json") });
  const env = { root, cwd: root, mode: "default" as const, config, session: [] };
  const output = explain('echo "a; b"', env);

  assert.equal(parse('echo "a; b"').parts.length, 1);
  assert.match(output, /part echo a; b → allow \(allowed: allow rule Bash\(echo a; b\)\)/);
  assert.match(output, /Overall: allow/);
  assert.doesNotMatch(output, /not allowed|Overall: ask/);
});
