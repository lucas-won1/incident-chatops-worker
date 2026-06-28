import type { Database } from "sql.js"

import { makeSqliteId } from "./sqlite-ids.js"
import type { ApprovalInput } from "./types.js"

export const insertApproval = (db: Database, input: ApprovalInput): void => {
  db.run(
    `INSERT INTO approvals (
      approval_id, incident_id, job_id, action_idempotency_key, actor, decision, created_at
    ) VALUES (
      :approvalId, :incidentId, :jobId, :actionKey, :actor, :decision, :createdAt
    )`,
    {
      ":approvalId": makeSqliteId("approval"),
      ":incidentId": input.incidentId,
      ":jobId": input.jobId,
      ":actionKey": input.actionIdempotencyKey,
      ":actor": input.actor,
      ":decision": input.decision,
      ":createdAt": input.createdAt,
    },
  )
}
