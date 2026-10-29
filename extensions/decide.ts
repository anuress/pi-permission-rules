import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Mode } from "./config.ts";
import { isReadOnly, CODE_RUNNERS } from "./readonly.ts";
import { matchBash, matchPath, type Rule, toolFamily } from "./rules.ts";
import { parse, type Part } from "./shell.ts";

export type Call = { tool: string; command?: string; path?: string };
export type Env = { root: string; cwd: string; mode: Mode; config: Config; session: Rule[] };
export type Flag = { label: string; rule: string; suggestion: string | null };
export type DecisionItem = {
  kind: "part" | "redirect" | "path" | "tool";
  label: string;
  verdict: "allow" | "ask" | "deny";
  rule: string;
};
export type Decision = { verdict: "allow" | "ask" | "deny"; flags: Flag[]; reason: string; items: DecisionItem[] };

type Verdict = Decision["verdict"];
type Evaluation = { verdict: Verdict; flag?: Flag; item: DecisionItem };

const MODES: readonly Mode[] = ["default", "acceptEdits", "plan"];
const DANGEROUS_ASSIGNMENT = /^(?:LD_.*|DYLD_.*|GIT_.*|SSH_.*|PATH|PAGER|.*_PAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHON.*|PERL5.*|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|.*_OPTS|PROMPT_COMMAND|IFS|SHELLOPTS|BASHOPTS)$/;

function physical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(physical(parent), basename(absolute));
}

function inside(path: string, root: string): boolean {
  return root === "/" ? path.startsWith("/") : path === root || path.startsWith(`${root}/`);
}

function normalizeToolPath(path: string, cwd: string): { path: string; outside: boolean } {
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("~")) return { path: resolve("/", normalized), outside: true };
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return { path: isAbsolute(normalized) ? normalized : resolve(cwd, normalized), outside: false };
}

function partRule(rules: readonly Rule[], part: Part): Rule | undefined {
  return rules.find((rule) => matchBash(rule, part));
}

function pathRule(rules: readonly Rule[], family: "Read" | "Edit", path: string, root: string): Rule | undefined {
  return rules.find((rule) => rule.tool === family && matchPath(rule, path, root));
}

function customRule(rules: readonly Rule[], tool: string): Rule | undefined {
  return rules.find((rule) => rule.tool === tool && rule.pattern === undefined);
}

function flag(label: string, rule: string, suggestion: string | null = null): Flag {
  return { label, rule, suggestion };
}

function decision(verdict: Verdict, flags: Flag[] = [], reasonFlag = flags[0], items: DecisionItem[] = []): Decision {
  const reason = reasonFlag && verdict !== "allow"
    ? `permission: \`${reasonFlag.label}\` ${verdict === "deny" ? "is denied" : "needs approval"} (${reasonFlag.rule}). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.`
    : "";
  return { verdict, flags, reason, items };
}

function evaluated(kind: DecisionItem["kind"], label: string, verdict: Verdict, rule: string, suggestion: string | null = null): Evaluation {
  return {
    verdict,
    ...(verdict === "allow" ? {} : { flag: flag(label, rule, suggestion) }),
    item: { kind, label, verdict, rule: verdict === "allow" ? `allowed: ${rule}` : rule },
  };
}

function choose(evaluations: Evaluation[]): Decision {
  const flags = evaluations.flatMap((evaluation) => evaluation.flag ? [evaluation.flag] : []);
  const verdict = evaluations.reduce<Verdict>((worst, evaluation) =>
    evaluation.verdict === "deny" || (evaluation.verdict === "ask" && worst === "allow")
      ? evaluation.verdict
      : worst, "allow");
  const reasonFlag = evaluations.find((evaluation) => evaluation.verdict === verdict)?.flag ?? flags[0];
  return decision(verdict, flags, reasonFlag, evaluations.map((evaluation) => evaluation.item));
}

