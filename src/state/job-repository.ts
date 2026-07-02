import type { Database } from "sql.js"
import { insertApproval } from "./approval-repository.js"
import { insertAuditEntry } from "./audit-repository.js"
import { StateStoreConstraintError } from "./errors.js"
import { transaction } from "./sqlite-database.js"
import { makeSqliteId } from "./sqlite-ids.js"
import { mapJobClaim } from "./sqlite-mappers.js"
import { requiredNumber, requiredString, selectOne, selectRows } from "./sqlite-rows.js"
import type {
  AbandonActiveJobsInput,
  CompleteJobInput,
  JobClaimInput,
  JobClaimRecord,
} from "./types.js"

const globalLeaseName = "default"

const retryActionKeyPrefix = (actionIdempotencyKey: string): string =>
  `${actionIdempotencyKey}#retry#`

const findLatestJobByActionKeyFamily = (
  db: Database,
  actionIdempotencyKey: string,
): JobClaimRecord | undefined => {
  const retryPrefix = retryActionKeyPrefix(actionIdempotencyKey)
  const row = selectOne(
    db,
    `SELECT job_id, incident_id, kind, state, action_idempotency_key
     FROM jobs
     WHERE action_idempotency_key = :actionKey
       OR substr(action_idempotency_key, 1, :retryPrefixLength) = :retryPrefix
     ORDER BY claimed_at DESC, job_id DESC
     LIMIT 1`,
    {
      ":actionKey": actionIdempotencyKey,
      ":retryPrefix": retryPrefix,
      ":retryPrefixLength": retryPrefix.length,
    },
  )
  return row === undefined ? undefined : mapJobClaim(row, "duplicate")
}

const countJobsByActionKeyFamily = (db: Database, actionIdempotencyKey: string): number => {
  const retryPrefix = retryActionKeyPrefix(actionIdempotencyKey)
  const row = selectOne(
    db,
    `SELECT COUNT(*) AS job_count
     FROM jobs
     WHERE action_idempotency_key = :actionKey
       OR substr(action_idempotency_key, 1, :retryPrefixLength) = :retryPrefix`,
    {
      ":actionKey": actionIdempotencyKey,
      ":retryPrefix": retryPrefix,
      ":retryPrefixLength": retryPrefix.length,
    },
  )
  return row === undefined ? 0 : requiredNumber(row, "job_count")
}

const retryableJobState = (state: JobClaimRecord["state"]): boolean =>
  state === "failed" || state === "canceled"

const claimActionIdempotencyKey = (
  db: Database,
  input: JobClaimInput,
  existing: JobClaimRecord | undefined,
): string | undefined => {
  if (existing === undefined) {
    return input.actionIdempotencyKey
  }
  if (!retryableJobState(existing.state)) {
    return undefined
  }
  return `${retryActionKeyPrefix(input.actionIdempotencyKey)}${countJobsByActionKeyFamily(
    db,
    input.actionIdempotencyKey,
  )}`
}

const findActiveJobForIncident = (db: Database, incidentId: string): JobClaimRecord | undefined => {
  const row = selectOne(
    db,
    `SELECT job_id, incident_id, kind, state, action_idempotency_key
     FROM jobs
     WHERE incident_id = :incidentId AND state IN ('queued', 'running')
     LIMIT 1`,
    { ":incidentId": incidentId },
  )
  return row === undefined ? undefined : mapJobClaim(row, "duplicate")
}

const findActiveJobs = (db: Database): readonly JobClaimRecord[] =>
  selectRows(
    db,
    `SELECT job_id, incident_id, kind, state, action_idempotency_key
     FROM jobs
     WHERE state IN ('queued', 'running')
     ORDER BY claimed_at ASC, job_id ASC`,
  ).map((row) => mapJobClaim(row, "duplicate"))

const globalLeaseOwner = (db: Database): string | undefined => {
  const row = selectOne(db, "SELECT job_id FROM global_concurrency_leases WHERE name = :name", {
    ":name": globalLeaseName,
  })
  return row === undefined ? undefined : requiredString(row, "job_id")
}

