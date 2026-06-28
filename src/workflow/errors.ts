export class WorkflowPolicyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "WorkflowPolicyError"
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
