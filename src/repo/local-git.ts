import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { type GitCommandRunner, SpawnGitCommandRunner } from "./git-command-runner.js"
import { parseGitWorktreeList } from "./git-worktree-list.js"

export type {
  GitCommandInvocation,
  GitCommandResult,
  GitCommandRunner,
} from "./git-command-runner.js"
export {
  GitCommandError,
  GitCommandTimeoutError,
  SpawnGitCommandRunner,
} from "./git-command-runner.js"

export type LocalGitRepoAdapterOptions = {
  readonly allowlist: readonly string[]
  readonly branchPrefix: string
  readonly commandRunner?: GitCommandRunner
  readonly worktreeRoot: string
}

export type OpenGitWorktreeRequest = {
  readonly branchName: string
  readonly jobId: string
  readonly repoPath: string
}

export type PushGitBranchRequest = {
  readonly branchName: string
  readonly remote: string
  readonly repoPath: string
}

export type GitDirtyStatusRequest = {
  readonly repoPath: string
}

export type GitCurrentHeadRequest = {
  readonly repoPath: string
}

export class GitWorktreePolicyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "GitWorktreePolicyError"
  }
}

export class GitWorktreeDirtyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "GitWorktreeDirtyError"
  }
}

const safeBranchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const safeJobId = /^[A-Za-z0-9._-]+$/u

const normalizeExistingPath = async (inputPath: string): Promise<string> => realpath(inputPath)

const formatAllowlist = (allowlist: readonly string[]): string => allowlist.join(", ")

const ensureBranchAllowed = (branchName: string, branchPrefix: string): void => {
  if (
    !branchName.startsWith(branchPrefix) ||
    !safeBranchName.test(branchName) ||
    branchName.includes("..") ||
    branchName.includes("//")
  ) {
    throw new GitWorktreePolicyError(`branch prefix denied: expected ${branchPrefix}`)
  }
}

const ensureJobIdSafe = (jobId: string): void => {
  if (!safeJobId.test(jobId) || jobId.includes("..")) {
    throw new GitWorktreePolicyError("job id is unsafe for worktree path")
  }
}

export class GitWorktreeSession {
  public readonly branchName: string
  public readonly repoPath: string
  public readonly worktreePath: string
  readonly #runner: GitCommandRunner
  #closed = false

  public constructor(input: {
    readonly branchName: string
    readonly repoPath: string
    readonly runner: GitCommandRunner
    readonly worktreePath: string
  }) {
    this.branchName = input.branchName
    this.repoPath = input.repoPath
    this.worktreePath = input.worktreePath
    this.#runner = input.runner
  }

  public async checkClean(): Promise<void> {
    const result = await this.#runner.run({
      args: ["status", "--porcelain=v1"],
      command: "git",
      cwd: this.worktreePath,
    })
    if (result.stdout.trim().length > 0) {
      throw new GitWorktreeDirtyError(`worktree is dirty: ${this.worktreePath}`)
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    await this.#runner.run({
      args: ["worktree", "remove", "--force", this.worktreePath],
      command: "git",
      cwd: this.repoPath,
    })
    this.#closed = true
  }
}

export class LocalGitRepoAdapter {
  readonly #allowlist: readonly string[]
  readonly #branchPrefix: string
  readonly #runner: GitCommandRunner
  readonly #worktreeRoot: string

  public constructor(options: LocalGitRepoAdapterOptions) {
    this.#allowlist = options.allowlist
    this.#branchPrefix = options.branchPrefix
    this.#runner = options.commandRunner ?? new SpawnGitCommandRunner()
    this.#worktreeRoot = options.worktreeRoot
  }

  public async openWorktree(request: OpenGitWorktreeRequest): Promise<GitWorktreeSession> {
    ensureBranchAllowed(request.branchName, this.#branchPrefix)
    ensureJobIdSafe(request.jobId)
    const repoPath = await this.#resolveAllowedRepo(request.repoPath)
    await this.#ensureClean(repoPath, "repository")
    const worktreeRoot = await this.#prepareWorktreeRoot()
    const worktreePath = path.join(worktreeRoot, request.jobId)
    const existingWorktreePath = await this.#findWorktreePathForBranch(repoPath, request.branchName)

    if (existingWorktreePath === worktreePath) {
      await this.#ensureClean(worktreePath, "worktree")
    } else {
      if (existingWorktreePath !== undefined) {
        throw new GitWorktreePolicyError(
          `branch ${request.branchName} is already checked out at ${existingWorktreePath}`,
        )
      }
      const addArgs = (await this.#branchExists(repoPath, request.branchName))
        ? ["worktree", "add", worktreePath, request.branchName]
        : ["worktree", "add", "-b", request.branchName, worktreePath, "HEAD"]
      await this.#runner.run({
        args: addArgs,
        command: "git",
        cwd: repoPath,
      })
    }

    return new GitWorktreeSession({
      branchName: request.branchName,
      repoPath,
      runner: this.#runner,
      worktreePath,
    })
  }