export const claimJobForSlackAction = (
  db: Database,
  path: string,
  input: JobClaimInput,
): JobClaimRecord =>
  transaction(db, path, () => {
    const existing = findLatestJobByActionKeyFamily(db, input.actionIdempotencyKey)
    const actionIdempotencyKey = claimActionIdempotencyKey(db, input, existing)
    if (actionIdempotencyKey === undefined && existing !== undefined) {
      return existing
    }
    if (actionIdempotencyKey === undefined) {
      throw new StateStoreConstraintError(
        "jobs.action_idempotency_key",
        "Unable to allocate a Slack action idempotency key",
      )
    }
    if (findActiveJobForIncident(db, input.incidentId) !== undefined) {
      throw new StateStoreConstraintError(
        "jobs_one_active_per_incident",
        `Incident already has an active job: ${input.incidentId}`,
      )
    }
    if (globalLeaseOwner(db) !== undefined) {
      throw new StateStoreConstraintError(
        "global_concurrency_leases",
        "Global job concurrency lease is already held",
      )
    }

    const jobId = makeSqliteId("job")
    db.run(
      `INSERT INTO jobs (
        job_id, incident_id, kind, state, action_idempotency_key, actor, claimed_at
      ) VALUES (
        :jobId, :incidentId, :kind, 'running', :actionKey, :actor, :claimedAt
      )`,
      {
        ":jobId": jobId,
        ":incidentId": input.incidentId,
        ":kind": input.jobKind,
        ":actionKey": actionIdempotencyKey,
        ":actor": input.actor,
        ":claimedAt": input.now,
      },
    )
    insertApproval(db, {
      incidentId: input.incidentId,
      jobId,
      actionIdempotencyKey,
      actor: input.actor,
      decision: input.jobKind,
      createdAt: input.now,
    })
    db.run(
      `INSERT INTO global_concurrency_leases (name, job_id, acquired_at)
       VALUES (:name, :jobId, :acquiredAt)`,
      { ":name": globalLeaseName, ":jobId": jobId, ":acquiredAt": input.now },
    )
    insertAuditEntry(db, {
      actor: input.actor,
      action: "job.claimed",
      occurredAt: input.now,
      configHash: "unknown",
      jobId,
      stateFrom: "none",
      stateTo: "running",
      details: `claimed ${input.jobKind} job for incident ${input.incidentId}`,
    })
    return {
      jobId,
      incidentId: input.incidentId,
      actionIdempotencyKey,
      jobKind: input.jobKind,
      state: "running",
      claimStatus: "claimed",
    }
  })

export const completeJob = (db: Database, path: string, input: CompleteJobInput): void => {
  transaction(db, path, () => {
    db.run(
      `UPDATE jobs
       SET state = :state, finished_at = :finishedAt
       WHERE job_id = :jobId`,
      {
        ":state": input.state,
        ":finishedAt": input.finishedAt,
        ":jobId": input.jobId,
      },
    )
    db.run("DELETE FROM global_concurrency_leases WHERE job_id = :jobId", {
      ":jobId": input.jobId,
    })
    insertAuditEntry(db, {
      actor: "worker",
      action: "job.terminal",
      occurredAt: input.finishedAt,
      configHash: "unknown",
      jobId: input.jobId,
      stateFrom: "running",
      stateTo: input.state,
      details: `job ${input.jobId} moved to ${input.state}`,
    })
  })
}

export const abandonActiveJobs = (
  db: Database,
  path: string,
  input: AbandonActiveJobsInput,
): readonly JobClaimRecord[] =>
  transaction(db, path, () => {
    const jobs = findActiveJobs(db)
    for (const job of jobs) {
      db.run(
        `UPDATE jobs
         SET state = :state, finished_at = :finishedAt
         WHERE job_id = :jobId AND state IN ('queued', 'running')`,
        {
          ":state": input.state,
          ":finishedAt": input.finishedAt,
          ":jobId": job.jobId,
        },
      )
      db.run("DELETE FROM global_concurrency_leases WHERE job_id = :jobId", {
        ":jobId": job.jobId,
      })
      insertAuditEntry(db, {
        actor: input.actor,
        action: "job.abandoned",
        occurredAt: input.finishedAt,
        configHash: "daemon",
        jobId: job.jobId,
        stateFrom: job.state,
        stateTo: input.state,
        details: input.details,
      })
    }
    return jobs
  })
