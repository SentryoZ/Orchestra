import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 1e8 });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await tryGit(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

async function ensureIdentity(dir: string) {
  if (!(await tryGit(dir, ["config", "user.email"]))) {
    await git(dir, ["config", "user.email", "orchestra@localhost"]);
  }
  if (!(await tryGit(dir, ["config", "user.name"]))) {
    await git(dir, ["config", "user.name", "Orchestra"]);
  }
}

export interface RepoPrep {
  initialized: boolean;
  checkpointed: boolean;
  baseBranch: string;
  notes: string[];
}

/**
 * Make sure `dir` is a git repo with at least one commit and a clean tree, so
 * worktrees can branch from it and merges are safe. Uncommitted work is saved as
 * a checkpoint commit (history is preserved; nothing is lost).
 */
export async function ensureRepo(dir: string): Promise<RepoPrep> {
  const notes: string[] = [];
  let initialized = false;
  let checkpointed = false;

  if (!(await isGitRepo(dir))) {
    await run("git", ["-C", dir, "init", "-q"]);
    initialized = true;
    notes.push(`initialised a new git repository in ${dir}`);
  }

  const head = await tryGit(dir, ["rev-parse", "--verify", "HEAD"]);
  await ensureIdentity(dir);

  if (!head) {
    await git(dir, ["add", "-A"]);
    // A brand-new empty directory has nothing to commit; an empty commit still
    // gives worktrees a base to branch from.
    const staged = await git(dir, ["status", "--porcelain"]);
    await git(dir, ["commit", "-qm", "orchestra: initial commit", ...(staged ? [] : ["--allow-empty"])]);
    checkpointed = true;
    notes.push("created an initial commit so worktrees have a base");
  } else if (await git(dir, ["status", "--porcelain"])) {
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "orchestra: checkpoint before mission"]);
    checkpointed = true;
    notes.push("saved your uncommitted work as a checkpoint commit before starting");
  }

  const baseBranch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { initialized, checkpointed, baseBranch, notes };
}

export async function createWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  from: string,
): Promise<void> {
  await git(repoDir, ["worktree", "add", "-q", "-b", branch, worktreePath, from]);
}

/** Commit everything in the worktree. Returns false when there was nothing to commit. */
export async function commitWorktree(worktreePath: string, message: string): Promise<boolean> {
  await git(worktreePath, ["add", "-A"]);
  const changed = await git(worktreePath, ["status", "--porcelain"]);
  if (!changed) return false;
  await git(worktreePath, ["commit", "-qm", message]);
  return true;
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await tryGit(repoDir, ["worktree", "remove", "--force", worktreePath]);
  // Tidy up the (now empty) per-mission parent directory.
  try {
    const { rmdir } = await import("node:fs/promises");
    await rmdir(path.dirname(worktreePath));
  } catch {
    /* parent still holds other worktrees — leave it */
  }
}

export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  await tryGit(repoDir, ["branch", "-D", branch]);
}

export interface MergeResult {
  merged: boolean;
  conflict: boolean;
  detail: string;
}

/** Merge a task branch into the current branch of `repoDir`. Aborts cleanly on conflict. */
export async function mergeBranch(repoDir: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(repoDir, ["merge", "--no-ff", "-m", message, branch]);
    return { merged: true, conflict: false, detail: `merged ${branch}` };
  } catch (err) {
    const files = await tryGit(repoDir, ["diff", "--name-only", "--diff-filter=U"]);
    await tryGit(repoDir, ["merge", "--abort"]);
    const detail = (err as Error).message.split("\n").slice(0, 3).join(" ").slice(0, 400);
    return {
      merged: false,
      conflict: true,
      detail: `merge conflict in ${files || "unknown files"}: ${detail}`,
    };
  }
}
