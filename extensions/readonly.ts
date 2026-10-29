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
  if (part.assignments.length > 0) return false;
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

function longOptionName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals < 0 ? arg : arg.slice(0, equals);
}

function hasInlineOptionValue(arg: string): boolean {
  return arg.includes("=");
}

function simpleCommandIsReadOnly(command: string, args: string[]): boolean {
  if (command === "file") return fileIsReadOnly(args);
  if (command === "sort") return sortIsReadOnly(args);
  if (command === "uniq") return uniqOperands(args) <= 1;
  if (command === "date") return dateIsReadOnly(args);
  if (command === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
  if (command === "fd") return !args.some((arg) => ["-x", "-X", "--exec", "--exec-batch"].includes(arg)
    || arg.startsWith("-x") || arg.startsWith("-X") || arg.startsWith("--exec=") || arg.startsWith("--exec-batch="));
  return true;
}

const SORT_SAFE_LONG_OPTIONS = new Set([
  "--check", "--debug", "--dictionary-order", "--field-separator", "--general-numeric-sort",
  "--human-numeric-sort", "--ignore-case", "--ignore-leading-blanks", "--ignore-nonprinting", "--key",
  "--merge", "--month-sort", "--numeric-sort", "--parallel", "--random-sort", "--reverse", "--stable",
  "--unique", "--version-sort", "--zero-terminated", "--buffer-size",
]);
const SORT_LONG_VALUE_OPTIONS = new Set(["--field-separator", "--key", "--parallel", "--buffer-size"]);

function sortIsReadOnly(args: string[]): boolean {
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) continue;
    if (arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!SORT_SAFE_LONG_OPTIONS.has(option)) return false;
      if (SORT_LONG_VALUE_OPTIONS.has(option) && !hasInlineOptionValue(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return false;
        i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;

    for (let j = 1; j < arg.length; j++) {
      const option = arg[j];
      if (option === "o" || option === "T") return false;
      if (option === "k" || option === "t" || option === "S") break;
    }
  }
  return true;
}

const DATE_SAFE_LONG_OPTIONS = new Set([
  "--date", "--iso-8601", "--rfc-3339", "--rfc-email", "--utc", "--universal", "--reference", "--debug",
]);
const DATE_LONG_VALUE_OPTIONS = new Set(["--date", "--reference"]);

function dateIsReadOnly(args: string[]): boolean {
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) continue;
    if (arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!DATE_SAFE_LONG_OPTIONS.has(option)) return false;
      if (DATE_LONG_VALUE_OPTIONS.has(option) && !hasInlineOptionValue(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return false;
        i++;
      }
      continue;
    }
    if (arg === "-s" || (arg.startsWith("-s") && arg !== "--")) return false;
  }
  return true;
}

const FILE_SAFE_LONG_OPTIONS = new Set([
  "--brief", "--mime", "--mime-type", "--mime-encoding", "--dereference", "--no-dereference", "--keep-going",
  "--raw", "--print0", "--no-pad", "--separator", "--exclude", "--files-from", "--uncompress",
  "--special-files", "--extension", "--apple", "--no-buffer",
]);
const FILE_LONG_VALUE_OPTIONS = new Set(["--separator", "--exclude", "--files-from"]);

function fileIsReadOnly(args: string[]): boolean {
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) continue;
    if (arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!FILE_SAFE_LONG_OPTIONS.has(option)) return false;
      if (FILE_LONG_VALUE_OPTIONS.has(option) && !hasInlineOptionValue(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return false;
        i++;
      }
    } else if (arg.startsWith("-") && arg !== "-" && arg.slice(1).includes("C")) return false;
  }
  return true;
}

const UNIQ_VALUELESS_LONG_OPTIONS = new Set([
  "--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated", "--all-repeated", "--group",
]);
const UNIQ_SAFE_LONG_OPTIONS = new Set([
  ...UNIQ_VALUELESS_LONG_OPTIONS, "--skip-fields", "--skip-chars", "--check-chars",
]);
const UNIQ_LONG_VALUE_OPTIONS = new Set(["--skip-fields", "--skip-chars", "--check-chars"]);

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
    if (arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!UNIQ_SAFE_LONG_OPTIONS.has(option)) return 2;
      if (UNIQ_LONG_VALUE_OPTIONS.has(option) && !hasInlineOptionValue(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return 2;
        i++;
      }
      continue;
    }

    if (["-f", "-s", "-w"].includes(arg)) {
      if (args[i + 1] === undefined) return 2;
      i++;
      continue;
    }
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

