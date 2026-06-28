export type RunnerModeName = "analysis_only" | "fix_and_mr"

export type RunnerCommandDefinition = {
  readonly args: readonly string[]
  readonly command: string
  readonly id: string
  readonly type: "generic"
}

export type RunnerIncidentContext = {
  readonly events?: readonly Readonly<Record<string, unknown>>[]
  readonly issueId: string
  readonly title?: string
  readonly trustBoundary: "untrusted_external_sentry"
}

export type RunnerProcessInvocation = {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outputLimitBytes: number
  readonly secretRedactionValues?: readonly string[]
  readonly stdin?: string
  readonly timeoutMs: number
}

export type RunnerProcessResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export interface RunnerProcess {
  run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult>
}

export interface RunnerCleanChecker {
  isClean(worktreePath: string): Promise<boolean>
}

export type RunnerRequest = {
  readonly allowedCommands?: readonly string[]
  readonly incidentContext: RunnerIncidentContext
  readonly mode: RunnerModeName
  readonly repositoryConstraints: string
  readonly worktreePath: string
}

export type GenericRunnerRequest = RunnerRequest & {
  readonly commandId: string
}

export type RunnerResult = {
  readonly analysis: string
  readonly branchInfo?: string
  readonly changesSummary?: string
  readonly command: string
  readonly mode: RunnerModeName
  readonly mrReadiness?: string
  readonly stderr: string
  readonly stdout: string
  readonly verificationResults?: string
}

export interface RunnerAdapter<TRequest extends RunnerRequest = RunnerRequest> {
  run(request: TRequest): Promise<RunnerResult>
}
