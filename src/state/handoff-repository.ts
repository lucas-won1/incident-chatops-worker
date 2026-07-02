import type { Database } from "sql.js"

import { transaction } from "./sqlite-database.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { requiredString, type SqlRow, selectOne, selectRows } from "./sqlite-rows.js"
import type { IncidentHandoffInput, IncidentHandoffRecord } from "./types.js"

const rowToIncidentHandoff = (row: SqlRow): IncidentHandoffRecord => ({
  analysisSummary: requiredString(row, "analysis_summary"),
  changesSummary: requiredString(row, "changes_summary"),
  createdAt: requiredString(row, "created_at"),
  followUpPrompt: requiredString(row, "follow_up_prompt"),
  handoffId: requiredString(row, "handoff_id"),
  headSha: requiredString(row, "head_sha"),
  incidentId: requiredString(row, "incident_id"),
  issueId: requiredString(row, "sentry_issue_id"),
  jobId: requiredString(row, "job_id"),
  mrReadiness: requiredString(row, "mr_readiness"),
  mrUrl: requiredString(row, "mr_url"),
  provider: requiredString(row, "provider"),
  repoId: requiredString(row, "repo_id"),
  repoPath: requiredString(row, "repo_path"),
  sourceBranch: requiredString(row, "source_branch"),
  targetBranch: requiredString(row, "target_branch"),
  verificationSummary: requiredString(row, "verification_summary"),
})

export const saveIncidentHandoff = (
  db: Database,
  path: string,
  input: IncidentHandoffInput,
): IncidentHandoffRecord =>
  transaction(db, path, () => {
    const handoffId = makeSqliteId("handoff")
    db.run(
      `INSERT INTO incident_handoffs (
        handoff_id, incident_id, sentry_issue_id, repo_id, repo_path, job_id,
        provider, mr_url, source_branch, target_branch, head_sha,
        analysis_summary, changes_summary, verification_summary, mr_readiness,
        created_at, follow_up_prompt
      ) VALUES (
        :handoffId, :incidentId, :issueId, :repoId, :repoPath, :jobId,
        :provider, :mrUrl, :sourceBranch, :targetBranch, :headSha,
        :analysisSummary, :changesSummary, :verificationSummary, :mrReadiness,
        :createdAt, :followUpPrompt
      )`,
      {
        ":analysisSummary": input.analysisSummary,
        ":changesSummary": input.changesSummary,
        ":createdAt": input.createdAt,
        ":followUpPrompt": input.followUpPrompt,
        ":handoffId": handoffId,
        ":headSha": input.headSha,
        ":incidentId": input.incidentId,
        ":issueId": input.issueId,
        ":jobId": input.jobId,
        ":mrReadiness": input.mrReadiness,
        ":mrUrl": input.mrUrl,
        ":provider": input.provider,
        ":repoId": input.repoId,
        ":repoPath": input.repoPath,
        ":sourceBranch": input.sourceBranch,
        ":targetBranch": input.targetBranch,
        ":verificationSummary": input.verificationSummary,
      },
    )
    return { ...input, handoffId }
  })

export const getIncidentHandoffByIssueId = (
  db: Database,
  issueId: string,
): IncidentHandoffRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT
      handoff_id, incident_id, sentry_issue_id, repo_id, repo_path, job_id,
      provider, mr_url, source_branch, target_branch, head_sha,
      analysis_summary, changes_summary, verification_summary, mr_readiness,
      created_at, follow_up_prompt
    FROM incident_handoffs
    WHERE sentry_issue_id = :issueId
    ORDER BY created_at DESC, handoff_id DESC
    LIMIT 1`,
    { ":issueId": issueId },
  )
  return row === undefined ? undefined : rowToIncidentHandoff(row)
}

export const listIncidentHandoffs = (
  db: Database,
  limit: number,
): readonly IncidentHandoffRecord[] =>
  selectRows(
    db,
    `SELECT
      handoff_id, incident_id, sentry_issue_id, repo_id, repo_path, job_id,
      provider, mr_url, source_branch, target_branch, head_sha,
      analysis_summary, changes_summary, verification_summary, mr_readiness,
      created_at, follow_up_prompt
    FROM incident_handoffs
    ORDER BY created_at DESC, handoff_id DESC
    LIMIT :limit`,
    { ":limit": limit },
  ).map(rowToIncidentHandoff)
