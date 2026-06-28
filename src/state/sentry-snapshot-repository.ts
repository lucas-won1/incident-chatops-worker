import type { Database } from "sql.js"

import { redactAndTruncate } from "../shared/redaction.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapSentryIssueSnapshot } from "./sqlite-mappers.js"
import { selectOne } from "./sqlite-rows.js"
import type { SentryIssueSnapshotInput, SentryIssueSnapshotRecord } from "./types.js"

const snapshotMaxLength = 8192

export const saveSentryIssueSnapshot = (
  db: Database,
  input: SentryIssueSnapshotInput,
): SentryIssueSnapshotRecord => {
  const snapshotId = makeSqliteId("sentry_snapshot")
  const snapshotJson = redactAndTruncate(input.snapshotJson, snapshotMaxLength)
  db.run(
    `INSERT INTO sentry_issue_snapshots (
      snapshot_id, incident_id, sentry_issue_id, snapshot_json, captured_at
    ) VALUES (
      :snapshotId, :incidentId, :issueId, :snapshotJson, :capturedAt
    )`,
    {
      ":capturedAt": input.capturedAt,
      ":incidentId": input.incidentId,
      ":issueId": input.issueId,
      ":snapshotId": snapshotId,
      ":snapshotJson": snapshotJson,
    },
  )
  return { ...input, snapshotId, snapshotJson }
}

export const getLatestSentryIssueSnapshot = (
  db: Database,
  incidentId: string,
): SentryIssueSnapshotRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT snapshot_id, incident_id, sentry_issue_id, snapshot_json, captured_at
     FROM sentry_issue_snapshots
     WHERE incident_id = :incidentId
     ORDER BY captured_at DESC, snapshot_id DESC
     LIMIT 1`,
    { ":incidentId": incidentId },
  )
  return row === undefined ? undefined : mapSentryIssueSnapshot(row)
}
