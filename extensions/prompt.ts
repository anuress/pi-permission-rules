import { suggestExactRule, type Call, type Decision } from "./decide.ts";
import { parse } from "./shell.ts";
import type { Mode } from "./config.ts";
import { toolFamily } from "./rules.ts";

export type Ui = {
  select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
};

export type Outcome =
  | { allow: true; grant?: string[]; sessionGrant?: string[]; switchMode?: "acceptEdits" }
  | { allow: false; reason: string };

const YES = "Yes";
const NO = "No, and tell pi what to do differently";
const SESSION = "Yes, allow all edits during this session";
const PLAIN_DENY = "permission: denied by user. It was not run.";

export async function ask(ui: Ui, call: Call, d: Decision, mode: Mode, timeoutSec?: number): Promise<Outcome> {
  const title = [`Permission needed: ${call.tool}`, ...d.flags.map(({ label, rule }) => `- ${label} (${rule})`)].join("\n");
  const family = toolFamily(call.tool);
  const bashParts = call.command === undefined ? undefined : parse(call.command);
  const exactSuggestions = new Map<string, string | null>();
  if (family === "Bash" && bashParts?.unsafe === undefined && bashParts !== undefined) {
    for (const part of bashParts.parts) {
      const suggestion = suggestExactRule(part);
      exactSuggestions.set(part.text, exactSuggestions.has(part.text) && exactSuggestions.get(part.text) !== suggestion
        ? null : suggestion);
    }
  }
  const suggestionFor = (flag: Decision["flags"][number]) => {
    if (flag.suggestion !== null) return flag.suggestion;
    const matchingItems = d.items.filter((item) => item.verdict !== "allow" && item.label === flag.label);
    if (matchingItems.length === 0 || matchingItems.some((item) => item.kind !== "part")) return null;
    return exactSuggestions.get(flag.label) ?? null;
  };
  const suggestions = [...new Set(d.flags.map(suggestionFor).filter((suggestion): suggestion is string => suggestion !== null))];
  const persistent = family === "Bash" && d.flags.length > 0 && d.flags.every((flag) => suggestionFor(flag) !== null)
    ? `Yes, and don't ask again for ${suggestions.join(", ")} in this project`
    : undefined;
  const outsideItems = d.items.filter((item) => item.verdict !== "allow");
  const outsidePathAsk = family === "Edit" && outsideItems.length > 0 && outsideItems.every((item) => item.kind === "path")
    || family === "Bash" && outsideItems.length > 0 && outsideItems.every((item) => item.kind === "redirect");
  const outsideDirectories = [...new Set(outsideItems.map((item) => item.sessionGrantDirectory))];
  const outsideSessionDirectory = mode === "acceptEdits" && outsidePathAsk && d.flags.length > 0
    && d.flags.every((flag) => flag.reason === "outside-project-root" && flag.sessionGrantDirectory !== undefined)
    && outsideItems.every((item) => item.reason === "outside-project-root" && item.sessionGrantDirectory !== undefined)
    && outsideDirectories.length === 1 ? outsideDirectories[0] : undefined;
  const outsideSession = outsideSessionDirectory === undefined
    ? undefined
    : `Yes, and allow edits in ${outsideSessionDirectory} during this session`;
  const session = family === "Edit" && mode === "default" ? SESSION : undefined;
  const options = [YES, ...(persistent ? [persistent] : outsideSession ? [outsideSession] : session ? [session] : []), NO];
  const selected = timeoutSec === undefined
    ? await ui.select(title, options)
    : await ui.select(title, options, { timeout: timeoutSec * 1000 });

  if (selected === YES) return { allow: true };
  if (persistent && selected === persistent) return { allow: true, grant: suggestions };
  if (outsideSession && selected === outsideSession && outsideSessionDirectory !== undefined) {
    return { allow: true, sessionGrant: [`Edit(${outsideSessionDirectory}/**)`] };
  }
  if (session && selected === session) return { allow: true, switchMode: "acceptEdits" };
  if (selected === NO) {
    const guidance = (await ui.input("Tell pi what to do differently"))?.trim();
    return { allow: false, reason: guidance ? `permission: denied by user: ${guidance}. It was not run.` : PLAIN_DENY };
  }
  return {
    allow: false,
    reason: timeoutSec === undefined ? PLAIN_DENY : "permission: approval timed out. It was not run.",
  };
}
