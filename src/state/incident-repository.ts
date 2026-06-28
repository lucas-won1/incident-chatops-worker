import type { Database } from "sql.js"

import { transaction } from "./sqlite-database.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapIncident } from "./sqlite-mappers.js"
import { selectOne } from "./sqlite-rows.js"
import type {
  IncidentInput,
  IncidentRecord,
  IncidentThreadInput,
  IncidentUpsertResult,
  IncidentWorkflowStateInput,
} from "./types.js"

export const getIncidentByIssueId = (db: Database, issueId: string): IncidentRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT incident_id, sentry_issue_id, repo_id, slack_channel_id, slack_thread_ts,
      title, workflow_state, first_seen_at, last_seen_at
     FROM incidents
     WHERE sentry_issue_id = :issueId`,
    { ":issueId": issueId },
  )
  return row === undefined ? undefined : mapIncident(row)
}

export const upsertIncident = (
  db: Database,
  path: string,
  input: IncidentInput,
): IncidentUpsertResult =>
  transaction(db, path, () => {
    const existing = getIncidentByIssueId(db, input.issueId)
    if (existing !== undefined) {
      db.run(
        `UPDATE incidents
         SET title = :title, last_seen_at = :lastSeenAt, updated_at = :updatedAt
         WHERE incident_id = :incidentId`,
        {
          ":title": input.title,
          ":lastSeenAt": input.lastSeenAt,
          ":updatedAt": input.lastSeenAt,
          ":incidentId": existing.incidentId,
        },
      )
      return { incidentId: existing.incidentId, created: false }
    }

    const incidentId = makeSqliteId("incident")
    db.run(
      `INSERT INTO incidents (
        incident_id, sentry_issue_id, repo_id, slack_channel_id, slack_thread_ts,
        title, workflow_state, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (
        :incidentId, :issueId, :repoId, :channelId, :threadTs,
        :title, 'detected', :firstSeenAt, :lastSeenAt, :firstSeenAt, :lastSeenAt
      )`,
      {
        ":incidentId": incidentId,
        ":issueId": input.issueId,
        ":repoId": input.repoId,
        ":channelId": input.channelId,
        ":threadTs": input.threadTs,
        ":title": input.title,
        ":firstSeenAt": input.firstSeenAt,
        ":lastSeenAt": input.lastSeenAt,
      },
    )
    return { incidentId, created: true }
  })

export const updateIncidentWorkflowState = (
  db: Database,
  path: string,
  input: IncidentWorkflowStateInput,
): void => {
  transaction(db, path, () => {
    db.run(
      `UPDATE incidents
       SET workflow_state = :workflowState, updated_at = :updatedAt
       WHERE incident_id = :incidentId`,
      {
        ":workflowState": input.workflowState,
        ":updatedAt": input.updatedAt,
        ":incidentId": input.incidentId,
      },
    )
  })
}

export const updateIncidentThreadTs = (
  db: Database,
  path: string,
  input: IncidentThreadInput,
): void => {
  transaction(db, path, () => {
    db.run(
      `UPDATE incidents
       SET slack_thread_ts = :threadTs, updated_at = :updatedAt
       WHERE incident_id = :incidentId`,
      {
        ":threadTs": input.threadTs,
        ":updatedAt": input.updatedAt,
        ":incidentId": input.incidentId,
      },
    )
  })
}