const SED_SAFE_LONG_OPTIONS = new Set([
  "--quiet", "--silent", "--regexp-extended", "--posix", "--null-data", "--zero-terminated",
  "--separate", "--debug", "--sandbox", "--expression",
]);
const SED_NO_ARGUMENT_OPTIONS = new Set(["-n", "-E", "-r", "-u", "-s", "-z"]);

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
    if (options && arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!SED_SAFE_LONG_OPTIONS.has(option)) return false;
      if (option === "--expression") {
        const script = hasInlineOptionValue(arg) ? arg.slice(arg.indexOf("=") + 1) : args[++i];
        if (script === undefined) return false;
        scripts.push(script);
        hasExplicitScript = true;
      }
      continue;
    }
    if (options && (arg === "-i" || arg.startsWith("-i"))) return false;
    if (options && (arg === "-f" || arg.startsWith("-f") || arg === "--file" || arg.startsWith("--file="))) return false;
    if (options && arg === "-e") {
      if (args[i + 1] === undefined) return false;
      scripts.push(args[++i]);
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
  return scripts.every(sedScriptIsReadOnly);
}

function isSedDelimiter(char: string): boolean {
  return char !== "\\" && !/[A-Za-z0-9]/.test(char) && char.trim() !== "";
}

function findSedDelimiter(script: string, start: number, delimiter: string): number {
  for (let i = start; i < script.length; i++) {
    if (script[i] === "\\") i++;
    else if (script[i] === delimiter) return i;
  }
  return -1;
}

function sedScriptIsReadOnly(script: string): boolean {
  for (let i = 0; i < script.length;) {
    const char = script[i];
    if (char === "/") {
      const end = findSedDelimiter(script, i + 1, "/");
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (char === "\\" && i + 1 < script.length && isSedDelimiter(script[i + 1])) {
      const delimiter = script[i + 1];
      const end = findSedDelimiter(script, i + 2, delimiter);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if ((char === "s" || char === "y") && i + 1 < script.length && isSedDelimiter(script[i + 1])) {
      const delimiter = script[i + 1];
      const patternEnd = findSedDelimiter(script, i + 2, delimiter);
      if (patternEnd < 0) return false;
      const replacementEnd = findSedDelimiter(script, patternEnd + 1, delimiter);
      if (replacementEnd < 0) return false;
      if (char === "s") {
        let flagsEnd = replacementEnd + 1;
        while (/[A-Za-z0-9]/.test(script[flagsEnd] ?? "")) flagsEnd++;
        if (/[we]/i.test(script.slice(replacementEnd + 1, flagsEnd))) return false;
        i = flagsEnd;
      } else i = replacementEnd + 1;
      continue;
    }
    if (char === "w" || char === "W" || char === "e") return false;
    i++;
  }
  return true;
}

const AWK_VALUE_OPTIONS = new Set(["-F", "-v"]);
const AWK_SAFE_LONG_OPTIONS = new Set([
  "--field-separator", "--assign", "--posix", "--traditional", "--re-interval", "--characters-as-bytes",
  "--sandbox", "--lint", "--non-decimal-data",
]);
const AWK_LONG_VALUE_OPTIONS = new Set(["--field-separator", "--assign"]);
const AWK_UNSAFE_OPTIONS = ["-i", "-l", "-E", "-p"];
const AWK_FLAG_OPTIONS = new Set(["-b", "-c", "-g", "-M", "-P", "-s", "-S", "-t"]);

function awkIsReadOnly(args: string[]): boolean {
  let program: string | undefined;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("--")) {
      const option = longOptionName(arg);
      if (!AWK_SAFE_LONG_OPTIONS.has(option)) return false;
      if (AWK_LONG_VALUE_OPTIONS.has(option) && !hasInlineOptionValue(arg)) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return false;
        i++;
      }
      continue;
    }
    if (options && AWK_UNSAFE_OPTIONS.some((option) => arg === option || (arg.startsWith(option) && arg.length > option.length))) return false;
    if (options && (arg === "-f" || (arg.startsWith("-f") && arg.length > 2))) return false;
    if (options && AWK_VALUE_OPTIONS.has(arg)) {
      if (args[i + 1] === undefined) return false;
      i++;
      continue;
    }
    if (options && ((arg.startsWith("-F") && arg.length > 2) || (arg.startsWith("-v") && arg.length > 2))) continue;
    if (options && AWK_FLAG_OPTIONS.has(arg)) continue;
    if (options && arg.startsWith("-")) return false;
    program = arg;
    break;
  }
  if (program === undefined) return false;
  return !program.includes(">") && !program.includes("|") && !program.includes("@load") && !program.includes("@include")
    && !/\bsystem\s*\(/.test(program) && !/\bgetline\b/.test(program);
}

function hasUnsafeGitReadOption(args: string[]): boolean {
  const dangerousOptions = ["--output", "--open-files-in-pager"];
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const name = longOptionName(arg);
    if (name.length >= 4 && dangerousOptions.some((option) => option.startsWith(name))) return true;
  }
  return false;
}

function gitIsReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-c" || (arg.startsWith("-c") && arg.length > 2)
      || arg === "--config-env" || arg.startsWith("--config-env=")) return false;
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
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
  if (hasUnsafeGitReadOption(rest)) return false;
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
