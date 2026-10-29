import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { keyFilename } from "./project.ts";
import { decide, isUnattended, resolveMode, type Env } from "./decide.ts";
import type { Config, Mode } from "./config.ts";
import type { Project } from "./project.ts";
import type { Rule } from "./rules.ts";
import { parse } from "./shell.ts";

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

function cdDirectory(part: { argv: string[] }, dir: string | null): string | null {
  if (basename(part.argv[0] ?? "") !== "cd") return dir;
  const args = part.argv.slice(1);
  if (args.length !== 1 || args[0] === "-" || args[0].includes("$")) return null;
  const target = args[0] === "~" ? homedir()
    : args[0].startsWith("~/") ? resolve(homedir(), args[0].slice(2))
      : args[0].startsWith("~") ? null : args[0];
  if (target === null || (dir === null && !isAbsolute(target))) return null;
  return resolve(dir ?? "/", target);
}

function scopeDirectory(scope: string, directories: Map<string, string | null>): string | null {
  if (directories.has(scope)) return directories.get(scope) ?? null;
  const parentEnd = scope.lastIndexOf("/");
  const parent = parentEnd < 0 ? "" : scope.slice(0, parentEnd);
  const dir = scopeDirectory(parent, directories);
  directories.set(scope, dir);
  return dir;
}

export function explain(command: string, env: Env): string {
  const parsed = parse(command);
  const rows: string[] = [];
  const overall = decide({ tool: "bash", command }, env);
  const directories = new Map<string, string | null>([["", env.cwd]]);

  for (const part of parsed.parts) {
    const dir = scopeDirectory(part.scope, directories);
    const localEnv = { ...env, cwd: dir ?? "/" };
    if (part.text) {
      const decision = decide({ tool: "bash", command: part.text }, localEnv);
      rows.push(`${part.text} → ${decision.verdict} (${decision.flags[0]?.rule ?? "allowed"})`);
    }
    for (const target of part.redirects) {
      const decision = decide({ tool: "write", path: target }, localEnv);
      rows.push(`redirect ${target} → ${decision.verdict} (${decision.flags[0]?.rule ?? "allowed"})`);
    }
    directories.set(part.scope, cdDirectory(part, dir));
  }

  if (parsed.unsafe !== undefined) rows.push(`unsafe parse: ${parsed.unsafe} (${overall.verdict})`);
  if (rows.length === 0) rows.push(`${command || "<empty>"} → ${overall.verdict} (${overall.flags[0]?.rule ?? "allowed"})`);
  rows.push(`Overall: ${overall.verdict}`);
  return rows.join("\n");
}
