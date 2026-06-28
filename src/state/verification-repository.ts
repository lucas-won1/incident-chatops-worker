import type { Database } from "sql.js"

import { redactAndTruncate } from "../shared/redaction.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapVerificationSummary } from "./sqlite-mappers.js"
import { selectOne } from "./sqlite-rows.js"
import type { VerificationSummaryInput, VerificationSummaryRecord } from "./types.js"

const verificationSummaryMaxLength = 2048

export const saveVerificationSummary = (
  db: Database,
  input: VerificationSummaryInput,
): VerificationSummaryRecord => {
  const verificationId = makeSqliteId("verification")
  const summaryMarkdown = redactAndTruncate(input.summaryMarkdown, verificationSummaryMaxLength)
  db.run(
    `INSERT INTO verification_summaries (
      verification_id, incident_id, job_id, status, summary_markdown, created_at
    ) VALUES (
      :verificationId, :incidentId, :jobId, :status, :summaryMarkdown, :createdAt
    )`,
    {
      ":createdAt": input.createdAt,
      ":incidentId": input.incidentId,
      ":jobId": input.jobId,
      ":status": input.status,
      ":summaryMarkdown": summaryMarkdown,
      ":verificationId": verificationId,
    },
  )
  return { ...input, summaryMarkdown, verificationId }
}

export const getLatestVerificationSummary = (
  db: Database,
  incidentId: string,
): VerificationSummaryRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT verification_id, incident_id, job_id, status, summary_markdown, created_at
     FROM verification_summaries
     WHERE incident_id = :incidentId
     ORDER BY created_at DESC, verification_id DESC
     LIMIT 1`,
    { ":incidentId": incidentId },
  )
  return row === undefined ? undefined : mapVerificationSummary(row)
}
