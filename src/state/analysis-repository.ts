import type { Database } from "sql.js"

import { redactAndTruncate } from "../shared/redaction.js"
import { transaction } from "./sqlite-database.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapAnalysisSummary } from "./sqlite-mappers.js"
import { selectOne } from "./sqlite-rows.js"
import type { AnalysisSummaryInput, AnalysisSummaryRecord } from "./types.js"

const analysisSummaryMaxLength = 2048

export const saveAnalysisSummary = (
  db: Database,
  path: string,
  input: AnalysisSummaryInput,
): AnalysisSummaryRecord =>
  transaction(db, path, () => {
    const summaryId = makeSqliteId("summary")
    const summaryMarkdown = redactAndTruncate(input.summaryMarkdown, analysisSummaryMaxLength)
    db.run(
      `INSERT INTO analysis_summaries (
        summary_id, incident_id, job_id, summary_markdown, created_at
      ) VALUES (
        :summaryId, :incidentId, :jobId, :summaryMarkdown, :createdAt
      )`,
      {
        ":summaryId": summaryId,
        ":incidentId": input.incidentId,
        ":jobId": input.jobId,
        ":summaryMarkdown": summaryMarkdown,
        ":createdAt": input.createdAt,
      },
    )
    return { ...input, summaryId, summaryMarkdown }
  })

export const getLatestAnalysisSummary = (
  db: Database,
  incidentId: string,
): AnalysisSummaryRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT summary_id, incident_id, job_id, summary_markdown, created_at
     FROM analysis_summaries
     WHERE incident_id = :incidentId
     ORDER BY created_at DESC, summary_id DESC
     LIMIT 1`,
    { ":incidentId": incidentId },
  )
  return row === undefined ? undefined : mapAnalysisSummary(row)
}
