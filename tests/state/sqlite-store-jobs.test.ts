import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openSqliteStateStore, StateStoreConstraintError } from "../../src/state/sqlite-store.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-state-jobs-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("SQLite state store job claims", () => {
  it("claims Slack actions idempotently and enforces one active job per incident", () => {
    // Given: one incident already exists.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const incident = store.upsertIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })

    // When: a Slack action is claimed twice and a second action tries to start another job.
    const firstClaim = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:05:00.000Z",
    })
    const duplicateClaim = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:05:01.000Z",
    })
    const secondActiveJob = (): unknown =>
      store.claimJobForSlackAction({
        incidentId: incident.incidentId,
        actionIdempotencyKey: "slack-action-2",
        jobKind: "fix",
        actor: "slack:U123",
        now: "2026-06-26T00:05:02.000Z",
      })

    // Then: duplicate action returns the original job and active-job races are rejected.
    expect(firstClaim.claimStatus).toBe("claimed")
    expect(duplicateClaim).toMatchObject({
      actionIdempotencyKey: firstClaim.actionIdempotencyKey,
      incidentId: firstClaim.incidentId,
      jobId: firstClaim.jobId,
      jobKind: firstClaim.jobKind,
      state: firstClaim.state,
      claimStatus: "duplicate",
    })
    expect(secondActiveJob).toThrow(StateStoreConstraintError)
    store.close()
  })

  it("allows retrying the same Slack action after a failed job", () => {
    // Given: a Slack action created a job that reached a failed terminal state.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const incident = store.upsertIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })
    const firstClaim = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:05:00.000Z",
    })
    store.completeJob({
      jobId: firstClaim.jobId,
      state: "failed",
      finishedAt: "2026-06-26T00:06:00.000Z",
    })

    // When: the same Slack action is submitted again after the operator fixed the blocker.
    const retryClaim = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:07:00.000Z",
    })
    store.completeJob({
      jobId: retryClaim.jobId,
      state: "completed",
      finishedAt: "2026-06-26T00:08:00.000Z",
    })
    const duplicateAfterSuccess = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:09:00.000Z",
    })

    // Then: failed jobs do not poison the action key, but successful retry stays idempotent.
    expect(retryClaim).toMatchObject({
      claimStatus: "claimed",
      incidentId: firstClaim.incidentId,
      jobKind: firstClaim.jobKind,
      state: "running",
    })
    expect(retryClaim.jobId).not.toBe(firstClaim.jobId)
    expect(retryClaim.actionIdempotencyKey).toContain("slack-action-1")
    expect(retryClaim.actionIdempotencyKey).not.toBe(firstClaim.actionIdempotencyKey)
    expect(duplicateAfterSuccess).toMatchObject({
      claimStatus: "duplicate",
      jobId: retryClaim.jobId,
      state: "completed",
    })
    store.close()
  })

  it("holds a global concurrency lease until terminal job state releases it", () => {
    // Given: two incidents compete for the default single global worker lease.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const firstIncident = store.upsertIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })
    const secondIncident = store.upsertIncident({
      issueId: "SENTRY-456",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000200",
      title: "Profile crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })
    const firstJob = store.claimJobForSlackAction({
      incidentId: firstIncident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "analysis",
      actor: "slack:U123",
      now: "2026-06-26T00:05:00.000Z",
    })

    // When: another incident attempts to claim a job before and after the first job completes.
    const blockedByGlobalLease = (): unknown =>
      store.claimJobForSlackAction({
        incidentId: secondIncident.incidentId,
        actionIdempotencyKey: "slack-action-2",
        jobKind: "analysis",
        actor: "slack:U234",
        now: "2026-06-26T00:05:01.000Z",
      })
    expect(blockedByGlobalLease).toThrow(StateStoreConstraintError)
    store.completeJob({
      jobId: firstJob.jobId,
      state: "completed",
      finishedAt: "2026-06-26T00:06:00.000Z",
    })
    const secondJob = store.claimJobForSlackAction({
      incidentId: secondIncident.incidentId,
      actionIdempotencyKey: "slack-action-2",
      jobKind: "analysis",
      actor: "slack:U234",
      now: "2026-06-26T00:06:01.000Z",
    })

    // Then: the lease rejects overlap but terminal state frees capacity.
    expect(secondJob.jobId).not.toBe(firstJob.jobId)
    expect(secondJob.claimStatus).toBe("claimed")
    store.close()
  })

  it("abandons active jobs so daemon restart can accept a retry", () => {
    // Given: a previous daemon left a running job and global lease behind.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const incident = store.upsertIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })
    const abandonedJob = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "fix",
      actor: "slack:U123",
      now: "2026-06-26T00:05:00.000Z",
    })

    // When: daemon startup marks active jobs as abandoned.
    const recoveredJobs = store.abandonActiveJobs({
      actor: "daemon",
      details: "startup recovery",
      finishedAt: "2026-06-26T00:06:00.000Z",
      state: "failed",
    })
    const retryJob = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "fix",
      actor: "slack:U123",
      now: "2026-06-26T00:07:00.000Z",
    })
    const auditEntries = store.listAuditEntries()

    // Then: the stale lease is gone and the same Slack action can start a retry job.
    expect(recoveredJobs).toEqual([expect.objectContaining({ jobId: abandonedJob.jobId })])
    expect(retryJob.claimStatus).toBe("claimed")
    expect(retryJob.jobId).not.toBe(abandonedJob.jobId)
    expect(retryJob.actionIdempotencyKey).toContain("slack-action-1#retry#")
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "job.abandoned",
        jobId: abandonedJob.jobId,
        stateFrom: "running",
        stateTo: "failed",
      }),
    )
    store.close()
  })
})
