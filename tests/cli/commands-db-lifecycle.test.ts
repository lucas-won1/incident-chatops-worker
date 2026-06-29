import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import { SentryExternalApiError } from "../../src/sentry/index.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

type AutomaticStateFixture = {
  readonly dbPath: string
  readonly env: Readonly<Record<string, string>>
}

const automaticStateFixture = (dir: string): AutomaticStateFixture => {
  switch (process.platform) {
    case "darwin": {
      const home = path.join(dir, "home")
      mkdirSync(home, { recursive: true })
      return {
        dbPath: path.join(
          home,
          "Library",
          "Application Support",
          "incident-chatops-worker",
          "state.sqlite",
        ),
        env: { HOME: home },
      }
    }
    case "linux": {
      const home = path.join(dir, "home")
      mkdirSync(home, { recursive: true })
      return {
        dbPath: path.join(home, ".local", "state", "incident-chatops-worker", "state.sqlite"),
        env: { HOME: home },
      }
    }
    case "win32": {
      const localAppData = path.join(dir, "LocalAppData")
      mkdirSync(localAppData, { recursive: true })
      return {
        dbPath: path.win32.join(localAppData, "incident-chatops-worker", "state.sqlite"),
        env: { LOCALAPPDATA: localAppData },
      }
    }
    default:
      throw new Error(`Unsupported test platform: ${process.platform}`)
  }
}

const writeEnvFile = (envPath: string, entries: Readonly<Record<string, string>>): void => {
  writeFileSync(
    envPath,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
  )
}

describe("CLI DB lifecycle", () => {
  it("creates the automatic state database path when daemon fake mode omits STATE_DB_PATH", async () => {
    // Given: a CLI env file with no explicit DB override and a temp OS state base.
    const dir = createTempDir()
    const { configPath, envPath } = writeFixtureFiles(dir, { FAKE_MODE: "1" })
    const state = automaticStateFixture(dir)
    writeEnvFile(envPath, {
      FAKE_MODE: "1",
      GITLAB_TOKEN: "glpat-redacted-example",
      SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
      SENTRY_BASE_URL: "https://sentry.invalid/api/0",
      SLACK_APP_TOKEN: "xapp-redacted-example",
      SLACK_BOT_TOKEN: "xoxb-redacted-example",
      ...state.env,
    })

    // When: the one-shot daemon starts through the real CLI surface.
    const result = await runCliAsync([
      "daemon",
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--once",
    ])

    // Then: the automatic durable SQLite file is created.
    expect(result.exitCode).toBe(0)
    expect(existsSync(state.dbPath)).toBe(true)
  })

  it("prints logs using the state path resolved from --env-file and --config", async () => {
    // Given: an audit row exists in the configured state DB.
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "1" })
    const store = openSqliteStateStore({ path: dbPath })
    store.appendAuditEntry({
      actor: "test",
      action: "state.lifecycle",
      configHash: "test",
      details: "configured DB log entry",
      occurredAt: "2026-06-29T00:00:00.000Z",
    })
    store.close()

    // When: logs is invoked without --db but with the normal config/env options.
    const result = await runCliAsync(["logs", "--config", configPath, "--env-file", envPath])

    // Then: logs resolves the same state DB path as daemon/status.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("state.lifecycle")
    expect(result.stdout).toContain("configured DB log entry")
  })

  it("keeps logs --db as an explicit state database override", async () => {
    // Given: two state DBs exist and only the explicit override contains the target audit row.
    const dir = createTempDir()
    const explicitDbPath = path.join(dir, "explicit.sqlite")
    const store = openSqliteStateStore({ path: explicitDbPath })
    store.appendAuditEntry({
      actor: "test",
      action: "state.override",
      configHash: "test",
      details: "explicit DB log entry",
      occurredAt: "2026-06-29T00:00:00.000Z",
    })
    store.close()

    // When: logs is invoked with --db.
    const result = await runCliAsync(["logs", "--db", explicitDbPath])

    // Then: the explicit DB is read directly.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("state.override")
    expect(result.stdout).toContain("explicit DB log entry")
  })

  it("stops daemon resources when one-shot polling fails", async () => {
    // Given: an injected daemon starter whose poll command fails after Slack starts.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    let slackStops = 0

    // When: daemon --once receives the polling failure.
    const result = await runCliAsync(
      ["daemon", "--config", configPath, "--env-file", envPath, "--once"],
      {
        daemonStarter: {
          runPollOnce: () => {
            throw new SentryExternalApiError("poll failed", 503)
          },
          startScheduler: () => ({}),
          startSlack: async () => ({
            stop: () => {
              slackStops += 1
            },
          }),
        },
      },
    )

    // Then: the failure is reported and the started resource is still stopped.
    expect(result.exitCode).toBe(69)
    expect(slackStops).toBe(1)
  })

  it("stops the default workflow runtime when Slack Socket Mode startup fails", async () => {
    // Given: the production daemon default starter acquires workflow state before Slack starts.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    let workflowStops = 0

    // When / Then: Slack startup rejects and the acquired workflow runtime is still stopped.
    await expect(
      runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
        daemonWorkflowFactory: () => ({
          handleDetectedIncident: async () => undefined,
          handleSlackAction: async () => undefined,
          stop: () => {
            workflowStops += 1
          },
        }),
        slackSocketModeFactory: () => ({
          start: async () => {
            throw new Error("socket startup failed")
          },
          stop: async () => undefined,
        }),
      }),
    ).rejects.toThrow("socket startup failed")
    expect(workflowStops).toBe(1)
  })
})
