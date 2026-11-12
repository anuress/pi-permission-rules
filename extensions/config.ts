import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseRule, type Rule } from "./rules.ts";

export type Mode = "default" | "acceptEdits" | "auto" | "plan";
export type Config = {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
  ruleSources: Map<Rule, string>;
  defaultMode?: Mode;
  readOnlyCommands: string[];
  unattended: "auto" | boolean;
  askTimeoutSec?: number;
  autoClassifierModel?: string;
  sources: { path: string; loaded: boolean; error?: string }[];
  ignored: string[];
};

type JsonObject = Record<string, unknown>;
type LoadedSource = { path: string; loaded: boolean; error?: string; value?: JsonObject; nonObject?: boolean };
const MODES: Mode[] = ["default", "acceptEdits", "auto", "plan"];
const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

function readSource(path: string): LoadedSource {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, loaded: false };
    return { path, loaded: false, error: `Unable to read ${path}: ${(error as Error).message}` };
  }
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? { path, loaded: true, value } : { path, loaded: true, nonObject: true };
  } catch (error) {
    return { path, loaded: false, error: `Invalid JSON in ${path}: ${(error as Error).message}` };
  }
}

function addRules(
  permissions: JsonObject | undefined,
  field: "allow" | "ask" | "deny",
  path: string,
  ignored: string[],
  target: Rule[],
  ruleSources: Map<Rule, string>,
  repoFile: boolean,
): void {
  if (!permissions || !own(permissions, field)) return;
  if (repoFile && field === "allow") {
    ignored.push(`${path}: ${field} (repo file can only add ask/deny)`);
    return;
  }
  const entries = permissions[field];
  if (!Array.isArray(entries)) {
    ignored.push(`${path}: ${field} (expected an array of rules)`);
    return;
  }
  for (const entry of entries) {
    const rule = typeof entry === "string" ? parseRule(entry) : null;
    if (!rule) {
      ignored.push(`${path}: rule "${String(entry)}" (malformed)`);
    } else if (!target.some((existing) => existing.text === rule.text)) {
      target.push(rule);
      ruleSources.set(rule, path);
    }
  }
}

function addReadOnlyCommands(value: JsonObject, path: string, ignored: string[], target: string[]): void {
  if (!own(value, "readOnlyCommands")) return;
  const commands = value.readOnlyCommands;
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
    ignored.push(`${path}: readOnlyCommands (expected an array of strings)`);
    return;
  }
  for (const command of commands) if (!target.includes(command)) target.push(command);
}

export function loadConfig(paths: { global: string; project: string; repo: string }): Config {
  const loaded = [paths.global, paths.project, paths.repo].map(readSource);
  const ignored: string[] = [];
  const config: Config = {
    allow: [],
    ask: [],
    deny: [],
    ruleSources: new Map(),
    readOnlyCommands: [],
    unattended: "auto",
    sources: loaded.map(({ path, loaded: wasLoaded, error }) => ({ path, loaded: wasLoaded, ...(error === undefined ? {} : { error }) })),
    ignored,
  };

  loaded.forEach((source, index) => {
    const value = source.value;
    if (!source.loaded) return;
    if (!value) {
      if (source.nonObject) ignored.push(`${source.path}: file (not a JSON object)`);
      return;
    }
    const isRepo = index === 2;
    let permissions: JsonObject | undefined;
    if (own(value, "permissions")) {
      if (isObject(value.permissions)) permissions = value.permissions;
      else ignored.push(`${source.path}: permissions (expected an object)`);
    }

    addRules(permissions, "allow", source.path, ignored, config.allow, config.ruleSources, isRepo);
    addRules(permissions, "ask", source.path, ignored, config.ask, config.ruleSources, false);
    addRules(permissions, "deny", source.path, ignored, config.deny, config.ruleSources, false);

    if (permissions && own(permissions, "defaultMode")) {
      if (isRepo) {
        ignored.push(`${source.path}: defaultMode (repo file can only add ask/deny)`);
      } else if (typeof permissions.defaultMode === "string" && MODES.includes(permissions.defaultMode as Mode)) {
        config.defaultMode = permissions.defaultMode as Mode;
      } else {
        ignored.push(`${source.path}: defaultMode (invalid value)`);
      }
    }

    if (isRepo) {
      for (const field of ["readOnlyCommands", "unattended", "askTimeoutSec", "autoClassifierModel"] as const) {
        if (own(value, field)) ignored.push(`${source.path}: ${field} (repo file can only add ask/deny)`);
      }
      return;
    }

    addReadOnlyCommands(value, source.path, ignored, config.readOnlyCommands);
    if (own(value, "unattended")) {
      if (value.unattended === "auto" || typeof value.unattended === "boolean") config.unattended = value.unattended;
      else ignored.push(`${source.path}: unattended (invalid value)`);
    }
    if (own(value, "askTimeoutSec")) {
      if (typeof value.askTimeoutSec === "number" && Number.isFinite(value.askTimeoutSec) && value.askTimeoutSec > 0) {
        config.askTimeoutSec = value.askTimeoutSec;
      } else {
        ignored.push(`${source.path}: askTimeoutSec (invalid value)`);
      }
    }
    if (own(value, "autoClassifierModel")) {
      const model = value.autoClassifierModel;
      if (typeof model === "string" && /^[^\s/]+\/\S+$/.test(model)) config.autoClassifierModel = model;
      else ignored.push(`${source.path}: autoClassifierModel (invalid value, expected "provider/modelId")`);
    }
  });

  return config;
}

// `autoClassifierModel` is `provider/modelId`, split for `modelRegistry.find`.
export function classifierModel(config: Config): { provider: string; modelId: string } | undefined {
  if (config.autoClassifierModel === undefined) return undefined;
  const slash = config.autoClassifierModel.indexOf("/");
  return { provider: config.autoClassifierModel.slice(0, slash), modelId: config.autoClassifierModel.slice(slash + 1) };
}

export function addGrant(projectFile: string, rules: string[]): void {
  mkdirSync(dirname(projectFile), { recursive: true });
  let text: string;
  try {
    text = readFileSync(projectFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = "{}";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${projectFile}`);
  }
  if (!isObject(parsed)) throw new Error(`Invalid JSON object in ${projectFile}`);
  const permissions = own(parsed, "permissions") ? parsed.permissions : {};
  if (!isObject(permissions)) throw new Error(`Invalid permissions object in ${projectFile}`);
  const allow = own(permissions, "allow") ? permissions.allow : [];
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === "string")) {
    throw new Error(`Invalid permissions.allow array in ${projectFile}`);
  }

  for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
  permissions.allow = allow;
  parsed.permissions = permissions;

  const temporaryFile = `${projectFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(parsed, null, 2)}\n`);
    renameSync(temporaryFile, projectFile);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The rename may already have moved the temporary file.
    }
    throw error;
  }
}
