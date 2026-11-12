import { keyFilename } from "./project.ts";
import { breakerTripped } from "./classifier.ts";
import { decide, droppedInAuto, isUnattended, resolveMode, type Env } from "./decide.ts";
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
  auto?: { consecutive: number; total: number };
};

function origin(state: PermissionState): string {
  if (state.sessionMode) return "session";
  const requested = state.processEnv.PI_PERMISSIONS_MODE;
  if (requested === "default" || requested === "acceptEdits" || requested === "auto" || requested === "plan") return "env PI_PERMISSIONS_MODE";
  if (state.config.defaultMode) return "config";
  return "default";
}

export function describe(state: PermissionState): string {
  const mode = resolveMode(state.processEnv, state.config, state.sessionMode);
  const auto = state.auto ?? { consecutive: 0, total: 0 };
  const dropped = [...state.config.allow, ...state.session].filter((rule) => droppedInAuto(rule, mode.mode));
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
      `  ${kind}: ${state.config[kind].map((rule) => `${rule.text} [${state.config.ruleSources.get(rule) ?? "unknown source"}]`).join(", ") || "none"}`,
    ),
    `Mode: ${mode.mode} (origin: ${origin(state)})`,
    `Auto classifier: ${state.config.autoClassifierModel ?? "session model"}`,
    `Auto classifier blocks: ${auto.consecutive} consecutive, ${auto.total} total${breakerTripped(auto) ? " (classifier stopped for this session)" : ""}`,
    ...(mode.mode === "auto" ? [`Ignored in auto mode: ${dropped.map((rule) => rule.text).join(", ") || "none"}`] : []),
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
