import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Mode } from "./config.ts";
import { isReadOnly, CODE_RUNNERS } from "./readonly.ts";
import { matchBash, matchPath, parseRule, type Rule, toolFamily } from "./rules.ts";
import { DANGEROUS_ASSIGNMENT, parse, type Part } from "./shell.ts";

export type Call = { tool: string; command?: string; path?: string };
export type Env = { root: string; cwd: string; mode: Mode; config: Config; session: Rule[]; git?: (args: string[], cwd: string) => string | null };
export type Flag = { label: string; rule: string; suggestion: string | null; reason?: "outside-project-root"; sessionGrantDirectory?: string };
export type DecisionItem = {
  kind: "part" | "redirect" | "path" | "tool";
  label: string;
  verdict: "allow" | "ask" | "deny";
  rule: string;
  reason?: "outside-project-root";
  sessionGrantDirectory?: string;
};
export type Decision = { verdict: "allow" | "ask" | "deny"; flags: Flag[]; reason: string; items: DecisionItem[] };

type Verdict = Decision["verdict"];
type Evaluation = { verdict: Verdict; flag?: Flag; item: DecisionItem };

const MODES: readonly Mode[] = ["default", "acceptEdits", "plan"];
const READ_VALUE_OPTIONS = new Set(["-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"]);
const READ_ARGUMENT_EXEMPT_COMMANDS = new Set(["echo", "printf", "read", "test", "[", "cd", "pwd", "basename", "dirname", "realpath", "true", "false", ":", "which"]);

function physical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
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

function flag(label: string, rule: string, suggestion: string | null = null, metadata: Pick<Flag, "reason" | "sessionGrantDirectory"> = {}): Flag {
  return { label, rule, suggestion, ...metadata };
}

function decision(verdict: Verdict, flags: Flag[] = [], reasonFlag = flags[0], items: DecisionItem[] = []): Decision {
  const reason = reasonFlag && verdict !== "allow"
    ? `permission: \`${reasonFlag.label}\` ${verdict === "deny" ? "is denied" : "needs approval"} (${reasonFlag.rule}). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.`
    : "";
  return { verdict, flags, reason, items };
}