function evaluatePath(path: string, family: "Read" | "Edit", env: Env, outside = false, kind: "path" | "redirect" = "path"): Evaluation {
  const absolute = physical(resolve(env.cwd, path));
  const root = physical(env.root);
  const deny = pathRule(env.config.deny, family, absolute, root);
  if (deny) return evaluated(kind, absolute, "deny", deny.text);

  if (family === "Edit" && env.mode === "plan") return evaluated(kind, absolute, "deny", "plan mode");
  const ask = pathRule(env.config.ask, family, absolute, root);
  if (ask) return evaluated(kind, absolute, "ask", ask.text);
  if (family === "Read") return evaluated(kind, absolute, "allow", "read tool");

  const allow = pathRule(env.config.allow, family, absolute, root);
  if (allow) return evaluated(kind, absolute, "allow", `allow rule ${allow.text}`);
  const session = pathRule(env.session, family, absolute, root);
  if (session) return evaluated(kind, absolute, "allow", `session rule ${session.text}`);
  if (env.mode === "acceptEdits" && !outside && inside(absolute, root)) {
    return evaluated(kind, absolute, "allow", "inside project root");
  }
  return evaluated(kind, absolute, "ask", "no allow rule");
}

function dangerousAssignment(part: Part): string | undefined {
  for (const assignment of part.assignments) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (DANGEROUS_ASSIGNMENT.test(name)) return name;
  }
  return undefined;
}

function evaluatePart(part: Part, env: Env): Evaluation {
  if (part.argv.length === 0) return evaluated("part", part.text, "allow", "empty command part");
  if (env.mode === "plan" && !isReadOnly(part, env.config.readOnlyCommands)) {
    return evaluated("part", part.text, "deny", "plan mode");
  }
  const deny = partRule(env.config.deny, part);
  if (deny) return evaluated("part", part.text, "deny", deny.text);
  const ask = partRule(env.config.ask, part);
  if (ask) return evaluated("part", part.text, "ask", ask.text);

  const unsafeAssignment = dangerousAssignment(part);
  if (unsafeAssignment) return evaluated("part", part.text, "ask", `dangerous env ${unsafeAssignment}`);
  const allow = partRule(env.config.allow, part);
  if (allow) return evaluated("part", part.text, "allow", `allow rule ${allow.text}`);
  const session = partRule(env.session, part);
  if (session) return evaluated("part", part.text, "allow", `session rule ${session.text}`);
  if (isReadOnly(part, env.config.readOnlyCommands)) return evaluated("part", part.text, "allow", "read-only");
  return evaluated("part", part.text, "ask", "no allow rule", suggestRule(part));
}

function homePath(path: string): string | null {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("~") ? null : path;
}

function redirectPath(target: string, dir: string | null): { path: string; outside: boolean } {
  if (target.includes("$")) return { path: resolve("/", target), outside: true };
  const expanded = homePath(target);
  if (expanded === null) return { path: resolve("/", target), outside: true };
  if (isAbsolute(expanded)) return { path: physical(expanded), outside: false };
  return dir === null
    ? { path: resolve("/", target), outside: true }
    : { path: physical(resolve(dir, target)), outside: false };
}

function cdDirectory(part: Part, dir: string | null): string | null {
  if (basename(part.argv[0] ?? "") !== "cd") return dir;
  const args = part.argv.slice(1);
  if (args.length !== 1 || args[0] === "-" || args[0].includes("$")) return null;
  const target = homePath(args[0]);
  if (target === null || (dir === null && !isAbsolute(target))) return null;
  return physical(resolve(dir ?? "/", target));
}

