import { createServer, type Server } from "node:http"

import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import { openDatabase, persistDatabase } from "../../src/state/sqlite-database.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

type FakeSentryServer = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve()
        return
      }
      reject(error)
    })
  })

const startFakeSentryServer = async (): Promise<FakeSentryServer> => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify([
        {
          firstSeen: "2026-06-26T00:00:00.000Z",
          id: "SENTRY-CLI-BASIC",
          lastSeen: "2026-06-26T00:05:00.000Z",
          permalink: "https://sentry.example/issues/SENTRY-CLI-BASIC",
          project: { slug: "frontend" },
          status: "unresolved",
          title: "Basic run-once fake Sentry issue",
        },
      ]),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    await closeServer(server)
    throw new Error("fake Sentry server did not bind a TCP port")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/0`,
    close: () => closeServer(server),
  }
}

describe("basic production CLI commands", () => {
  it("keeps the default daemon resident until the runtime signal aborts", async () => {
    // Given: local fake mode settings and an injected abort signal.
    const { configPath, envPath } = writeFixtureFiles(createTempDir())
    const controller = new AbortController()

    // When: daemon starts without --once or test-only flags.
    const running = runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
      signal: controller.signal,
    })
    const earlyResult = await Promise.race([
      running.then(() => "resolved"),
      Promise.resolve("resident"),
    ])

    // Then: it has not resolved synchronously and shuts down only after abort.
    expect(earlyResult).toBe("resident")
    controller.abort()
    const result = await running
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("shutdown signal received")
    expect(result.stdout).toContain("clean shutdown")
  })

  it("runs daemon once with fake Slack/Sentry adapters and the default scheduler interval", async () => {
    // Given: local fake mode settings with no live network dependencies.
    const { configPath, envPath } = writeFixtureFiles(createTempDir())

    // When: the daemon runs one bounded cycle.
    const result = await runCliAsync([
      "daemon",
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--once",
    ])

    // Then: startup, one poll cycle, and clean shutdown are visible.
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Slack Socket Mode: fake connection ready")
    expect(result.stdout).toContain("poll interval 300s")
    expect(result.stdout).toContain("one poll cycle complete")
    expect(result.stdout).toContain("clean shutdown")
  })

  it("uses the env scheduler interval override for daemon", async () => {
    // Given: fake mode with a safe polling interval override.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), {
      SENTRY_POLL_INTERVAL_SECONDS: "600",
    })

    // When: the daemon starts one cycle.
    const result = await runCliAsync([
      "daemon",
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--once",
    ])

    // Then: the scheduler uses the overridden cadence.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("poll interval 600s")
  })

  it("performs one fake Sentry poll through run-once without live tokens", async () => {
    // Given: fake mode settings with a local Sentry API response.
    const fakeSentry = await startFakeSentryServer()
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), {
      SENTRY_BASE_URL: fakeSentry.baseUrl,
    })

    try {
      // When: run-once executes the default Sentry source.
      const result = await runCliAsync(["run-once", "--config", configPath, "--env-file", envPath])

      // Then: the command reports a workflow-backed bounded poll instead of a placeholder.
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("source=sentry")
      expect(result.stdout).toContain("status=ok")
      expect(result.stdout).toContain("new=1")
    } finally {
      await fakeSentry.close()
    }
  })

  it("reports SQLite, connection, polling, and job health in status output", async () => {
    // Given: a state database containing one incident and redacted audit details.
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir())
    const store = openSqliteStateStore({ path: dbPath })
    const now = new Date("2026-06-26T00:00:00.000Z").toISOString()
    store.upsertIncident({
      channelId: "C123",
      firstSeenAt: now,
      issueId: "SENTRY-CLI-1",
      lastSeenAt: now,
      repoId: "frontend",
      threadTs: "pending",
      title: "Status fixture",
    })
    store.appendAuditEntry({
      actor: "test",
      action: "status.fixture",
      configHash: "test",
      details: "token xoxb-secret-token must stay redacted",
      occurredAt: now,
    })
    store.close()

    // When: status reads the database and settings.
    const result = await runCliAsync(["status", "--config", configPath, "--env-file", envPath])

    // Then: health is current and secret-like values are not leaked.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SQLite: ok")
    expect(result.stdout).toContain("connections: fake")
    expect(result.stdout).toContain("polling: interval 300s")
    expect(result.stdout).toContain("incidents=1")
    expect(result.stdout).toContain("jobs active=0 terminal=0")
    expect(result.stdout).not.toContain("xoxb-secret-token")
  })

  it("logs prints redacted audit entries", async () => {
    // Given: the audit log contains multiple token-shaped values.
    const { dbPath } = writeFixtureFiles(createTempDir())
    const store = openSqliteStateStore({ path: dbPath })
    store.appendAuditEntry({
      actor: "test",
      action: "logs.fixture",
      configHash: "test",
      details: "xoxb-secret-token sntrys_secret_value glpat-secret-value",
      occurredAt: "2026-06-26T00:00:00.000Z",
    })
    store.close()

    // When: logs reads the audit log.
    const result = await runCliAsync(["logs", "--db", dbPath])

    // Then: only redacted details are emitted.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("logs.fixture")
    expect(result.stdout).toContain("[REDACTED]")
    expect(result.stdout).not.toContain("xoxb-secret-token")
    expect(result.stdout).not.toContain("sntrys_secret_value")
    expect(result.stdout).not.toContain("glpat-secret-value")
  })

  it("logs redacts stale raw audit details at read time", async () => {
    // Given: a stale database row bypassed audit insertion redaction.
    const { dbPath } = writeFixtureFiles(createTempDir())
    const store = openSqliteStateStore({ path: dbPath })
    store.close()
    const db = openDatabase(dbPath, false)
    db.run(
      `INSERT INTO audit_log (
        audit_id, actor, action, occurred_at, config_hash, job_id, state_from, state_to, details
      ) VALUES (
        'audit_raw', 'test', 'logs.raw', '2026-06-26T00:00:00.000Z', 'test',
        NULL, NULL, NULL, 'stale xoxb-secret-token sntrys_secret_value'
      )`,
    )
    persistDatabase(db, dbPath)
    db.close()

    // When: logs reads the existing audit log.
    const result = await runCliAsync(["logs", "--db", dbPath])

    // Then: stale raw details are redacted during output rendering.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("logs.raw")
    expect(result.stdout).toContain("[REDACTED]")
    expect(result.stdout).not.toContain("xoxb-secret-token")
    expect(result.stdout).not.toContain("sntrys_secret_value")
  })

  it("shuts daemon down cleanly when a signal aborts it", async () => {
    // Given: a daemon command running with an injected abort signal.
    const { configPath, envPath } = writeFixtureFiles(createTempDir())
    const controller = new AbortController()
    const running = runCliAsync(
      ["daemon", "--config", configPath, "--env-file", envPath, "--test-wait-for-signal"],
      {
        signal: controller.signal,
      },
    )

    // When: the signal arrives.
    controller.abort()
    const result = await running

    // Then: the command reports graceful shutdown and does not hang.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("shutdown signal received")
    expect(result.stdout).toContain("clean shutdown")
  })
})
