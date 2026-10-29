import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addGrant, loadConfig, type Mode } from "./config.ts";
import { describe, explain, type PermissionState } from "./describe.ts";
import { decide, isUnattended, resolveMode, toBlock, type Call, type Decision, type Env } from "./decide.ts";
import { agentDir, keyFilename, resolveProject, type Git } from "./project.ts";
import { ask, type Ui } from "./prompt.ts";
import { parseRule } from "./rules.ts";

type Context = {
  cwd: string;
  hasUI: boolean;
  ui: Ui & { notify(message: string, level: "info" | "warning" | "error"): void };
};
type ToolInput = { command?: unknown; path?: unknown };
type ToolEvent = { toolName: string; input?: ToolInput };

const git: Git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

function createState(ctx: Context, processEnv: NodeJS.ProcessEnv): PermissionState {
  const project = resolveProject(ctx.cwd, git);
  const directory = agentDir(processEnv);
  const projectFile = join(directory, "permissions", keyFilename(project.key));
  const config = loadConfig({
    global: join(directory, "permissions.json"),
    project: projectFile,
    repo: join(project.root, ".pi", "permissions.json"),
  });
  return { project, config, cwd: ctx.cwd, projectFile, session: [], processEnv, hasUI: ctx.hasUI };
}

function currentEnv(state: PermissionState, cwd: string): Env {
  const { mode } = resolveMode(state.processEnv, state.config, state.sessionMode);
  return { root: state.project.root, cwd, mode, config: state.config, session: state.session };
}

function notifyStartup(state: PermissionState, ctx: Context): void {
  for (const source of state.config.sources) {
    if (source.error) ctx.ui.notify(source.error, "error");
  }
  for (const entry of state.config.ignored) ctx.ui.notify(entry, "warning");
  const { warning } = resolveMode(state.processEnv, state.config, state.sessionMode);
  if (warning) ctx.ui.notify(warning, "warning");
}

function failClosed(error: unknown): { block: true; reason: string } {
  return { block: true, reason: `permission check failed: ${error instanceof Error ? error.message : String(error)}` };
}

function syntheticDecision(verdict: "ask" | "deny", label: string, rule: string): Decision {
  return {
    verdict,
    flags: [{ label, rule, suggestion: null }],
    reason: `permission: \`${label}\` ${verdict === "deny" ? "is denied" : "needs approval"} (${rule}). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.`,
  };
}

export default function (pi: ExtensionAPI): void {
  const processEnv = process.env;
  let state: PermissionState | undefined;

  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as Context;
    state = createState(ctx, processEnv);
    notifyStartup(state, ctx);
  });

  pi.on("tool_call", async (rawEvent, rawCtx) => {
    try {
      const event = rawEvent as ToolEvent;
      const ctx = rawCtx as Context;
      state ??= createState(ctx, processEnv);
      state.cwd = ctx.cwd;
      state.hasUI = ctx.hasUI;
      const input = event.input ?? {};
      const command = typeof input.command === "string" ? input.command : undefined;
      const toolPath = typeof input.path === "string" ? input.path : undefined;
      let call: Call = {
        tool: event.toolName,
        ...(command === undefined ? {} : { command }),
        ...(toolPath === undefined ? {} : { path: toolPath }),
      };
      const env = currentEnv(state, ctx.cwd);
      let decision: Decision;

      if (event.toolName === "powershell") {
        const deny = state.config.deny.find((rule) => rule.tool === "powershell" && rule.pattern === undefined);
        if (deny) decision = syntheticDecision("deny", command ?? "powershell", deny.text);
        else {
          const plan = env.mode === "plan";
          decision = syntheticDecision(plan ? "deny" : "ask", command ?? "powershell", "unparsed: powershell");
        }
      } else {
        if (toolPath === undefined && ["grep", "find", "ls"].includes(event.toolName)) call = { ...call, path: ctx.cwd };
        decision = decide(call, env);
      }

      if (decision.verdict === "allow") return undefined;
      if (decision.verdict === "deny" || isUnattended(state.config.unattended, ctx.hasUI, processEnv)) return toBlock(decision);

      const outcome = await ask(ctx.ui, call, decision, env.mode, state.config.askTimeoutSec);
      if (!outcome.allow) return { block: true, reason: outcome.reason };
      if (outcome.grant) {
        try {
          addGrant(state.projectFile, outcome.grant);
        } catch (error) {
          ctx.ui.notify(`Unable to save permission grant: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        for (const text of outcome.grant) {
          const rule = parseRule(text);
          if (rule && !state.session.some((existing) => existing.text === rule.text)) state.session.push(rule);
        }
      }
      if (outcome.switchMode) state.sessionMode = outcome.switchMode;
      return undefined;
    } catch (error) {
      return failClosed(error);
    }
  });

  pi.registerCommand("permissions", {
    description: "Show and test pi permission rules, or set the session mode.",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as Context;
      try {
        state ??= createState(ctx, processEnv);
        state.cwd = ctx.cwd;
        state.hasUI = ctx.hasUI;
        const input = args.trim();
        if (!input) {
          ctx.ui.notify(describe(state), "info");
          return;
        }
        if (input.startsWith("test ")) {
          const command = input.slice(5).trim();
          ctx.ui.notify(explain(command, currentEnv(state, ctx.cwd)), "info");
          return;
        }
        const modeMatch = /^mode\s+(\S+)$/i.exec(input);
        if (modeMatch) {
          const mode = modeMatch[1] as Mode;
          if (["default", "acceptEdits", "plan"].includes(mode)) {
            state.sessionMode = mode;
            ctx.ui.notify(`Permission mode set to ${mode} for this session.`, "info");
          } else {
            ctx.ui.notify(`Invalid mode "${mode}". Valid modes: default, acceptEdits, plan.`, "error");
          }
          return;
        }
        ctx.ui.notify("Usage: /permissions [test <command> | mode <default|acceptEdits|plan>]", "info");
      } catch (error) {
        ctx.ui.notify(`Permission command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
