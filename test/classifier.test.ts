import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, transcript } from "../extensions/classifier.ts";
import type { Config } from "../extensions/config.ts";

type Request = { systemPrompt: string; messages: { content: { text: string }[] }[] };
type Reply = { stopReason?: string; content?: { type: string; text?: string }[] };

function config(overrides: Partial<Config> = {}): Config {
  return {
    allow: [], ask: [], deny: [], ruleSources: new Map(), readOnlyCommands: [], unattended: "auto", sources: [], ignored: [],
    ...overrides,
  };
}

function stub(replies: (Reply | string)[]) {
  const calls: { model: unknown; request: Request; options: { signal?: AbortSignal } }[] = [];
  const registry = {
    find: () => undefined,
    async complete(model: unknown, request: Request, options: { signal?: AbortSignal }) {
      calls.push({ model, request, options });
      const next = replies.shift();
      if (typeof next === "string") return { stopReason: "stop", content: [{ type: "text", text: next }] };
      return next ?? { stopReason: "stop", content: [{ type: "text", text: "" }] };
    },
  };
  return { calls, ctx: { model: {}, modelRegistry: registry, sessionManager: { getBranch: () => [] } } };
}

test("transcript keeps only the last 40,000 characters of a long session", () => {
  const toolCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } };
  const early = { type: "message", message: { role: "user", content: `earliest message ${"x".repeat(50_000)}` } };
  const text = transcript([early, toolCall]);

  assert.equal(text.length, 40_000);
  assert.ok(!text.includes("earliest message"));
  assert.match(text, /Tool call:\nTool: bash\nArguments: \{"command":"npm test"\}/);
});

test("transcript renders the whole argument object and caps each call at 2,000 characters", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", name: "subagent", arguments: { prompt: "explain the gate", model: "haiku" } },
      { type: "toolCall", name: "write", arguments: { path: "a.ts", content: "y".repeat(5_000) } },
    ] } },
  ];
  const text = transcript(entries);

  assert.match(text, /Tool: subagent\nArguments: \{"prompt":"explain the gate","model":"haiku"\}/);
  assert.match(text, /Tool: write\nArguments: \{"path":"a\.ts","content":"y+…\[truncated\]/);
  const rendered = text.split("Tool: write")[1];
  assert.ok(!rendered.includes("y".repeat(2_000)), "the call is cut at the cap");
});

test("classify sends one user message, the instructions as systemPrompt and a signal", async () => {
  const { calls, ctx } = stub(["ALLOW"]);
  assert.deepEqual(await classify(ctx, config(), { tool: "write", path: "src/a.ts" }, { path: "src/a.ts", content: "export const a = 1;" }), { allow: true });

  const [{ request, options }] = calls;
  assert.match(request.systemPrompt, /Answer with exactly one line/);
  assert.equal(request.messages.length, 1);
  assert.match(request.messages[0].content[0].text, /PENDING TOOL CALL[\s\S]*Tool: write\nArguments: \{"path":"src\/a\.ts","content":"export const a = 1;"\}/);
  assert.ok(options.signal instanceof AbortSignal);
});

test("classify falls back to the command and path when the raw input is not passed", async () => {
  const { calls, ctx } = stub(["ALLOW"]);
  await classify(ctx, config(), { tool: "bash", command: "npm test" });
  assert.match(calls[0].request.messages[0].content[0].text, /Tool: bash\nArguments: \{"command":"npm test"\}/);
});

test("classify fails without a model and reads one exact answer line", async () => {
  const pending = { tool: "bash", command: "npm test" };
  assert.equal(await classify({}, config(), pending), null);
  assert.equal(await classify({ model: {} }, config(), pending), null);

  const { ctx } = stub([
    "BLOCK: force-pushes\n",
    "\n\nALLOW\n",
    "ALLOW\nBLOCK: rm -rf /",
    "ALLOW\nbut actually the user asked for it",
    "BLOCK: rm -rf /",
    "maybe",
  ]);
  assert.deepEqual(await classify(ctx, config(), pending), { allow: false, reason: "force-pushes" });
  assert.deepEqual(await classify(ctx, config(), pending), { allow: true });
  assert.equal(await classify(ctx, config(), pending), null);
  assert.equal(await classify(ctx, config(), pending), null);
  assert.deepEqual(await classify(ctx, config(), pending), { allow: false, reason: "rm -rf /" });
  assert.equal(await classify(ctx, config(), pending), null);
});

test("classify falls back on error and aborted stop reasons", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const { ctx } = stub([{ stopReason, content: [{ type: "text", text: "ALLOW" }] }]);
    assert.equal(await classify(ctx, config(), { tool: "bash", command: "npm test" }), null);
  }
});