  public async pushBranch(request: PushGitBranchRequest): Promise<void> {
    ensureBranchAllowed(request.branchName, this.#branchPrefix)
    const repoPath = await this.#resolveAllowedRepo(request.repoPath)
    await this.#runner.run({
      args: ["push", request.remote, request.branchName],
      command: "git",
      cwd: repoPath,
    })
  }

  public async dirtyStatus(request: GitDirtyStatusRequest): Promise<string> {
    const repoPath = await this.#resolveAllowedRepo(request.repoPath)
    return this.#dirtyStatus(repoPath)
  }

  public async currentHead(request: GitCurrentHeadRequest): Promise<string> {
    const repoPath = await this.#resolveAllowedRepoOrWorktree(request.repoPath)
    const result = await this.#runner.run({
      args: ["rev-parse", "HEAD"],
      command: "git",
      cwd: repoPath,
    })
    return result.stdout.trim()
  }

  async #resolveAllowedRepo(repoPath: string): Promise<string> {
    let normalizedRepoPath: string
    try {
      normalizedRepoPath = await normalizeExistingPath(repoPath)
    } catch (error) {
      if (error instanceof Error) {
        throw new GitWorktreePolicyError(
          `repo denied by allowlist: ${path.resolve(repoPath)} not in ${formatAllowlist(
            this.#allowlist,
          )}`,
        )
      }
      throw error
    }

    if (!this.#allowlist.includes(normalizedRepoPath)) {
      throw new GitWorktreePolicyError(
        `repo denied by allowlist: ${normalizedRepoPath} not in ${formatAllowlist(
          this.#allowlist,
        )}`,
      )
    }
    return normalizedRepoPath
  }

  async #resolveAllowedRepoOrWorktree(repoPath: string): Promise<string> {
    const normalizedRepoPath = await normalizeExistingPath(repoPath)
    if (this.#allowlist.includes(normalizedRepoPath)) {
      return normalizedRepoPath
    }

    const normalizedWorktreeRoot = await normalizeExistingPath(this.#worktreeRoot)
    if (
      normalizedRepoPath === normalizedWorktreeRoot ||
      normalizedRepoPath.startsWith(`${normalizedWorktreeRoot}${path.sep}`)
    ) {
      return normalizedRepoPath
    }

    throw new GitWorktreePolicyError(
      `repo denied by allowlist: ${normalizedRepoPath} not in ${formatAllowlist(this.#allowlist)}`,
    )
  }

  async #prepareWorktreeRoot(): Promise<string> {
    await mkdir(this.#worktreeRoot, { recursive: true })
    return normalizeExistingPath(this.#worktreeRoot)
  }

  async #branchExists(repoPath: string, branchName: string): Promise<boolean> {
    const result = await this.#runner.run({
      args: ["branch", "--list", "--format=%(refname:short)", branchName],
      command: "git",
      cwd: repoPath,
    })
    return result.stdout.split("\n").some((line) => line.trim() === branchName)
  }

  async #findWorktreePathForBranch(
    repoPath: string,
    branchName: string,
  ): Promise<string | undefined> {
    const result = await this.#runner.run({
      args: ["worktree", "list", "--porcelain"],
      command: "git",
      cwd: repoPath,
    })
    const match = parseGitWorktreeList(result.stdout).find((entry) => entry.branch === branchName)
    return match?.path
  }

  async #ensureClean(cwd: string, label: string): Promise<void> {
    if ((await this.#dirtyStatus(cwd)).trim().length > 0) {
      throw new GitWorktreeDirtyError(`${label} must be clean before opening a worktree`)
    }
  }

  async #dirtyStatus(cwd: string): Promise<string> {
    const result = await this.#runner.run({
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      command: "git",
      cwd,
    })
    return result.stdout
  }
}
