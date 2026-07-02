export class WorkflowPolicyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "WorkflowPolicyError"
  }
}

export class WorkflowDirtySourceError extends Error {
  public constructor(repoPath: string) {
    super(`source repository is dirty before analysis: ${repoPath}`)
    this.name = "WorkflowDirtySourceError"
  }
}

export class WorkflowSentryContextError extends Error {
  public constructor(issueId: string) {
    super(`Sentry issue context fetch failed for ${issueId}`)
    this.name = "WorkflowSentryContextError"
  }
}

export class WorkflowVerificationFailedError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "WorkflowVerificationFailedError"
  }
}