function evaluated(
  kind: DecisionItem["kind"], label: string, verdict: Verdict, rule: string, suggestion: string | null = null,
  metadata: Pick<Flag, "reason" | "sessionGrantDirectory"> = {},
): Evaluation {
  return {
    verdict,
    ...(verdict === "allow" ? {} : { flag: flag(label, rule, suggestion, metadata) }),
    item: { kind, label, verdict, rule: verdict === "allow" ? `allowed: ${rule}` : rule, ...metadata },
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

function nearestExistingDirectory(path: string): string {
  let candidate = path;
  while (true) {
    try {
      if (statSync(candidate).isDirectory()) return physical(candidate);
    } catch { /* Walk up to the nearest existing directory. */ }
    const parent = dirname(candidate);
    if (parent === candidate) return physical(candidate);
    candidate = parent;
  }
}

function outsideGrantDirectory(path: string, env: Env): string | undefined {
  const cwd = nearestExistingDirectory(path);
  let output: string | null = null;
  try { output = env.git?.(["rev-parse", "--show-toplevel"], cwd) ?? null; } catch { /* Use the target parent when Git is unavailable. */ }
  const directory = output === null ? physical(dirname(path)) : physical(isAbsolute(output) ? output : resolve(cwd, output));
  if (directory === "/" || inside(physical(homedir()), directory) || /[*?\n\r]/.test(directory)
    || !parseRule(`Edit(${directory}/**)`)) return undefined;
  return directory;
}

function evaluatePath(path: string, family: "Read" | "Edit", env: Env, outside = false, kind: "path" | "redirect" = "path"): Evaluation {
  const absolute = physical(resolve(env.cwd, path));
  const root = physical(env.root);
  const deny = pathRule(env.config.deny, family, absolute, root);
  if (deny) return evaluated(kind, absolute, "deny", deny.text);

  if (family === "Edit" && env.mode === "plan") return evaluated(kind, absolute, "deny", "plan mode");
  if (family === "Edit" && /(?:^|\/)\.git(?:\/|$)/.test(absolute)) {
    return evaluated(kind, absolute, "ask", "built-in .git protection");
  }
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
  const metadata = family === "Edit" && env.mode === "acceptEdits" && !outside && !inside(absolute, root)
    ? { reason: "outside-project-root" as const, sessionGrantDirectory: outsideGrantDirectory(absolute, env) }
    : {};
  return evaluated(kind, absolute, "ask", "no allow rule", null, metadata);
}

function dangerousAssignment(part: Part): string | undefined {
  for (const assignment of part.assignments) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (DANGEROUS_ASSIGNMENT.test(name)) return name;
  }
  return undefined;
}

// All three wrappers run the command in the current shell and none takes a value option.
const WRAPPERS = new Set(["builtin", "command", "time"]);

// Strips leading `builtin`, `command` and `time` wrappers with their flags.
function unwrapWrappers(argv: string[]): string[] {
  let rest = argv;
  while (rest.length > 0 && WRAPPERS.has(rest[0])) {
    let i = 1;
    while (i < rest.length && rest[i].startsWith("-") && rest[i] !== "-") {
      if (rest[i] === "--") {
        i++;
        break;
      }
      i++;
    }
    rest = rest.slice(i);
  }
  return rest;
}

function changesDir(argv: string[]): boolean {
  const word = unwrapWrappers(argv)[0];
  return word === "cd" || word === "pushd" || word === "popd";
}

// Names `read` assigns, including array targets; a dynamic name is not knowable.
function readAssignment(part: Part): string | undefined {
  const argv = unwrapWrappers(part.argv);
  if (argv[0] !== "read") return undefined;
  const names: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      names.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      names.push(...argv.slice(i));
      break;
    }
    for (let j = 1; j < arg.length; j++) {
      if (!READ_VALUE_OPTIONS.has(`-${arg[j]}`)) continue;
      const attached = arg.slice(j + 1);
      if (arg[j] === "a") names.push(attached || argv[++i] || "");
      else if (!attached) i++;
      break;
    }
  }
  return names.find((name) => !name || /[$`]/.test(name) || DANGEROUS_ASSIGNMENT.test(name));
}

function hasReadRules(env: Env): boolean {
  return [...env.config.ask, ...env.config.deny].some((rule) => rule.tool === "Read");
}

function evaluatePart(part: Part, env: Env): Evaluation {
  if (part.argv.length === 0) {
    if (part.assignments.length > 0) {
      if (env.mode === "plan") return evaluated("part", part.text, "deny", "plan mode");
      const deny = partRule(env.config.deny, part);
      if (deny) return evaluated("part", part.text, "deny", deny.text);
      const ask = partRule(env.config.ask, part);
      if (ask) return evaluated("part", part.text, "ask", ask.text);
      return evaluated("part", part.text, "ask", "assignment statement");
    }
    if (part.redirects.length > 0 || part.inputs.length > 0) {
      if (part.compoundRedirect) return evaluated("part", part.text, "allow", "compound command redirect");
      return evaluated("part", part.text, env.mode === "plan" ? "deny" : "ask", env.mode === "plan" ? "plan mode" : "unparsed: empty command");
    }
    return evaluated("part", part.text, "allow", "empty command part");
  }
  if (env.mode === "plan" && !isReadOnly(part, env.config.readOnlyCommands, hasReadRules(env))) {
    return evaluated("part", part.text, "deny", "plan mode");
  }
  const deny = partRule(env.config.deny, part);
  if (deny) return evaluated("part", part.text, "deny", deny.text);
  const ask = partRule(env.config.ask, part);
  if (ask) return evaluated("part", part.text, "ask", ask.text);

  const unsafeAssignment = dangerousAssignment(part);
  if (unsafeAssignment) return evaluated("part", part.text, "ask", `dangerous env ${unsafeAssignment}`);
  const readTarget = readAssignment(part);
  if (readTarget) return evaluated("part", part.text, "ask", `dangerous env ${readTarget}`);
  const allow = partRule(env.config.allow, part);
  if (allow) return evaluated("part", part.text, "allow", `allow rule ${allow.text}`);
  const session = partRule(env.session, part);
  if (session) return evaluated("part", part.text, "allow", `session rule ${session.text}`);
  if (isReadOnly(part, env.config.readOnlyCommands, hasReadRules(env))) return evaluated("part", part.text, "allow", "read-only");
  return evaluated("part", part.text, "ask", "no allow rule", suggestRule(part));
}

function homePath(path: string): string | null {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("~") ? null : path;
}

function redirectPath(target: string, dir: string | null, glob = false): { path: string; outside: boolean } {
  if (glob || target.includes("$")) return { path: resolve(dir ?? "/", target), outside: true };
  const expanded = homePath(target);
  if (expanded === null) return { path: resolve("/", target), outside: true };
  if (isAbsolute(expanded)) return { path: physical(expanded), outside: false };
  return dir === null
    ? { path: resolve("/", target), outside: true }
    : { path: physical(resolve(dir, target)), outside: false };
}

function cdDirectory(part: Part, dir: string | null): string | null {
  // Only a bare `cd` surely runs in this shell; a wrapped one leaves the directory unknown.
  if (part.argv[0] !== "cd") return null;
  const args = part.argv.slice(1);
  let index = 0;
  while (args[index]?.startsWith("-") && args[index] !== "-") {
    if (args[index] === "--") {
      index++;
      break;
    }
    if (!/^-[LP]+$/.test(args[index])) return null;
    index++;
  }
  const targets = args.slice(index);
  if (targets.length !== 1 || targets[0] === "-" || targets[0].includes("$") || part.globs[index + 1]) return null;
  const target = homePath(targets[0]);
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

  // A loop body that changes directory moves every later iteration's earlier parts too,
  // and a loop id covers its nested subshells and substitutions.
  const loopDirs = new Set<number>();
  for (const part of parsed.parts) {
    if (part.loops?.length && changesDir(part.argv)) for (const id of part.loops) loopDirs.add(id);
  }
  const dirs = new Map<string, string | null>([["", physical(env.cwd)]]);
  const seenCd = new Map<string, boolean>([["", false]]);
  const dirFor = (scope: string): string | null => {
    if (dirs.has(scope)) return dirs.get(scope) ?? null;
    const parentEnd = scope.lastIndexOf("/");
    const parent = parentEnd < 0 ? "" : scope.slice(0, parentEnd);
    const inherited = dirFor(parent);
    seenCd.set(scope, seenCd.get(parent) ?? false);
    dirs.set(scope, inherited);
    return inherited;
  };
  const evaluations: Evaluation[] = [];
  for (const part of parsed.parts) {
    const dir = part.loops?.some((id) => loopDirs.has(id)) ? null : dirFor(part.scope);
    evaluations.push(evaluatePart(part, env));
    for (let index = 0; index < part.redirects.length; index++) {
      const target = part.redirects[index];
      // Bash opens a compound redirect before the body runs, so a cd in the body is not applied.
      const redirectDir = part.compoundRedirect && seenCd.get(part.scope) ? null : dir;
      const targetPath = redirectPath(target, redirectDir, part.redirectGlobs[index]);
      evaluations.push(evaluatePath(targetPath.path, "Edit", { ...env, cwd: "/" }, targetPath.outside, "redirect"));
    }
    for (let index = 0; index < part.inputs.length; index++) {
      const target = part.inputs[index];
      const expanded = homePath(target);
      if (target.includes("$") || expanded === null || part.inputGlobs[index] || (dir === null && !isAbsolute(target))) {
        evaluations.push(evaluated("path", target, "ask", "unresolved input redirect"));
      } else {
        evaluations.push(evaluatePath(physical(resolve(dir ?? "/", expanded)), "Read", { ...env, cwd: "/" }, false, "path"));
      }
    }
    const readRulesPresent = hasReadRules(env);
    if (readRulesPresent && !READ_ARGUMENT_EXEMPT_COMMANDS.has(part.argv[0])
      && (isReadOnly(part, env.config.readOnlyCommands, readRulesPresent) || ["sed", "awk"].includes(part.argv[0]))) {
      let options = true;
      for (const [index, arg] of part.argv.slice(1).entries()) {
        if (options && arg === "--") {
          options = false;
          continue;
        }
        const shortFileValue = options && ["grep", "rg"].includes(part.argv[0]) && arg.startsWith("-") && !arg.startsWith("--")
          ? arg.slice(arg.indexOf("f") + 1) : "";
        const target = options && arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1)
          : shortFileValue && arg.indexOf("f") > 0 ? shortFileValue : arg;
        const expanded = homePath(target);
        if (target.includes("$") || expanded === null || (dir === null && !isAbsolute(target))) {
          evaluations.push(evaluated("path", target, "ask", "unresolved read argument"));
        } else {
          const operand = evaluatePath(physical(resolve(dir ?? "/", expanded)), "Read", { ...env, cwd: "/" });
          if (operand.verdict !== "allow") evaluations.push(operand);
          else if (part.globs[index + 1]) evaluations.push(evaluated("path", target, "ask", "glob read argument is unresolved"));
        }
      }
    }
    const argv = part.argv;
    if (changesDir(argv)) {
      // A second cd, one in a body that may not run, or a wrapped cd leaves the directory unknown.
      if (argv[0] === "cd" && !seenCd.get(part.scope) && !part.conditional) dirs.set(part.scope, cdDirectory(part, dir));
      else dirs.set(part.scope, null);
      seenCd.set(part.scope, true);
    }
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

export function suggestExactRule(part: Part): string | null {
  if (!part.argv.length || part.assignments.length > 0 || !part.text || part.text.includes("*")
    || part.text.includes("$") || part.text.includes("`") || part.globs?.some(Boolean) || part.dynamic?.some(Boolean)) return null;
  const executable = part.argv[0].slice(part.argv[0].lastIndexOf("/") + 1);
  if (CODE_RUNNERS.has(executable)
    || ["command", "nohup", "time", "nice", "timeout", "builtin", "npx", "awk", "gawk", "sed", "find", "exec", "source", "."].includes(executable)
    || (executable === "gh" && part.argv.includes("api"))
    || (executable === "git" && part.argv.slice(1).includes("config"))) return null;
  const text = `Bash(${part.text})`;
  return parseRule(text)?.tool === "Bash" ? text : null;
}

export function suggestRule(part: Part): string | null {
  if (!part.argv.length || part.assignments.length > 0 || part.text.includes("*")) return null;
  const first = part.argv[0];
  const executable = first.slice(first.lastIndexOf("/") + 1);
  if (CODE_RUNNERS.has(executable) || ["for", "select", "case", "while", "until", "if", "function", "time", "{", "(", "!", "read", "command", "nohup", "nice", "timeout", "builtin", "awk", "gawk", "sed", "find", "npx"].includes(executable)
    || (executable === "gh" && part.argv.includes("api"))
    || (["gh", "git"].includes(executable) && part.argv[1]?.startsWith("-"))) return null;
  const second = part.argv[1];
  const third = part.argv[2];
  const dynamicOrGlob = (index: number) => {
    const word = part.argv[index] ?? "";
    return word.includes("$") || word.includes("`") || part.dynamic?.[index] === true || part.globs?.[index] === true;
  };
  if (dynamicOrGlob(1) || ((executable === "gh" || executable === "git") && dynamicOrGlob(2))) return null;
  const safeWord = (word: string | undefined) => !!word && !word.startsWith("-") && !word.startsWith(":") && !/[\\/=\'"]/.test(word)
    && word !== "." && word !== ".." && !word.startsWith("~");
  if (executable === "git" && second === "config") return null;
  if (!safeWord(second)) return null;
  if (first === "gh" && safeWord(third)) {
    return `Bash(${first} ${second} ${third}:*)`;
  }
  if (first === "git" && ["stash", "remote"].includes(second ?? "") && safeWord(third)) {
    return `Bash(${first} ${second} ${third}:*)`;
  }
  if (second && !second.startsWith("-") && !second.startsWith(":") && !/[\/=\'\"]/.test(second)
    && second !== "." && second !== ".." && !second.startsWith("~")) {
    return `Bash(${first} ${second}:*)`;
  }
  return null;
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
