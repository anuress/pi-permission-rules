import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, transcript } from "../extensions/classifier.ts";
import type { Config } from "../extensions/config.ts";

function config(overrides: Partial<Config> = {}): Config {
  return {
    allow: [], ask: [], deny: [], ruleSources: new Map(), readOnlyCommands: [], unattended: "auto", sources: [], ignored: [],
    ...overrides,
  };
}

test("transcript keeps only the last 40,000 characters of a long session", () => {
  const toolCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } };
  const early = { type: "message", message: { role: "user", content: `earliest message ${"x".repeat(50_000)}` } };
  const text = transcript([early, toolCall]);

  assert.equal(text.length, 40_000);
  assert.ok(!text.includes("earliest message"));
  assert.match(text, /Tool call:\nTool: bash\nArguments: \{"command":"npm test"\}/);
});

test("classify fails without a model and parses the answer lines", async () => {
  const pending = { tool: "bash", command: "npm test" };
  assert.equal(await classify({}, config(), pending), null);
  assert.equal(await classify({ model: {} }, config(), pending), null);

  const replies = ["BLOCK: force-pushes\n", "\n\nALLOW\n", "maybe"];
  const registry = {
    find: () => undefined,
    complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: replies.shift() ?? "" }] }),
  };
  const ctx = { model: {}, modelRegistry: registry, sessionManager: { getBranch: () => [] } };
  assert.deepEqual(await classify(ctx, config(), pending), { allow: false, reason: "force-pushes" });
  assert.deepEqual(await classify(ctx, config(), pending), { allow: true });
  assert.equal(await classify(ctx, config(), pending), null);
});
