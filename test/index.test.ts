import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/index.ts";
import { keyFilename } from "../extensions/project.ts";

type Handler = (...args: any[]) => unknown;
type FakeReply = { stopReason?: string; content?: { type: string; text?: string }[] };
type FakeClassifier = {
  calls: { model: unknown; messages: { content: { text: string }[] }[] }[];
  next: (FakeReply | Error | null)[];
  found: string[];
  models: Map<string, unknown>;
  branch: unknown[];
  reply: FakeReply;
  block: (reason: string) => FakeReply;
};
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
  const classifier: FakeClassifier = {
    calls: [], next: [], found: [], branch: [],
    models: new Map<string, unknown>([
      ["session/session-model", { provider: "session", id: "session-model" }],
      ["p/m", { provider: "p", id: "m" }],
    ]),
    reply: { stopReason: "stop", content: [{ type: "text", text: "ALLOW" }] },
    block(reason: string) { return { stopReason: "stop", content: [{ type: "text", text: `BLOCK: ${reason}` }] }; },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    ui,
    model: classifier.models.get("session/session-model"),
    signal: undefined,
    modelRegistry: {
      find(provider: string, modelId: string) {
        classifier.found.push(`${provider}/${modelId}`);
        return classifier.models.get(`${provider}/${modelId}`);
      },
      async complete(model: unknown, messages: { content: { text: string }[] }[]) {
        classifier.calls.push({ model, messages });
        const next = classifier.next.shift();
        if (next instanceof Error) throw next;
        return next ?? classifier.reply;
      },
    },
    sessionManager: { getBranch: () => classifier.branch },
  };
  return { root, agent, handlers, commands, ui, ctx, classifier };
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

test("R43 persists only an exact command and does not widen it to argument variants", async () => {
  await withEnv({}, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const exact = "Bash(akasha --help)";
    ui.answers.push(`Yes, and don't ask again for ${exact} in this project`);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "akasha --help" } }, ctx), undefined);
    const file = join(agent, "permissions", keyFilename(realpathSync(root)));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions.allow, [exact]);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "akasha --help" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);
    ui.answers.push("Yes");
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "akasha --help x" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 2);
  });
});

test("R45 outside-project approval grants the target worktree for this session without persistence", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "acceptEdits" }, async () => {
    const { root, agent, handlers, ctx, ui } = setup();
    const targetRoot = join(root, "..", "target-repo");
    const targetDir = join(targetRoot, "extensions");
    mkdirSync(targetDir, { recursive: true });
    execFileSync("git", ["init", "-q", targetRoot]);
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { deny: [`Edit(${realpathSync(targetRoot)}/blocked.ts)`] } }));
    await handlers.get("session_start")!({}, ctx);

    const option = `Yes, and allow edits in ${realpathSync(targetRoot)} during this session`;
    ui.answers.push(option);
    assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: join(targetDir, "one.ts") } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);
    assert.deepEqual(ui.selectCalls[0].options, ["Yes", option, "No, and tell pi what to do differently"]);
    assert.equal(existsSync(join(agent, "permissions")), false);
    assert.equal(await handlers.get("tool_call")!({ toolName: "edit", input: { path: join(targetDir, "two.ts") } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);

    const denied = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(targetRoot, "blocked.ts") } }, ctx);
    assert.notEqual(denied, undefined);
    assert.equal(ui.selectCalls.length, 1);
  });
});

test("R45 unattended outside-project edits remain blocked without offering a grant", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "acceptEdits", NAKAMA_AGENT: "worker" }, async () => {
    const { root, handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(root, "..", "outside.ts") } }, ctx) as { block?: boolean };
    assert.equal(result.block, true);
    assert.equal(ui.selectCalls.length, 0);
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
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { deny: ["Bash(git push origin main)"] } }));
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes, and don't ask again for Bash(git push:*) in this project");
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx), undefined);
    const denied = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx);
    assert.deepEqual(denied, {
      block: true,
      reason: "permission: `git push origin main` is denied (Bash(git push origin main)). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
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
    assert.match(ui.notifications.at(-1)!.message, /part git push → ask \(no allow rule\)/i);
    await command!("mode plan", ctx);
    assert.match(ui.notifications.at(-1)!.message, /plan/i);
    await command!("mode invalid", ctx);
    assert.equal(ui.notifications.at(-1)!.level, "error");
    assert.match(ui.notifications.at(-1)!.message, /default, acceptEdits, auto, plan/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  });
});

