export type OpenSqliteStateStoreOptions = {
  readonly path: string
  readonly accessMode?: "read" | "write"
  readonly createIfMissing?: boolean
}

export type IncidentInput = {
  readonly issueId: string
  readonly repoId: string
  readonly channelId: string
  readonly threadTs: string
  readonly title: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export type IncidentUpsertResult = {
  readonly incidentId: string
  readonly created: boolean
}

export type IncidentRecord = {
  readonly incidentId: string
  readonly issueId: string
  readonly repoId: string
  readonly channelId: string
  readonly threadTs: string
  readonly title: string
  readonly workflowState: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export type IncidentWorkflowStateInput = {
  readonly incidentId: string
  readonly workflowState: string
  readonly updatedAt: string
}

export type IncidentThreadInput = {
  readonly incidentId: string
  readonly threadTs: string
  readonly updatedAt: string
}

export type AnalysisSummaryInput = {
  readonly incidentId: string
  readonly jobId: string
  readonly summaryMarkdown: string
  readonly createdAt: string
}

export type AnalysisSummaryRecord = AnalysisSummaryInput & {
  readonly summaryId: string
}

export type SentryIssueSnapshotInput = {
  readonly capturedAt: string
  readonly incidentId: string
  readonly issueId: string
  readonly snapshotJson: string
}

export type SentryIssueSnapshotRecord = SentryIssueSnapshotInput & {
  readonly snapshotId: string
}

export type VerificationStatus = "passed" | "failed" | "missing"

export type VerificationSummaryInput = {
  readonly createdAt: string
  readonly incidentId: string
  readonly jobId: string
  readonly status: VerificationStatus
  readonly summaryMarkdown: string
}

export type VerificationSummaryRecord = VerificationSummaryInput & {
  readonly verificationId: string
}

export type MrLinkInput = {
  readonly incidentId: string
  readonly jobId: string
  readonly provider: string
  readonly url: string
  readonly createdAt: string
}

export type IncidentHandoffInput = {
  readonly incidentId: string
  readonly issueId: string
  readonly repoId: string
  readonly repoPath: string
  readonly jobId: string
  readonly provider: string
  readonly mrUrl: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly headSha: string
  readonly analysisSummary: string
  readonly changesSummary: string
  readonly verificationSummary: string
  readonly mrReadiness: string
  readonly createdAt: string
  readonly followUpPrompt: string
}

export type IncidentHandoffRecord = IncidentHandoffInput & {
  readonly handoffId: string
}

export type ApprovalInput = {
  readonly incidentId: string
  readonly jobId: string
  readonly actionIdempotencyKey: string
  readonly actor: string
  readonly decision: string
  readonly createdAt: string
}

export type JobKind = "analysis" | "fix"
export type ActiveJobState = "queued" | "running"
export type TerminalJobState = "completed" | "failed" | "canceled"
export type JobState = ActiveJobState | TerminalJobState
export type JobClaimStatus = "claimed" | "duplicate"

export type JobClaimInput = {
  readonly incidentId: string
  readonly actionIdempotencyKey: string
  readonly jobKind: JobKind
  readonly actor: string
  readonly now: string
}

export type JobClaimRecord = {
  readonly jobId: string
  readonly incidentId: string
  readonly actionIdempotencyKey: string
  readonly jobKind: JobKind
  readonly state: JobState
  readonly claimStatus: JobClaimStatus
}

export type CompleteJobInput = {
  readonly jobId: string
  readonly state: TerminalJobState
  readonly finishedAt: string
}

export type AbandonActiveJobsInput = {
  readonly actor: string
  readonly details: string
  readonly finishedAt: string
  readonly state: TerminalJobState
}

export type AuditEntryInput = {
  readonly actor: string
  readonly action: string
  readonly occurredAt: string
  readonly configHash: string
  readonly jobId?: string
  readonly stateFrom?: string
  readonly stateTo?: string
  readonly details: string
}

export type AuditEntryRecord = {
  readonly auditId: string
  readonly actor: string
  readonly action: string
  readonly occurredAt: string
  readonly configHash: string
  readonly jobId: string | null
  readonly stateFrom: string | null
  readonly stateTo: string | null
  readonly details: string
}
