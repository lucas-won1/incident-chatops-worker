import { StateStoreConstraintError } from "./errors.js"
import { nullableString, requiredString, type SqlRow } from "./sqlite-rows.js"
import type {
  AnalysisSummaryRecord,
  AuditEntryRecord,
  IncidentRecord,
  JobClaimRecord,
  JobClaimStatus,
  JobKind,
  JobState,
  SentryIssueSnapshotRecord,
  VerificationStatus,
  VerificationSummaryRecord,
} from "./types.js"

export const mapIncident = (row: SqlRow): IncidentRecord => ({
  incidentId: requiredString(row, "incident_id"),
  issueId: requiredString(row, "sentry_issue_id"),
  repoId: requiredString(row, "repo_id"),
  channelId: requiredString(row, "slack_channel_id"),
  threadTs: requiredString(row, "slack_thread_ts"),
  title: requiredString(row, "title"),
  workflowState: requiredString(row, "workflow_state"),
  firstSeenAt: requiredString(row, "first_seen_at"),
  lastSeenAt: requiredString(row, "last_seen_at"),
})

export const mapAnalysisSummary = (row: SqlRow): AnalysisSummaryRecord => ({
  summaryId: requiredString(row, "summary_id"),
  incidentId: requiredString(row, "incident_id"),
  jobId: requiredString(row, "job_id"),
  summaryMarkdown: requiredString(row, "summary_markdown"),
  createdAt: requiredString(row, "created_at"),
})

export const mapSentryIssueSnapshot = (row: SqlRow): SentryIssueSnapshotRecord => ({
  capturedAt: requiredString(row, "captured_at"),
  incidentId: requiredString(row, "incident_id"),
  issueId: requiredString(row, "sentry_issue_id"),
  snapshotId: requiredString(row, "snapshot_id"),
  snapshotJson: requiredString(row, "snapshot_json"),
})

const readVerificationStatus = (value: string): VerificationStatus => {
  switch (value) {
    case "failed":
    case "missing":
    case "passed":
      return value
    default:
      throw new StateStoreConstraintError(
        "verification_summaries.status",
        `Unexpected verification status: ${value}`,
      )
  }
}

export const mapVerificationSummary = (row: SqlRow): VerificationSummaryRecord => ({
  createdAt: requiredString(row, "created_at"),
  incidentId: requiredString(row, "incident_id"),
  jobId: requiredString(row, "job_id"),
  status: readVerificationStatus(requiredString(row, "status")),
  summaryMarkdown: requiredString(row, "summary_markdown"),
  verificationId: requiredString(row, "verification_id"),
})

export const mapAuditEntry = (row: SqlRow): AuditEntryRecord => ({
  auditId: requiredString(row, "audit_id"),
  actor: requiredString(row, "actor"),
  action: requiredString(row, "action"),
  occurredAt: requiredString(row, "occurred_at"),
  configHash: requiredString(row, "config_hash"),
  jobId: nullableString(row, "job_id"),
  stateFrom: nullableString(row, "state_from"),
  stateTo: nullableString(row, "state_to"),
  details: requiredString(row, "details"),
})

const readJobKind = (value: string): JobKind => {
  switch (value) {
    case "analysis":
    case "fix":
      return value
    default:
      throw new StateStoreConstraintError("jobs.kind", `Unexpected job kind: ${value}`)
  }
}

const readJobState = (value: string): JobState => {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "canceled":
      return value
    default:
      throw new StateStoreConstraintError("jobs.state", `Unexpected job state: ${value}`)
  }
}

export const mapJobClaim = (row: SqlRow, claimStatus: JobClaimStatus): JobClaimRecord => {
  return {
    jobId: requiredString(row, "job_id"),
    incidentId: requiredString(row, "incident_id"),
    actionIdempotencyKey: requiredString(row, "action_idempotency_key"),
    jobKind: readJobKind(requiredString(row, "kind")),
    state: readJobState(requiredString(row, "state")),
    claimStatus,
  }
}