function evaluateBash(call: Call, env: Env): Decision {
  const command = call.command ?? "";
  const parsed = parse(command);
  if (parsed.parts.length === 0 && parsed.unsafe === undefined) {
    const empty = evaluated("tool", command, "ask", "unparsed: empty command");
    return decision("ask", [empty.flag!], empty.flag, [empty.item]);
  }

  const dirs = new Map<string, string | null>([["", physical(env.cwd)]]);
  const dirFor = (scope: string): string | null => {
    if (dirs.has(scope)) return dirs.get(scope) ?? null;
    const parentEnd = scope.lastIndexOf("/");
    const parent = parentEnd < 0 ? "" : scope.slice(0, parentEnd);
    const inherited = dirFor(parent);
    dirs.set(scope, inherited);
    return inherited;
  };
  const evaluations: Evaluation[] = [];
  for (const part of parsed.parts) {
    const dir = dirFor(part.scope);
    evaluations.push(evaluatePart(part, env));
    for (const target of part.redirects) {
      const targetPath = redirectPath(target, dir);
      evaluations.push(evaluatePath(targetPath.path, "Edit", { ...env, cwd: "/" }, targetPath.outside, "redirect"));
    }
    if (basename(part.argv[0] ?? "") === "cd") dirs.set(part.scope, cdDirectory(part, dir));
  }

  const unsafe = parsed.unsafe === undefined ? undefined
    : evaluated("tool", command, env.mode === "plan" ? "deny" : "ask", env.mode === "plan" ? "plan mode" : `unparsed: ${parsed.unsafe}`);
  if (evaluations.some((result) => result.verdict === "deny")) {
    const chosen = choose(evaluations);
    return unsafe ? { ...chosen, items: [...chosen.items, unsafe.item] } : chosen;
  }
  if (unsafe) return decision(unsafe.verdict, [unsafe.flag!], unsafe.flag, [...evaluations.map((evaluation) => evaluation.item), unsafe.item]);
  return choose(evaluations);
}

export function decide(call: Call, env: Env): Decision {
  const family = toolFamily(call.tool);
  if (family === "Bash") return evaluateBash(call, env);
  if (family === "Read" || family === "Edit") {
    const path = call.path ?? (family === "Read" && ["grep", "find", "ls"].includes(call.tool) ? env.cwd : "");
    if (!path) {
      const evaluation = evaluated("path", call.tool, family === "Read" ? "allow" : "ask", family === "Read" ? "read tool" : "no allow rule");
      return choose([evaluation]);
    }
    const normalized = normalizeToolPath(path, env.cwd);
    return choose([evaluatePath(normalized.path, family, env, normalized.outside)]);
  }

  const deny = customRule(env.config.deny, call.tool);
  if (deny) return choose([evaluated("tool", call.tool, "deny", deny.text)]);
  const ask = customRule(env.config.ask, call.tool);
  if (ask) return choose([evaluated("tool", call.tool, "ask", ask.text)]);
  return choose([evaluated("tool", call.tool, "allow", "custom tool")]);
}

export function suggestRule(part: Part): string | null {
  if (!part.argv.length || part.assignments.length > 0) return null;
  const first = part.argv[0];
  const command = basename(first);
  if (CODE_RUNNERS.has(command)) return null;
  const second = part.argv[1];
  if (second && !second.startsWith("-") && !second.startsWith(":") && !/[\/=\'\"]/.test(second)
    && second !== "." && second !== ".." && !second.startsWith("~")) {
    return `Bash(${first} ${second}:*)`;
  }
  return `Bash(${first}:*)`;
}

export function resolveMode(env: NodeJS.ProcessEnv, config: Config, session?: Mode): { mode: Mode; warning?: string } {
  if (session) return { mode: session };
  const requested = env.PI_PERMISSIONS_MODE;
  if (requested !== undefined) {
    if (MODES.includes(requested as Mode)) return { mode: requested as Mode };
    return config.defaultMode
      ? { mode: config.defaultMode, warning: `Invalid PI_PERMISSIONS_MODE value "${requested}"; ignoring it.` }
      : { mode: "acceptEdits", warning: `Invalid PI_PERMISSIONS_MODE value "${requested}"; ignoring it.` };
  }
  return { mode: config.defaultMode ?? "acceptEdits" };
}

export function isUnattended(setting: "auto" | boolean, hasUI: boolean, env: NodeJS.ProcessEnv): boolean {
  if (!hasUI || setting === true) return true;
  if (setting === false) return false;
  return env.PI_PERMISSIONS_UNATTENDED === "1" || env.NAKAMA_AGENT !== undefined;
}

export function toBlock(d: Decision): { block: true; reason: string } {
  return { block: true, reason: d.reason };
}
