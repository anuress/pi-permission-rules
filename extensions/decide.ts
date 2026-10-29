import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Config, Mode } from "./config.ts";
import { isReadOnly, CODE_RUNNERS } from "./readonly.ts";
import { matchBash, matchPath, type Rule, toolFamily } from "./rules.ts";
import { parse, type Part } from "./shell.ts";

export type Call = { tool: string; command?: string; path?: string };
export type Env = { root: string; cwd: string; mode: Mode; config: Config; session: Rule[] };
export type Flag = { label: string; rule: string; suggestion: string | null };
export type Decision = { verdict: "allow" | "ask" | "deny"; flags: Flag[]; reason: string };

type Verdict = Decision["verdict"];
type Evaluation = { verdict: Verdict; flag?: Flag };

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

function decision(verdict: Verdict, flags: Flag[] = []): Decision {
  const first = flags[0];
  const reason = first && verdict !== "allow"
    ? `permission: \`${first.label}\` ${verdict === "deny" ? "is denied" : "needs approval"} (${first.rule}). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.`
    : "";
  return { verdict, flags, reason };
}

function choose(evaluations: Evaluation[]): Decision {
  const flags = evaluations.flatMap((evaluation) => evaluation.flag ? [evaluation.flag] : []);
  const verdict = evaluations.reduce<Verdict>((worst, evaluation) =>
    evaluation.verdict === "deny" || (evaluation.verdict === "ask" && worst === "allow")
      ? evaluation.verdict
      : worst, "allow");
  return decision(verdict, flags);
}

function evaluatePath(path: string, family: "Read" | "Edit", env: Env, outside = false): Evaluation {
  const absolute = physical(resolve(env.cwd, path));
  const root = physical(env.root);
  const label = absolute;
  const deny = pathRule(env.config.deny, family, absolute, root);
  if (deny) return { verdict: "deny", flag: flag(label, deny.text) };

  if (family === "Edit" && env.mode === "plan") return { verdict: "deny", flag: flag(label, "plan mode") };
  const ask = pathRule(env.config.ask, family, absolute, root);
  if (ask) return { verdict: "ask", flag: flag(label, ask.text) };
  if (family === "Read") return { verdict: "allow" };

  const allow = pathRule([...env.config.allow, ...env.session], family, absolute, root);
  if (allow) return { verdict: "allow" };
  if (env.mode === "acceptEdits" && !outside && inside(absolute, root)) return { verdict: "allow" };
  return { verdict: "ask", flag: flag(label, "no allow rule") };
}

function dangerousAssignment(part: Part): string | undefined {
  for (const assignment of part.assignments) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (DANGEROUS_ASSIGNMENT.test(name)) return name;
  }
  return undefined;
}

function evaluatePart(part: Part, env: Env): Evaluation {
  if (part.argv.length === 0) return { verdict: "allow" };
  if (env.mode === "plan" && !isReadOnly(part, env.config.readOnlyCommands)) {
    return { verdict: "deny", flag: flag(part.text, "plan mode") };
  }
  const deny = partRule(env.config.deny, part);
  if (deny) return { verdict: "deny", flag: flag(part.text, deny.text) };
  const ask = partRule(env.config.ask, part);
  if (ask) return { verdict: "ask", flag: flag(part.text, ask.text) };

  const unsafeAssignment = dangerousAssignment(part);
  if (unsafeAssignment) return { verdict: "ask", flag: flag(part.text, `dangerous env ${unsafeAssignment}`) };
  if (partRule([...env.config.allow, ...env.session], part) || isReadOnly(part, env.config.readOnlyCommands)) {
    return { verdict: "allow" };
  }
  return { verdict: "ask", flag: flag(part.text, "no allow rule", suggestRule(part)) };
}

