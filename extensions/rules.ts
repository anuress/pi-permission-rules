import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { Part } from "./shell.ts";

export type Rule = { tool: string; pattern?: string; text: string };

const TOOL_NAME = /^[A-Za-z_][\w.-]*$/;

export function parseRule(text: string): Rule | null {
  const input = text.trim();
  const open = input.indexOf("(");
  if (open < 0) return TOOL_NAME.test(input) ? { tool: input, text } : null;

  const tool = input.slice(0, open);
  if (!TOOL_NAME.test(tool)) return null;
  let depth = 1;
  let close = -1;
  for (let i = open + 1; i < input.length; i++) {
    if (input[i] === "(") depth++;
    else if (input[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close !== input.length - 1) return null;
  const pattern = input.slice(open + 1, close);
  if (!pattern) return null;
  return { tool, pattern, text };
}

export function matchBash(rule: Rule, part: Part): boolean {
  if (rule.tool !== "Bash") return false;
  if (rule.pattern === undefined) return true;
  if (part.text === "") return false;

  const pattern = rule.pattern;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return part.text === prefix || part.text.startsWith(`${prefix} `);
  }
  if (!pattern.includes("*") && !pattern.includes("?")) return part.text === pattern;
  return globRegex(pattern, { slash: true, question: false }).test(part.text);
}

export function matchPath(rule: Rule, absPath: string, root: string): boolean {
  if (rule.tool !== "Read" && rule.tool !== "Edit") return false;
  if (rule.pattern === undefined) return true;

  let pattern = rule.pattern;
  if (pattern.startsWith("~/")) pattern = `${homedir()}${pattern.slice(1)}`;
  else if (!isAbsolute(pattern)) pattern = `${root}/${pattern}`;
  return globRegex(pattern, { slash: false, question: true }, process.platform === "darwin" ? "i" : "").test(absPath);
}

export function toolFamily(toolName: string): "Bash" | "Read" | "Edit" | string {
  if (toolName === "bash") return "Bash";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "Read";
  if (["edit", "write"].includes(toolName)) return "Edit";
  return toolName;
}

function globRegex(pattern: string, options: { slash: boolean; question: boolean }, flags = ""): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:[\\s\\S]*/)?";
        i += 2;
      } else {
        source += "[\\s\\S]*";
        i++;
      }
    } else if (char === "*") {
      source += options.slash ? "[\\s\\S]*" : "[^/]*";
    } else if (char === "?" && options.question) {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source, flags);
}
