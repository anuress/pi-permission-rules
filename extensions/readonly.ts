import type { Part } from "./shell.ts";

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "pwd", "echo", "printf",
  "which", "file", "stat", "du", "df", "jq", "sort", "uniq", "cut", "tr", "diff", "cmp",
  "basename", "dirname", "realpath", "true", "test", "[", "date", "cd",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  "status", "log", "show", "diff", "blame", "rev-parse", "ls-files", "ls-tree", "grep",
  "merge-base", "cat-file", "describe", "shortlog", "reflog",
]);

export const CODE_RUNNERS: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "python", "python3", "node", "ruby", "perl", "eval", "sudo", "xargs", "env", "exec", "source", ".",
]);

export function isReadOnly(part: Part, extra: readonly string[]): boolean {
  const first = part.argv[0];
  if (first === undefined) return true;
  if (first.includes("$")) return false;

  const command = basename(first);
  if (extra.some((name) => basename(name) === command)) return true;
  if (READ_ONLY_COMMANDS.has(command)) return simpleCommandIsReadOnly(command, part.argv.slice(1));
  if (command === "find") return findIsReadOnly(part.argv.slice(1));
  if (command === "sed") return sedIsReadOnly(part.argv.slice(1));
  if (command === "awk") return awkIsReadOnly(part.argv.slice(1));
  if (command === "git") return gitIsReadOnly(part.argv.slice(1));
  if (command === "gh") return ghIsReadOnly(part.argv.slice(1));
  return false;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function simpleCommandIsReadOnly(command: string, args: string[]): boolean {
  if (command === "sort") return !hasSortOutput(args);
  if (command === "uniq") return uniqOperands(args) <= 1;
  if (command === "date") return !args.some((arg) => arg === "-s" || arg.startsWith("-s") || arg === "--set" || arg.startsWith("--set="));
  if (command === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
  if (command === "fd") return !args.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg)
    || arg.startsWith("-x") || arg.startsWith("-X") || arg.startsWith("--exec=") || arg.startsWith("--exec-batch="));
  return true;
}

function hasSortOutput(args: string[]): boolean {
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) continue;
    if (arg === "-o" || (arg.startsWith("-o") && arg.length > 2)
      || arg === "--output" || arg.startsWith("--output=")) return true;
  }
  return false;
}

function uniqOperands(args: string[]): number {
  let operands = 0;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith("-")) {
      operands++;
      continue;
    }

    if (["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"].includes(arg)) {
      if (args[i + 1] === undefined) return 2;
      i++;
      continue;
    }
    if (["--skip-fields", "--skip-chars", "--check-chars"].some((option) => arg.startsWith(`${option}=`))) continue;
    if (/^-[fsw]\d+$/.test(arg)) continue;
    if (/^-[cduiDz]+$/.test(arg)) continue;
    return 2;
  }
  return operands;
}

function findIsReadOnly(args: string[]): boolean {
  return !args.some((arg) => ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fls"].includes(arg)
    || arg.startsWith("-fprint"));
}

const SED_WRITE_COMMAND = /(^|[;{}\n])\s*[wWe](\s|$)/;
const SED_WRITE_SUBSTITUTION = /s(.).*?\1.*?\1[a-zA-Z0-9]*[we]/;
const SED_NO_ARGUMENT_OPTIONS = new Set([
  "-n", "-E", "-r", "-u", "-s", "-z", "--quiet", "--silent", "--debug", "--posix", "--sandbox",
]);

function sedIsReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  let options = true;
  let hasExplicitScript = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return false;
    if (options && (arg === "-f" || arg.startsWith("-f") || arg === "--file" || arg.startsWith("--file="))) return false;
    if (options && (arg === "-e" || arg === "--expression")) {
      if (args[i + 1] === undefined) return false;
      scripts.push(args[++i]);
      hasExplicitScript = true;
      continue;
    }
    if (options && arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      hasExplicitScript = true;
      continue;
    }
    if (options && arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
      hasExplicitScript = true;
      continue;
    }
    if (options && SED_NO_ARGUMENT_OPTIONS.has(arg)) continue;
    if (options && arg.startsWith("-")) return false;
    if (!hasExplicitScript) {
      scripts.push(arg);
      hasExplicitScript = true;
    }
  }
  return !scripts.some((script) => SED_WRITE_COMMAND.test(script) || SED_WRITE_SUBSTITUTION.test(script));
}

