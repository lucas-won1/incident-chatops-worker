import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  type GitCommandInvocation,
  type GitCommandRunner,
  GitCommandTimeoutError,
  GitWorktreePolicyError,
  LocalGitRepoAdapter,
  SpawnGitCommandRunner,
} from "../../src/repo/local-git.js"

const git = (cwd: string, args: readonly string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
}

const createRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "incident-chatops-git-repo-"))
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.email", "incident-worker@example.test"])
  git(root, ["config", "user.name", "Incident Worker"])
  writeFileSync(path.join(root, "README.md"), "fixture repo\n")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-m", "initial"])
  return root
}

const createAdapter = async (
  repoPath: string,
  worktreeRoot: string,
  runner?: GitCommandRunner,
): Promise<LocalGitRepoAdapter> => {
  const options = {
    allowlist: [await realpath(repoPath)],
    branchPrefix: "incident/",
    worktreeRoot,
  }
  if (runner === undefined) {
    return new LocalGitRepoAdapter(options)
  }
  return new LocalGitRepoAdapter({ ...options, commandRunner: runner })
}

class RecordingRunner implements GitCommandRunner {
  public readonly invocations: GitCommandInvocation[] = []

  public async run(invocation: GitCommandInvocation): Promise<{
    readonly stderr: string
    readonly stdout: string
  }> {
    this.invocations.push(invocation)
    return { stderr: "", stdout: "" }
  }
}

describe("local git worktree adapter", () => {
  it("fails closed when a spawned git command hangs past the timeout", async () => {
    // Given: a fake git executable that accepts argv but never exits.
    const binRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-fake-git-"))
    const fakeGit = path.join(binRoot, "git")
    writeFileSync(fakeGit, "#!/usr/bin/env node\nsetInterval(() => undefined, 1000)\n")
    chmodSync(fakeGit, 0o755)
    const pathEnvKey = "PATH"
    const originalPath = process.env[pathEnvKey]
    process.env[pathEnvKey] = `${binRoot}${path.delimiter}${originalPath ?? ""}`
    const runner = new SpawnGitCommandRunner({ timeoutMs: 25 })

    try {
      // When: the command runner starts a git command that does not terminate.
      const runHungCommand = runner.run({
        args: ["status", "--porcelain=v1"],
        command: "git",
        cwd: binRoot,
      })

      // Then: the runner rejects with a typed timeout error instead of hanging forever.
      await expect(runHungCommand).rejects.toThrow(GitCommandTimeoutError)
    } finally {
      process.env[pathEnvKey] = originalPath
      rmSync(binRoot, { recursive: true, force: true })
    }
  })

  it("creates a branch-prefixed worktree and removes only the created worktree on close", async () => {
    // Given: an allowlisted clean repository and a configured worktree root.
    const repo = createRepo()
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-worktrees-"))
    const adapter = await createAdapter(repo, worktreeRoot)

    // When: a job worktree is opened and then closed.
    const session = await adapter.openWorktree({
      branchName: "incident/SENTRY-123",
      jobId: "job-123",
      repoPath: repo,
    })
    const normalizedWorktreeRoot = await realpath(worktreeRoot)
    const worktreePath = session.worktreePath
    const branchName = session.branchName
    await session.close()

    // Then: the branch uses the configured prefix and the exact worktree path is removed.
    expect(branchName).toBe("incident/SENTRY-123")
    expect(worktreePath.startsWith(normalizedWorktreeRoot)).toBe(true)
    expect(existsSync(worktreePath)).toBe(false)

    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  })

  it("rejects repos outside the allowlist before running git", async () => {
    // Given: an adapter allowlisted for one repository and a different denied repository.
    const allowedRepo = createRepo()
    const deniedRepo = createRepo()
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-worktrees-"))
    const runner = new RecordingRunner()
    const adapter = await createAdapter(allowedRepo, worktreeRoot, runner)

    // When: a caller asks to open a denied repository.
    const openDenied = (): Promise<unknown> =>
      adapter.openWorktree({
        branchName: "incident/SENTRY-123",
        jobId: "job-123",
        repoPath: deniedRepo,
      })

    // Then: the policy error names the allowlist and no git invocation is attempted.
    await expect(openDenied).rejects.toThrow(GitWorktreePolicyError)
    await expect(openDenied).rejects.toThrow(/allowlist/)
    expect(runner.invocations).toEqual([])

    rmSync(allowedRepo, { recursive: true, force: true })
    rmSync(deniedRepo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  })

  it("rejects branch names outside the configured prefix", async () => {
    // Given: an allowlisted repository and branch prefix policy.
    const repo = createRepo()
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-worktrees-"))
    const adapter = await createAdapter(repo, worktreeRoot)

    // When: a caller asks for a branch outside the configured prefix.
    const openUnsafeBranch = (): Promise<unknown> =>
      adapter.openWorktree({
        branchName: "feature/SENTRY-123",
        jobId: "job-123",
        repoPath: repo,
      })

    // Then: the branch is denied before any worktree is created.
    await expect(openUnsafeBranch).rejects.toThrow(/branch prefix/)

    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  })

  it("rejects dirty repositories and dirty job worktrees", async () => {
    // Given: an allowlisted repository with uncommitted changes.
    const repo = createRepo()
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-worktrees-"))
    const adapter = await createAdapter(repo, worktreeRoot)
    await writeFile(path.join(repo, "dirty.txt"), "dirty\n")

    // When / Then: opening a worktree fails closed while the source repo is dirty.
    await expect(
      adapter.openWorktree({
        branchName: "incident/SENTRY-123",
        jobId: "job-123",
        repoPath: repo,
      }),
    ).rejects.toThrow(/clean/)

    // Given: the source repository is cleaned and a job worktree is open.
    rmSync(path.join(repo, "dirty.txt"))
    const session = await adapter.openWorktree({
      branchName: "incident/SENTRY-124",
      jobId: "job-124",
      repoPath: repo,
    })
    await writeFile(path.join(session.worktreePath, "dirty.txt"), "dirty\n")

    // When / Then: explicit clean checks catch dirty runner output.
    await expect(session.checkClean()).rejects.toThrow(/dirty/)
    await session.close()

    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  })

  it("pushes the branch with explicit git argv and no shell command string", async () => {
    // Given: a worktree session using an injected git command runner.
    const repo = createRepo()
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "incident-chatops-worktrees-"))
    const runner = new RecordingRunner()
    const adapter = await createAdapter(repo, worktreeRoot, runner)

    // When: the branch is pushed for MR flow.
    await adapter.pushBranch({
      branchName: "incident/SENTRY-123",
      remote: "origin",
      repoPath: repo,
    })

    // Then: git receives an executable plus argument array, never a shell-interpolated string.
    expect(runner.invocations).toEqual([
      {
        args: ["push", "origin", "incident/SENTRY-123"],
        command: "git",
        cwd: await realpath(repo),
      },
    ])

    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreeRoot, { recursive: true, force: true })
  })
})
