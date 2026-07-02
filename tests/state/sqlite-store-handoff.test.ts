import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openSqliteStateStore } from "../../src/state/sqlite-store.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-state-handoff-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("SQLite state store incident handoffs", () => {
  it("persists incident handoff records across reopen and queries them by issue id", () => {
    // Given: a completed fix job has durable incident and job state.
    const dbPath = createTempDbPath()
    const store = openSqliteStateStore({ path: dbPath })
    const incident = store.upsertIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })
    const job = store.claimJobForSlackAction({
      incidentId: incident.incidentId,
      actionIdempotencyKey: "slack-action-1",
      jobKind: "fix",
      actor: "slack:U123",
      now: "2026-06-26T00:05:00.000Z",
    })

    // When: the worker saves a handoff and the database is reopened by a later process.
    store.saveIncidentHandoff({
      analysisSummary: "Root cause: checkout crash.",
      changesSummary: "Patched null guard.",
      createdAt: "2026-06-26T00:08:00.000Z",
      followUpPrompt: "Continue from MR https://gitlab.example/incidents/merge_requests/7.",
      headSha: "abc123def4567890abc123def4567890abc123de",
      incidentId: incident.incidentId,
      issueId: "SENTRY-123",
      jobId: job.jobId,
      mrReadiness: "Ready for review.",
      mrUrl: "https://gitlab.example/incidents/merge_requests/7",
      provider: "gitlab",
      repoId: "repo-api",
      repoPath: "/allowed/repo-api",
      sourceBranch: "incident/SENTRY-123",
      targetBranch: "main",
      verificationSummary: "passed",
    })
    store.close()
    const reopened = openSqliteStateStore({ path: dbPath })

    // Then: the handoff can be read by Sentry issue id after process restart.
    expect(reopened.getIncidentHandoffByIssueId("SENTRY-123")).toMatchObject({
      analysisSummary: "Root cause: checkout crash.",
      changesSummary: "Patched null guard.",
      createdAt: "2026-06-26T00:08:00.000Z",
      headSha: "abc123def4567890abc123def4567890abc123de",
      incidentId: incident.incidentId,
      issueId: "SENTRY-123",
      jobId: job.jobId,
      mrReadiness: "Ready for review.",
      mrUrl: "https://gitlab.example/incidents/merge_requests/7",
      provider: "gitlab",
      repoId: "repo-api",
      repoPath: "/allowed/repo-api",
      sourceBranch: "incident/SENTRY-123",
      targetBranch: "main",
      verificationSummary: "passed",
    })
    expect(reopened.getIncidentHandoffByIssueId("SENTRY-missing")).toBeUndefined()
    reopened.close()
  })
})