test("unattended job_run asks are blocked with the exact bash reason", async () => {
  await withEnv({ NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("tool_call")!({ toolName: "job_run", input: { command: "git merge origin/develop" } }, ctx);
    assert.deepEqual(result, {
      block: true,
      reason: "permission: `git merge origin/develop` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(ui.selectCalls.length, 0);
  });
});

test("the permissions command accepts the auto mode", async () => {
  await withEnv({}, async () => {
    const { handlers, commands, ctx, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    await commands.get("permissions")!("mode auto", ctx);
    assert.equal(ui.notifications.at(-1)!.message, "Permission mode set to auto for this session.");
    await commands.get("permissions")!("", ctx);
    assert.match(ui.notifications.at(-1)!.message, /Mode: auto \(origin: session\)/);
  });
});

test("auto mode allows what the classifier allows and blocks what it blocks", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, classifier, ui } = setup();
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    assert.equal(classifier.calls.length, 1);
    assert.equal(ui.selectCalls.length, 0);

    classifier.next.push(classifier.block("pushes to the default branch"));
    assert.deepEqual(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx), {
      block: true,
      reason: "permission: `git push origin main` was blocked by auto-mode classifier (pushes to the default branch). It was not run. Use a different approach, or report that this step needs the orchestrator.",
    });
  });
});

test("auto mode never reaches the classifier for allow, read-only, in-project edit or deny decisions", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto" }, async () => {
    const { root, agent, handlers, ctx, classifier } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { allow: ["Bash(git push:*)"], deny: ["Bash(git push origin main)"] } }));
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
    assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: join(root, "src", "one.ts") } }, ctx), undefined);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin scratch" } }, ctx), undefined);
    const denied = await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin main" } }, ctx) as { block?: boolean };
    assert.equal(denied.block, true);
    assert.equal(classifier.calls.length, 0);
  });
});

test("auto mode sends only user text and tool calls to the classifier", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, classifier } = setup();
    classifier.branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "please run the tests" }] } },
      { type: "message", message: { role: "assistant", content: [
        { type: "text", text: "assistant prose that must not reach the classifier" },
        { type: "thinking", thinking: "private thinking" },
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
      ] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output that must not reach the classifier" }] } },
      { type: "custom", data: "ignored entry" },
    ];
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    const text = classifier.calls[0].messages[0].content[0].text;
    assert.match(text, /please run the tests/);
    assert.match(text, /Tool: bash\nArguments: \{"command":"ls"\}/);
    assert.match(text, /PENDING TOOL CALL[\s\S]*\{"command":"npm test"\}/);
    assert.doesNotMatch(text, /assistant prose|private thinking|tool output|ignored entry/);
    assert.match(text, /only the user's messages and the agent's earlier tool calls/);
  });
});

test("classifier failures fall back to the normal prompt when attended and the normal block when unattended", async () => {
  const failures: (FakeReply | Error | null)[] = [
    new Error("provider exploded"),
    { stopReason: "error", content: [] },
    { stopReason: "aborted", content: [] },
    { stopReason: "stop", content: [{ type: "text", text: "I think this is fine" }] },
    { stopReason: "stop", content: [] },
  ];
  for (const failure of failures) {
    await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
      const { handlers, ctx, classifier, ui } = setup();
      classifier.next.push(failure);
      await handlers.get("session_start")!({}, ctx);
      assert.deepEqual(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx), {
        block: true,
        reason: "permission: `git push` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
      });
      assert.equal(ui.selectCalls.length, 0);
    });
  }
  await withEnv({ PI_PERMISSIONS_MODE: "auto" }, async () => {
    const { handlers, ctx, classifier, ui } = setup();
    classifier.next.push(new Error("provider exploded"));
    await handlers.get("session_start")!({}, ctx);
    ui.answers.push("Yes");
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 1);
  });
});