// Split only outer shell command segments. Substitution and subshell contents
// remain in their owner's segment, so a nested `cd` cannot change our redirect base.
function topLevelSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let depth = 0;
  let heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  const delimiterAt = (index: number): { delimiter: string; end: number; stripTabs: boolean } | undefined => {
    let cursor = index + 2;
    let stripTabs = false;
    if (command[cursor] === "<") return undefined;
    if (command[cursor] === "-") {
      stripTabs = true;
      cursor++;
    }
    while (command[cursor] === " " || command[cursor] === "\t") cursor++;
    const begin = cursor;
    let word = "";
    let wordQuote: "'" | '"' | null = null;
    while (cursor < command.length) {
      const char = command[cursor];
      if (wordQuote) {
        if (char === wordQuote) wordQuote = null;
        else word += char;
      } else if (char === "'" || char === '"') wordQuote = char;
      else if (char === "\\" && cursor + 1 < command.length) word += command[++cursor];
      else if (/\s|[;&|<>]/.test(char)) break;
      else word += char;
      cursor++;
    }
    return word && cursor > begin ? { delimiter: word, end: cursor, stripTabs } : undefined;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "$" && next === "(") depth++;
      else if (char === ")" && depth > 0) depth--;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      continue;
    }
    if (char === "$" && next === "(") {
      depth++;
      i++;
      continue;
    }
    if (char === "`" ) {
      const end = command.indexOf("`", i + 1);
      if (end >= 0) i = end;
      continue;
    }
    if (char === "<" && next === "<") {
      const doc = delimiterAt(i);
      if (doc) {
        heredocs.push({ delimiter: doc.delimiter, stripTabs: doc.stripTabs });
        i = doc.end - 1;
        continue;
      }
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (char === "\n") {
      if (depth === 0) {
        segments.push(command.slice(start, i));
        start = i + 1;
      }
      if (heredocs.length > 0) {
        i++;
        for (const heredoc of heredocs) {
          let found = false;
          while (i <= command.length) {
            const end = command.indexOf("\n", i);
            const line = command.slice(i, end < 0 ? command.length : end);
            i = end < 0 ? command.length : end + 1;
            if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
              found = true;
              break;
            }
            if (end < 0) break;
          }
          if (!found) break;
        }
        start = i;
        i--;
        heredocs = [];
      }
      continue;
    }
    if (depth === 0 && (char === ";" || char === "|" || char === "&")) {
      segments.push(command.slice(start, i));
      if ((char === "&" || char === "|") && next === char) i++;
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

function homePath(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function redirectPath(target: string, dir: string | null): { path: string; outside: boolean } {
  if (target.includes("$")) return { path: resolve("/", target), outside: true };
  const expanded = homePath(target);
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
  if (dir === null && !isAbsolute(target)) return null;
  return physical(resolve(dir ?? "/", target));
}

function evaluateBash(call: Call, env: Env): Decision {
  const command = call.command ?? "";
  const parsed = parse(command);
  const root = physical(env.root);
  let dir: string | null = physical(env.cwd);
  const evaluations: Evaluation[] = [];
  const segments = topLevelSegments(command);
  const parsedSegments = segments.map((segment) => parse(segment));
  const hasUnsafe = parsed.unsafe !== undefined;

  for (const [segmentIndex, segment] of parsedSegments.entries()) {
    for (const [index, part] of segment.parts.entries()) {
      const result = evaluatePart(part, env);
      evaluations.push(result);
      for (const target of part.redirects) {
        const targetPath = redirectPath(target, dir);
        evaluations.push(evaluatePath(targetPath.path, "Edit", { ...env, root, cwd: "/" }, targetPath.outside));
      }
      if (index === 0 && !/^\s*(?:\$\(|`|\()/.test(segments[segmentIndex]) && part.argv.length > 0 && basename(part.argv[0]) === "cd") dir = cdDirectory(part, dir);
    }
  }

  const denied = evaluations.filter((result) => result.verdict === "deny");
  if (denied.length > 0) return choose(evaluations);
  if (hasUnsafe) {
    if (env.mode === "plan") return decision("deny", [flag(command, "plan mode")]);
    return decision("ask", [flag(command, `unparsed: ${parsed.unsafe ?? parsedSegments.find((segment) => segment.unsafe)?.unsafe ?? "unsafe command"}`)]);
  }
  return choose(evaluations);
}

export function decide(call: Call, env: Env): Decision {
  const family = toolFamily(call.tool);
  if (family === "Bash") return evaluateBash(call, env);
  if (family === "Read" || family === "Edit") {
    const path = call.path ?? (family === "Read" && ["grep", "find", "ls"].includes(call.tool) ? env.cwd : "");
    if (!path) return decision(family === "Read" ? "allow" : "ask", family === "Read" ? [] : [flag(call.tool, "no allow rule")]);
    return choose([evaluatePath(path, family, env)]);
  }

  const deny = customRule(env.config.deny, call.tool);
  if (deny) return decision("deny", [flag(call.tool, deny.text)]);
  const ask = customRule(env.config.ask, call.tool);
  if (ask) return decision("ask", [flag(call.tool, ask.text)]);
  return decision("allow");
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
  if (d.verdict === "allow") return { block: true, reason: d.reason };
  const first = d.flags[0];
  if (!first) return { block: true, reason: d.reason };
  return {
    block: true,
    reason: `permission: \`${first.label}\` ${d.verdict === "deny" ? "is denied" : "needs approval"} (${first.rule}). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.`,
  };
}
