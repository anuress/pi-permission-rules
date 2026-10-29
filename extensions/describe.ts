import { keyFilename } from "./project.ts";
import { decide, isUnattended, resolveMode, type Env } from "./decide.ts";
import type { Config, Mode } from "./config.ts";
import type { Project } from "./project.ts";
import type { Rule } from "./rules.ts";

export type PermissionState = {
  project: Project;
  config: Config;
  cwd: string;
  projectFile: string;
  session: Rule[];
  sessionMode?: Mode;
  processEnv: NodeJS.ProcessEnv;
  hasUI: boolean;
};

function origin(state: PermissionState): string {
  if (state.sessionMode) return "session";
  const requested = state.processEnv.PI_PERMISSIONS_MODE;
  if (requested === "default" || requested === "acceptEdits" || requested === "plan") return "env PI_PERMISSIONS_MODE";
  if (state.config.defaultMode) return "config";
  return "default";
}

export function describe(state: PermissionState): string {
  const mode = resolveMode(state.processEnv, state.config, state.sessionMode);
  const sources = state.config.sources.map((source) =>
    `  ${source.path}: ${source.error ? `error: ${source.error}` : source.loaded ? "loaded" : "missing"}`,
  );
  const ignored = state.config.ignored.length
    ? state.config.ignored.map((entry) => `  ${entry}`).join("\n")
    : "  none";

  return [
    `Project root: ${state.project.root}`,
    `Repo key: ${state.project.key}`,
    `Project file: ${keyFilename(state.project.key)}`,
    "Config sources:",
    ...sources,
    "Ignored entries:",
    ignored,
    `Rules: allow ${state.config.allow.length}, ask ${state.config.ask.length}, deny ${state.config.deny.length}`,
    ...(["allow", "ask", "deny"] as const).map((kind) =>
      `  ${kind}: ${state.config[kind].map((rule) => rule.text).join(", ") || "none"}`,
    ),
    `Mode: ${mode.mode} (origin: ${origin(state)})`,
    `Unattended: ${isUnattended(state.config.unattended, state.hasUI, state.processEnv) ? "yes" : "no"}`,
    `Session grants: ${state.session.length}${state.session.length ? ` (${state.session.map((rule) => rule.text).join(", ")})` : ""}`,
  ].join("\n");
}

export function explain(command: string, env: Env): string {
  const decision = decide({ tool: "bash", command }, env);
  return [
    ...decision.items.map((item) => `${item.kind} ${item.label} → ${item.verdict} (${item.rule})`),
    `Overall: ${decision.verdict}`,
  ].join("\n");
}