test("auto mode stops calling the classifier after three consecutive blocks and an allow resets the count", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, classifier } = setup();
    await handlers.get("session_start")!({}, ctx);
    const call = (command: string) => handlers.get("tool_call")!({ toolName: "bash", input: { command } }, ctx);
    classifier.next.push(classifier.block("no"), classifier.block("no"), null);
    assert.notEqual(await call("npm test"), undefined);
    assert.notEqual(await call("npm run build"), undefined);
    assert.equal(await call("npm run serve"), undefined);
    classifier.next.push(classifier.block("no"), classifier.block("no"));
    assert.notEqual(await call("npm run lint"), undefined);
    assert.notEqual(await call("npm run format"), undefined);
    assert.equal(classifier.calls.length, 5);
    classifier.next.push(classifier.block("no"));
    assert.deepEqual(await call("npm run clean"), {
      block: true,
      reason: "permission: `npm run clean` was blocked by auto-mode classifier (no). It was not run. Use a different approach, or report that this step needs the orchestrator.",
    });
    assert.equal(classifier.calls.length, 6);
    assert.deepEqual(await call("npm run deploy"), {
      block: true,
      reason: "permission: auto mode stopped calling the classifier after repeated blocks; `npm run deploy` was not run. Stop and report to the orchestrator; do not try another route.",
    });
    assert.equal(classifier.calls.length, 6);
  });
});

test("auto mode stops calling the classifier after twenty total blocks", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, classifier } = setup();
    await handlers.get("session_start")!({}, ctx);
    const call = () => handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx);
    for (let index = 0; index < 19; index++) {
      classifier.next.push(classifier.block("no"));
      assert.notEqual(await call(), undefined);
      classifier.next.push(null);
      assert.equal(await call(), undefined);
    }
    classifier.next.push(classifier.block("no"));
    assert.notEqual(await call(), undefined);
    assert.equal(classifier.calls.length, 39);
    assert.deepEqual(await call(), {
      block: true,
      reason: "permission: auto mode stopped calling the classifier after repeated blocks; `npm test` was not run. Stop and report to the orchestrator; do not try another route.",
    });
    assert.equal(classifier.calls.length, 39);
  });
});

test("autoClassifierModel picks the classifier model and defaults to the session model", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { agent, handlers, ctx, classifier } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ autoClassifierModel: "p/m" }));
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    assert.deepEqual(classifier.found, ["p/m"]);
    assert.deepEqual(classifier.calls[0].model, { provider: "p", id: "m" });
  });
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { handlers, ctx, classifier } = setup();
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    assert.deepEqual(classifier.found, []);
    assert.deepEqual(classifier.calls[0].model, { provider: "session", id: "session-model" });
  });
  await withEnv({ PI_PERMISSIONS_MODE: "auto", NAKAMA_AGENT: "worker" }, async () => {
    const { agent, handlers, ctx, classifier } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ autoClassifierModel: "missing/model" }));
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push" } }, ctx), {
      block: true,
      reason: "permission: `git push` needs approval (no allow rule). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.",
    });
    assert.equal(classifier.calls.length, 0);
  });
});

test("the permissions report lists the rules auto mode ignores", async () => {
  await withEnv({ PI_PERMISSIONS_MODE: "auto" }, async () => {
    const { agent, handlers, commands, ctx, ui } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { allow: ["Bash(node --test:*)", "Bash(npm test)"] } }));
    await handlers.get("session_start")!({}, ctx);
    await commands.get("permissions")!("", ctx);
    const report = ui.notifications.at(-1)!.message;
    assert.match(report, /Ignored in auto mode: Bash\(node --test:\*\)/);
    assert.doesNotMatch(report, /Ignored in auto mode:.*Bash\(npm test\)/);
    assert.match(report, /Auto classifier: session model/);
    assert.match(report, /Auto classifier blocks: 0 consecutive, 0 total/);
  });
});

test("job_run follows the agent allow rules like bash", async () => {
  await withEnv({}, async () => {
    const { agent, handlers, ctx, ui } = setup();
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "permissions.json"), JSON.stringify({ permissions: { allow: ["Bash(./gradlew *)"] } }));
    await handlers.get("session_start")!({}, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "job_run", input: { command: "./gradlew :x:test" } }, ctx), undefined);
    assert.equal(ui.selectCalls.length, 0);
  });
});
