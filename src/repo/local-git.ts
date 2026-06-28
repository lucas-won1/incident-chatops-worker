import { spawn } from "node:child_process"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"

export type GitCommandInvocation = {
  readonly args: readonly string[]
  readonly command: "git"
  readonly cwd: string
}

export type GitCommandResult = {
  readonly stderr: string
  readonly stdout: string
}

export interface GitCommandRunner {
  run(invocation: GitCommandInvocation): Promise<GitCommandResult>
}

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

export class GitCommandError extends Error {
  public readonly invocation: GitCommandInvocation
  public readonly stderr: string

  public constructor(invocation: GitCommandInvocation, stderr: string) {
    super(`git ${invocation.args.join(" ")} failed: ${stderr}`)
    this.name = "GitCommandError"
    this.invocation = invocation
    this.stderr = stderr
  }
}

export class GitCommandTimeoutError extends Error {
  public constructor(
    public readonly invocation: GitCommandInvocation,
    public readonly timeoutMs: number,
  ) {
    super(`git ${invocation.args.join(" ")} timed out after ${timeoutMs}ms`)
    this.name = "GitCommandTimeoutError"
  }
}

const defaultGitCommandTimeoutMs = 60_000

export class SpawnGitCommandRunner implements GitCommandRunner {
  readonly #timeoutMs: number

  public constructor(options: { readonly timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? defaultGitCommandTimeoutMs
  }

  public async run(invocation: GitCommandInvocation): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let timedOut = false
      let settled = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, this.#timeoutMs)

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(error)
      }

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
      child.on("error", rejectOnce)
      child.on("close", (code) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        const stdout = Buffer.concat(stdoutChunks).toString("utf8")
        const stderr = Buffer.concat(stderrChunks).toString("utf8")
        if (timedOut) {
          reject(new GitCommandTimeoutError(invocation, this.#timeoutMs))
          return
        }
        if (code === 0) {
          resolve({ stderr, stdout })
          return
        }
        reject(new GitCommandError(invocation, stderr.trim()))
      })
    })
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

    await this.#runner.run({
      args: ["worktree", "add", "-b", request.branchName, worktreePath, "HEAD"],
      command: "git",
      cwd: repoPath,
    })

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

  async #prepareWorktreeRoot(): Promise<string> {
    await mkdir(this.#worktreeRoot, { recursive: true })
    return normalizeExistingPath(this.#worktreeRoot)
  }

  async #ensureClean(cwd: string, label: string): Promise<void> {
    const result = await this.#runner.run({
      args: ["status", "--porcelain=v1"],
      command: "git",
      cwd,
    })
    if (result.stdout.trim().length > 0) {
      throw new GitWorktreeDirtyError(`${label} must be clean before opening a worktree`)
    }
  }
}
