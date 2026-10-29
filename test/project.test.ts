import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir, keyFilename, resolveProject, type Git } from "../extensions/project.ts";

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ppr-"));
}

test("main checkout and linked worktree share a key and have different roots", () => {
  const temp = tempDir();
  try {
    const main = join(temp, "main");
    const linked = join(temp, "linked");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "initial"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", "--detach", linked], { cwd: main });

    const mainProject = resolveProject(main, runGit);
    const linkedProject = resolveProject(linked, runGit);
    assert.equal(mainProject.key, linkedProject.key);
    assert.notEqual(mainProject.root, linkedProject.root);
    assert.equal(mainProject.root, realpathSync(main));
    assert.equal(linkedProject.root, realpathSync(linked));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a subfolder resolves to its worktree root", () => {
  const temp = tempDir();
  try {
    const root = join(temp, "repo");
    const subfolder = join(root, "nested", "folder");
    mkdirSync(subfolder, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const project = resolveProject(subfolder, runGit);
    assert.equal(project.root, realpathSync(root));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("outside git, root and key are the real cwd", () => {
  const cwd = tempDir();
  try {
    const project = resolveProject(cwd, runGit);
    assert.deepEqual(project, { root: realpathSync(cwd), key: realpathSync(cwd) });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("symlinked cwd resolves to a realpath'd project root", () => {
  const temp = tempDir();
  try {
    const root = join(temp, "repo");
    const link = join(temp, "link");
    mkdirSync(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    symlinkSync(root, link);
    const project = resolveProject(link, runGit);
    assert.equal(project.root, realpathSync(root));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("keyFilename replaces every non-alphanumeric character", () => {
  assert.equal(keyFilename("/Users/a.b/x-y"), "-Users-a-b-x-y.json");
});

test("agentDir honors a non-empty override and defaults for an empty one", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/custom" }), "/tmp/custom");
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "" }), join(homedir(), ".pi", "agent"));
});

test("a failed git command falls back to the real cwd for both identities", () => {
  const temp = tempDir();
  const repo = join(temp, "repo");
  const cwd = join(repo, "nested");
  mkdirSync(cwd, { recursive: true });
  try {
    const calls: string[][] = [];
    const git: Git = (args) => {
      calls.push(args);
      return args[1] === "--show-toplevel" ? repo : null;
    };
    const realCwd = realpathSync(cwd);
    assert.deepEqual(resolveProject(cwd, git), { root: realCwd, key: realCwd });
    assert.equal(calls.length, 3);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("relative common-dir output resolves against cwd before finding the key", () => {
  const cwd = tempDir();
  try {
    const realCwd = realpathSync(cwd);
    const git: Git = (args) => args[1] === "--show-toplevel" ? realCwd : ".git";
    assert.deepEqual(resolveProject(cwd, git), { root: realCwd, key: realCwd });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plain common-dir fallback is resolved against the physical cwd", () => {
  const temp = tempDir();
  try {
    const repo = join(temp, "repo");
    const nested = join(repo, "nested");
    const link = join(temp, "link");
    mkdirSync(nested, { recursive: true });
    symlinkSync(nested, link);
    const git: Git = (args) => {
      if (args[1] === "--show-toplevel") return repo;
      if (args[1] === "--path-format=absolute") return null;
      return "../.git";
    };

    const linkedProject = resolveProject(link, git);
    assert.equal(linkedProject.root, realpathSync(repo));
    assert.equal(linkedProject.key, realpathSync(repo));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("symlinked repository subdirectory resolves absolute common dir correctly", () => {
  const temp = tempDir();
  try {
    const repo = join(temp, "repo");
    const nested = join(repo, "nested");
    const link = join(temp, "link");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    symlinkSync(nested, link);

    const linkedProject = resolveProject(link, runGit);
    const repoProject = resolveProject(repo, runGit);
    assert.equal(linkedProject.key, repoProject.key);
    assert.equal(linkedProject.root, realpathSync(repo));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
