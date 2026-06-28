import type { Database } from "sql.js"

import { redactAndTruncate } from "../shared/redaction.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapAuditEntry } from "./sqlite-mappers.js"
import { type SqlParams, selectRows } from "./sqlite-rows.js"
import type { AuditEntryInput, AuditEntryRecord } from "./types.js"

const auditDetailsMaxLength = 2048

export const insertAuditEntry = (db: Database, input: AuditEntryInput): AuditEntryRecord => {
  const auditId = makeSqliteId("audit")
  const details = redactAndTruncate(input.details, auditDetailsMaxLength)
  const params: SqlParams = {
    ":auditId": auditId,
    ":actor": input.actor,
    ":action": input.action,
    ":occurredAt": input.occurredAt,
    ":configHash": input.configHash,
    ":jobId": input.jobId ?? null,
    ":stateFrom": input.stateFrom ?? null,
    ":stateTo": input.stateTo ?? null,
    ":details": details,
  }
  db.run(
    `INSERT INTO audit_log (
      audit_id, actor, action, occurred_at, config_hash, job_id, state_from, state_to, details
    ) VALUES (
      :auditId, :actor, :action, :occurredAt, :configHash, :jobId, :stateFrom, :stateTo, :details
    )`,
    params,
  )
  return {
    auditId,
    actor: input.actor,
    action: input.action,
    occurredAt: input.occurredAt,
    configHash: input.configHash,
    jobId: input.jobId ?? null,
    stateFrom: input.stateFrom ?? null,
    stateTo: input.stateTo ?? null,
    details,
  }
}

export const listAuditEntries = (db: Database): readonly AuditEntryRecord[] =>
  selectRows(
    db,
    `SELECT audit_id, actor, action, occurred_at, config_hash, job_id, state_from, state_to, details
     FROM audit_log
     ORDER BY occurred_at ASC, audit_id ASC`,
  ).map(mapAuditEntry)
