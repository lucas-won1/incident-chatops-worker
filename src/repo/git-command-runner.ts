import { spawn } from "node:child_process"

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
