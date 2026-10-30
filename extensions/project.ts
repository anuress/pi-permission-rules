import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type Project = { root: string; key: string };
export type Git = (args: string[], cwd: string) => string | null;

function realpathAllowMissing(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(realpathAllowMissing(parent), basename(absolute));
}

export function resolveProject(cwd: string, git: Git): Project {
  const rootOutput = git(["rev-parse", "--show-toplevel"], cwd);
  if (rootOutput === null) {
    const root = realpathAllowMissing(cwd);
    return { root, key: root };
  }

  const rootPath = isAbsolute(rootOutput) ? rootOutput : resolve(cwd, rootOutput);
  const root = realpathAllowMissing(rootPath);
  let commonOutput = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  let commonBase = cwd;
  if (commonOutput === null) {
    commonOutput = git(["rev-parse", "--git-common-dir"], cwd);
    commonBase = realpathAllowMissing(cwd);
  }
  if (commonOutput === null) {
    const fallback = realpathAllowMissing(cwd);
    return { root: fallback, key: fallback };
  }

  const commonPath = isAbsolute(commonOutput) ? commonOutput : resolve(commonBase, commonOutput);
  const key = realpathAllowMissing(dirname(commonPath));
  return { root, key };
}

export function keyFilename(key: string): string {
  return `${key.replace(/[^A-Za-z0-9]/g, "-")}.json`;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
