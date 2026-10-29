import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/index.ts";
import { keyFilename } from "../extensions/project.ts";

type Handler = (...args: any[]) => unknown;
type FakeUi = {
  answers: string[];
  selectCalls: { title: string; options: string[] }[];
  notifications: { message: string; level: string }[];
  select(title: string, options: string[]): Promise<string | undefined>;
  input(): Promise<string | undefined>;
  notify(message: string, level: string): void;
};

function setup(): { root: string; agent: string; handlers: Map<string, Handler>; commands: Map<string, Handler>; ui: FakeUi; ctx: any } {
  const temp = mkdtempSync(join(tmpdir(), "ppr-index-"));
  const root = join(temp, "repo");
  const agent = join(temp, "agent");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  process.env.PI_CODING_AGENT_DIR = agent;
  const ui: FakeUi = {
    answers: [], selectCalls: [], notifications: [],
    async select(title, options) {
      this.selectCalls.push({ title, options });
      return this.answers.shift();
    },
    async input() { return undefined; },
    notify(message, level) { this.notifications.push({ message, level }); },
  };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand(name: string, options: { handler: Handler }) { commands.set(name, options.handler); },
  };
  extension(pi as never);
  const ctx = {
    cwd: root,
    hasUI: true,
    ui,
  };
  return { root, agent, handlers, commands, ui, ctx };
}

async function withEnv(overrides: Record<string, string | undefined>, action: () => Promise<void>): Promise<void> {
  const keys = ["PI_CODING_AGENT_DIR", "PI_PERMISSIONS_MODE", "PI_PERMISSIONS_UNATTENDED", "NAKAMA_AGENT"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    } else delete process.env[key];
  }
  try { await action(); }
  finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("unattended asks block with the exact reason and never open UI", async () => {
  await withEnv({ NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: "permission: `git push` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(ui.selectCalls.length, 0);
  });
});

test("persistent approval writes only the agent permission file", async () => {
  await withEnv({}, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    process.env.PI_CODING_AGENT_DIR = agent;
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes, and don't ask again for Bash(git push:*) in this project");
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx);
    assert.equal(result, undefined);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);

    assert.deepEqual(ui.selectCalls[0].options, [
      "Yes", "Yes, and don't ask again for Bash(git push:*) in this project", "No, and tell pi what to do differently",
    ]);
    assert.deepEqual(ui.notifications, []);
    const grantFile = join(agent, "permissions", keyFilename(realpathSync(root)));
    assert.ok(existsSync(grantFile), `missing ${grantFile}; grants=${readdirSync(join(agent, "permissions")).join(",")}`);
    const saved = JSON.parse(readFileSync(grantFile, "utf8"));
    assert.deepEqual(saved.permissions.allow, ["Bash(git push:*)"]);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});

test("hook catches errors from decision evaluation and fails closed", async () => {
  await withEnv({}, async () => {
    const { handlers, ctx } = setup();
    await handlers.get("session_start")!({}, ctx);
    const original = Array.prototype.find;
    Array.prototype.find = function () { throw new Error("injected decide failure"); } as typeof Array.prototype.find;
    try {
      const result = await handlers.get("tool_call")!({ toolName: "custom-tool", input: {} }, ctx);
      assert.deepEqual(result, { block: true, reason: "permission check failed: injected decide failure" });
    } finally {
      Array.prototype.find = original;
    }
  });
});

test("session approval switches to acceptEdits for later in-root writes", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "default" }, async () => {
    const { root, handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes, allow all edits during this session");
    assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: "src/one.txt" } }, ctx), undefined);
    assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: "src/two.txt" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});

test("persistent grant write errors notify but still allow the chosen call", async () => {
  await withEnv({}, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    const projectFile = join(agent, "permissions", keyFilename(realpathSync(root)));
    mkdirSync(join(agent, "permissions"), { recursive: true });
    writeFileSync(projectFile, "{");
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes, and don't ask again for Bash(git push:*) in this project");
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx);
    assert.equal(result, undefined);
    assert.ok(ui.notifications.some(({ level, message }) => level === "error" && message.includes("Unable to save permission grant")));
  });
});

test("PI_PERMISSIONS_UNATTENDED blocks asks without opening UI", async () => {
  await withEnv({ PI_PERMISSIONS_UNATTENDED: "1" }, async () => {
    const { handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: "permission: `git push` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(ui.selectCalls.length, 0);
  });
});

test("missing and non-string bash commands fail closed rather than allowing", async () => {
  await withEnv({}, async () => {
    const { handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    for (const input of [{}, { command: 17 }]) {
      const result = await handlers.get("tool_call")!({ toolName: "bash", input }, ctx);
      assert.notEqual(result, undefined);
    }
    assert.equal(ui.selectCalls.length, 2);
  });
});

test("session grants do not override a matching deny rule", async () => {
  await withEnv({}, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] } }));
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes, and don't ask again for Bash(git:*) in this project");
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git" } }, ctx), undefined);
    const denied = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx);
    assert.deepEqual(denied, {
      block: true,
      reason: "permission: `git push origin main` is denied (Bash(git push:*)). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(ui.selectCalls.length, 1);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});

test("tool_call lazily initializes state before session_start", async () => {
  await withEnv({}, async () => {
    const { handlers, ctx, ui } = setup();
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, ctx);
    assert.equal(result, undefined);
    assert.equal(ui.selectCalls.length, 0);
  });
});

test("powershell is always asked unless explicitly denied", async () => {
  await withEnv({}, async () => {
    const { handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("No, and tell pi what to do differently");
    const result = await handlers.get("tool_call")!({ toolName: "powershell", input: { command: "Get-Process" } }, ctx);
    assert.deepEqual(result, { block: true, reason: "permission: denied by user. It was not run." });
    assert.match(ui.selectCalls[0].title, /Get-Process.*unparsed: powershell/);
  });
});

test("bare powershell deny rules take precedence over the unparsed ask", async () => {
  await withEnv({}, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    process.env.PI_CODING_AGENT_DIR = agent;
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { deny: ["powershell"] } }));
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!({ toolName: "powershell", input: { command: "Get-Process" } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: "permission: `Get-Process` is denied (powershell). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(ui.selectCalls.length, 0);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});

test("permissions command describes, tests without running, and switches session mode", async () => {
  await withEnv({}, async () => {
    const { root, handlers, commands, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const command = commands.get("permissions");
    assert.ok(command);
    await command!("", ctx);
    assert.match(ui.notifications.at(-1)!.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await command!("test git status && git push", ctx);
    assert.match(ui.notifications.at(-1)!.message, /git status.*allow/i);
    assert.match(ui.notifications.at(-1)!.message, /git push.*not allowed.*no allow rule/i);
    await command!("mode plan", ctx);
    assert.match(ui.notifications.at(-1)!.message, /plan/i);
    await command!("mode invalid", ctx);
    assert.equal(ui.notifications.at(-1)!.level, "error");
    assert.match(ui.notifications.at(-1)!.message, /default, acceptEdits, plan/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});