const AWK_VALUE_OPTIONS = new Set(["-F", "-v", "--field-separator", "--assign"]);
const AWK_FLAG_OPTIONS = new Set([
  "-b", "-c", "-g", "-M", "-p", "-P", "-s", "-S", "-t", "--lint", "--posix",
  "--traditional", "--characters-as-bytes", "--re-interval", "--sandbox",
]);

function awkIsReadOnly(args: string[]): boolean {
  let program: string | undefined;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && (arg === "-f" || arg === "--file" || arg.startsWith("--file=") || (arg.startsWith("-f") && arg.length > 2))) return false;
    if (options && AWK_VALUE_OPTIONS.has(arg)) {
      if (args[i + 1] === undefined) return false;
      i++;
      continue;
    }
    if (options && ((arg.startsWith("-F") && arg.length > 2) || (arg.startsWith("-v") && arg.length > 2)
      || arg.startsWith("--field-separator=") || arg.startsWith("--assign="))) continue;
    if (options && AWK_FLAG_OPTIONS.has(arg)) continue;
    if (options && arg.startsWith("-")) return false;
    program = arg;
    break;
  }
  if (program === undefined) return false;
  return !program.includes(">") && !program.includes("|")
    && !/\bsystem\s*\(/.test(program) && !/\bgetline\b/.test(program);
}

function gitIsReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      if (args[i + 1] === undefined) return false;
      i += 2;
    } else if (arg === "--no-pager" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      i++;
    } else if (arg.startsWith("-")) {
      return false;
    } else break;
  }
  if (i >= args.length) return false;

  const [subcommand, ...rest] = args.slice(i);
  if (rest.some((arg) => arg.startsWith("--output"))) return false;
  if (READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    return subcommand !== "grep" || !rest.some((arg) => arg === "-O" || arg.startsWith("-O")
      || arg === "--open-files-in-pager" || arg.startsWith("--open-files-in-pager="));
  }
  if (subcommand === "branch") return branchIsReadOnly(rest);
  if (subcommand === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
  if (subcommand === "stash") return rest.length === 1 && rest[0] === "list";
  if (subcommand === "config") return gitConfigIsReadOnly(rest);
  return false;
}

function branchIsReadOnly(args: string[]): boolean {
  const allowedFlags = new Set(["-a", "-r", "--list", "-v", "-vv", "--show-current"]);
  let listMode = false;
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) {
      if (!listMode) return false;
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (allowedFlags.has(arg)) {
      if (arg === "--list") listMode = true;
      continue;
    }
    if (!arg.startsWith("-") && listMode) continue;
    return false;
  }
  return true;
}

const GIT_CONFIG_READ_MODES = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const GIT_CONFIG_WRITE_MODES = new Set([
  "--edit", "-e", "--replace-all", "--add", "--unset", "--unset-all", "--rename-section", "--remove-section",
]);

function gitConfigIsReadOnly(args: string[]): boolean {
  return args.some((arg) => GIT_CONFIG_READ_MODES.has(arg))
    && !args.some((arg) => GIT_CONFIG_WRITE_MODES.has(arg));
}

function ghIsReadOnly(args: string[]): boolean {
  if (args[0] === "pr") return ["view", "list", "diff", "checks"].includes(args[1] ?? "");
  if (args[0] === "issue") return ["view", "list"].includes(args[1] ?? "");
  if (args[0] !== "api") return false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method") {
      const method = args[++i];
      if (method !== "GET") return false;
      continue;
    }
    if (arg.startsWith("-X") && arg.length > 2) {
      if (arg.slice(2) !== "GET") return false;
      continue;
    }
    if (arg.startsWith("--method=")) {
      if (arg.slice("--method=".length) !== "GET") return false;
      continue;
    }
    if (["-f", "-F", "--field", "--raw-field", "--input"].includes(arg)
      || arg.startsWith("-f") || arg.startsWith("-F")
      || arg.startsWith("--field=") || arg.startsWith("--raw-field=") || arg.startsWith("--input=")) return false;
  }
  return true;
}
