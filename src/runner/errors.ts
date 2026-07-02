export class RunnerPolicyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "RunnerPolicyError"
  }
}

export class RunnerWorkspacePathError extends RunnerPolicyError {
  public constructor() {
    super("RunnerRequest must include exactly one of workspacePath or legacy worktreePath")
    this.name = "RunnerWorkspacePathError"
  }
}

export class RunnerTimeoutError extends Error {
  public constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`${command} timed out after ${timeoutMs}ms`)
    this.name = "RunnerTimeoutError"
  }
}

export class RunnerProcessError extends Error {
  public constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}`)
    this.name = "RunnerProcessError"
  }
}

export class RunnerDirtyWorktreeError extends Error {
  public constructor(
    public readonly workspacePath: string,
    public readonly failedProcess?: {
      readonly command: string
      readonly exitCode: number
    },
    public readonly dirtyStatus?: string,
  ) {
    const failureDetail =
      failedProcess === undefined
        ? ""
        : ` after ${failedProcess.command} exited with code ${failedProcess.exitCode}`
    const statusDetail = dirtyStatus === undefined ? "" : `\nDirty status:\n${dirtyStatus}`
    super(
      `analysis-only runner left dirty workspace${failureDetail}: ${workspacePath}${statusDetail}`,
    )
    this.name = "RunnerDirtyWorktreeError"
  }
}

export class RunnerOutputParseError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "RunnerOutputParseError"
  }
}
