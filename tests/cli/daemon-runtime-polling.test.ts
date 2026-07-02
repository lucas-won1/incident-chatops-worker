import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { WorkflowDetectedIncident } from "../../src/workflow/index.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

const deferred = (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} => {
  let resolvePromise = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe("production daemon polling runtime", () => {
  it("sends default daemon poll detections through workflow initial-button handling", async () => {
    // Given: production-mode settings with a fake poller that reports a new Sentry issue.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const detected: WorkflowDetectedIncident[] = []

    // When: daemon --once runs the default production runtime.
    const result = await runCliAsync(
      ["daemon", "--config", configPath, "--env-file", envPath, "--once"],
      {
        daemonWorkflowFactory: () => ({
          handleDetectedIncident: async (incident) => {
            detected.push(incident)
          },
          handleSlackAction: async () => undefined,
        }),
        pollOnce: async (options) => {
          await options.onDetectedIncident?.({
            channelId: "#incidents",
            firstSeenAt: "2026-06-26T00:00:00.000Z",
            issueId: "SENTRY-CLI-11",
            lastSeenAt: "2026-06-26T00:01:00.000Z",
            repoId: "frontend",
            threadTs: "pending",
            title: "CLI detected incident",
          })
          return {
            detailFetches: 0,
            newIncidents: 1,
            skippedIncidents: 0,
            status: "ok",
            updatedIncidents: 0,
          }
        },
        slackSocketModeFactory: () => ({ start: async () => undefined, stop: () => undefined }),
      },
    )

    // Then: poll detections reach the workflow seam that posts initial Slack buttons.
    expect(result.exitCode).toBe(0)
    expect(detected).toEqual([
      expect.objectContaining({
        issueId: "SENTRY-CLI-11",
        repoId: "frontend",
        repoPath: "/Users/won/Work/incident-chatops-worker",
      }),
    ])
  })

  it("records scheduler poll failures as degraded audit output instead of swallowing them", async () => {
    // Given: a resident production daemon whose first scheduled poll fails with a token-like value.
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const controller = new AbortController()
    const degradedOutput = deferred()
    const output: string[] = []

    // When: the scheduler observes the poll failure.
    const running = runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
      daemonWorkflowFactory: () => ({
        handleDetectedIncident: async () => undefined,
        handleSlackAction: async () => undefined,
      }),
      pollOnce: async () => {
        throw new Error("Sentry auth failed xoxb-secret-token")
      },
      signal: controller.signal,
      slackSocketModeFactory: () => ({ start: async () => undefined, stop: () => undefined }),
      writeStdout: (text) => {
        output.push(text)
        if (text.includes("degraded")) {
          degradedOutput.resolve()
        }
      },
    })
    await degradedOutput.promise
    controller.abort()
    const result = await running
    const store = openSqliteStateStore({ path: dbPath })
    const auditDetails = store
      .listAuditEntries()
      .map((entry) => entry.details)
      .join("\n")
    store.close()

    // Then: degraded status is surfaced and persisted with redaction.
    expect(result.exitCode).toBe(0)
    expect(output.join("")).toContain("Sentry polling scheduler: degraded")
    expect(output.join("")).toContain("[REDACTED]")
    expect(output.join("")).not.toContain("xoxb-secret-token")
    expect(auditDetails).toContain("Sentry auth failed")
    expect(auditDetails).toContain("[REDACTED]")
    expect(auditDetails).not.toContain("xoxb-secret-token")
  })
})
