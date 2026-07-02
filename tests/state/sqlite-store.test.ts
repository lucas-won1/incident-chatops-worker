import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openSqliteStateStore } from "../../src/state/sqlite-store.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-state-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("SQLite state store", () => {
  it("deduplicates Sentry issues and can retrieve analysis summaries for fix jobs", () => {
    // Given: a migrated SQLite state store with one detected incident.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const incidentInput = {
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    }

    // When: the same Sentry issue is upserted twice and analysis output is stored.
    const first = store.upsertIncident(incidentInput)
    const second = store.upsertIncident({
      ...incidentInput,
      lastSeenAt: "2026-06-26T00:02:00.000Z",
    })
    store.saveAnalysisSummary({
      incidentId: first.incidentId,
      jobId: "job-analysis-1",
      summaryMarkdown: "Root cause is a null customer id.",
      createdAt: "2026-06-26T00:03:00.000Z",
    })

    // Then: the issue remains one incident and fix flow can fetch the latest summary.
    expect(second.incidentId).toBe(first.incidentId)
    expect(second.created).toBe(false)
    expect(store.getIncidentByIssueId("SENTRY-123")?.lastSeenAt).toBe("2026-06-26T00:02:00.000Z")
    expect(store.getLatestAnalysisSummary(first.incidentId)?.summaryMarkdown).toBe(
      "Root cause is a null customer id.",
    )
    store.close()
  })

  it("runs migrations idempotently and records schema version", () => {
    // Given: a database path that will be opened repeatedly.
    const dbPath = createTempDbPath()

    // When: startup migrations run more than once.
    const first = openSqliteStateStore({ path: dbPath })
    const firstVersion = first.getSchemaVersion()
    first.close()
    const second = openSqliteStateStore({ path: dbPath })

    // Then: the version is stable and no duplicate migration state is created.
    expect(firstVersion).toBeGreaterThan(0)
    expect(second.getSchemaVersion()).toBe(firstVersion)
    second.close()
  })

  it("closes the database when close persistence fails", () => {
    // Given: a migrated writable store whose database path becomes unwritable before close.
    const dbPath = createTempDbPath()
    const store = openSqliteStateStore({ path: dbPath })
    rmSync(dbPath)
    mkdirSync(dbPath)

    // When: close attempts to persist to the invalid database path.
    expect(() => store.close()).toThrow()

    // Then: the underlying sql.js database was still closed after the persist failure.
    expect(() => store.getSchemaVersion()).toThrow()
  })

  it("persists and retrieves Sentry issue snapshots and verification summaries across reopen", () => {
    // Given: a migrated store with one incident from Sentry.
    const dbPath = createTempDbPath()
    const firstStore = openSqliteStateStore({ path: dbPath })
    const incident = firstStore.upsertIncident({
      issueId: "SENTRY-789",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000300",
      title: "Inventory crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })

    // When: Sentry polling and fix verification store their durable summaries.
    firstStore.saveSentryIssueSnapshot({
      capturedAt: "2026-06-26T00:02:00.000Z",
      incidentId: incident.incidentId,
      issueId: "SENTRY-789",
      snapshotJson: JSON.stringify({
        id: "SENTRY-789",
        project: { slug: "repo-api" },
        title: "Inventory crash",
      }),
    })
    firstStore.saveVerificationSummary({
      createdAt: "2026-06-26T00:03:00.000Z",
      incidentId: incident.incidentId,
      jobId: "job-fix-1",
      status: "failed",
      summaryMarkdown: "failed: pnpm test",
    })
    firstStore.close()
    const reopened = openSqliteStateStore({ path: dbPath })

    // Then: both records survive migration startup and are queryable by incident.
    expect(reopened.getLatestSentryIssueSnapshot(incident.incidentId)).toMatchObject({
      incidentId: incident.incidentId,
      issueId: "SENTRY-789",
      snapshotJson: expect.stringContaining("Inventory crash"),
    })
    expect(reopened.getLatestVerificationSummary(incident.incidentId)).toMatchObject({
      incidentId: incident.incidentId,
      jobId: "job-fix-1",
      status: "failed",
      summaryMarkdown: "failed: pnpm test",
    })
    reopened.close()
  })

  it("redacts token-like audit text and truncates raw runner output", () => {
    // Given: a migrated store with sensitive audit state.
    const store = openSqliteStateStore({ path: createTempDbPath() })

    // When: an audit entry is appended with token-like text and oversized runner output.
    store.appendAuditEntry({
      actor: "slack:U123",
      action: "runner.completed",
      occurredAt: "2026-06-26T00:04:00.000Z",
      configHash: "cfg_123",
      jobId: "job-analysis-1",
      stateFrom: "analysis_running",
      stateTo: "analysis_completed",
      details: `stdout xoxb-secret-token sntrys_abc123 glpat-123456 ${"a".repeat(6000)}`,
    })

    // Then: persisted audit text is safe for `logs`.
    const [entry] = store.listAuditEntries()
    expect(entry?.details).toContain("[REDACTED]")
    expect(entry?.details).not.toContain("xoxb-secret-token")
    expect(entry?.details).not.toContain("sntrys_abc123")
    expect(entry?.details).not.toContain("glpat-123456")
    expect(entry?.details.length).toBeLessThanOrEqual(2048)
    store.close()
  })
})
