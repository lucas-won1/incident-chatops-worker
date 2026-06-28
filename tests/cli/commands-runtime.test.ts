import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import { SlackActionIds, type SlackActionIntent } from "../../src/slack/index.js"
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

const analyzeIntent = (): SlackActionIntent => ({
  actionId: SlackActionIds.analyze,
  actor: { slackUserId: slackUserId("U123") },
  channel: { id: slackChannelId("C123") },
  issueId: sentryIssueId("SENTRY-CLI-11"),
  kind: "analyze_requested",
  repoId: repoId("frontend"),
  thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
})

describe("production daemon command runtime", () => {
  it("starts Slack Socket Mode and recurring scheduler hooks through daemon runtime injection", async () => {
    // Given: non-fake settings with daemon dependencies replaced by local fakes.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const controller = new AbortController()
    const started: string[] = []

    // When: daemon starts and is then aborted.
    const running = runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
      daemonStarter: {
        startScheduler: () => {
          started.push("scheduler")
          return {
            stop: () => {
              started.push("scheduler:stopped")
            },
          }
        },
        startSlack: async () => {
          started.push("slack")
          return {
            stop: () => {
              started.push("slack:stopped")
            },
          }
        },
      },
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()
    const result = await running

    // Then: production hooks were started and stopped without live network.
    expect(result.exitCode).toBe(0)
    expect(started).toEqual(["slack", "scheduler", "scheduler:stopped", "slack:stopped"])
    expect(result.stdout).toContain("Slack Socket Mode: started")
    expect(result.stdout).toContain("Sentry polling scheduler: poll interval 300s")
  })

  it("wires default daemon Slack action dispatch into the shared workflow runtime", async () => {
    // Given: production-mode settings with fake socket mode and workflow factories.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const controller = new AbortController()
    const socketStarted = deferred()
    const actions: SlackActionIntent[] = []
    let dispatch: ((intent: SlackActionIntent) => Promise<void> | void) | undefined
    let socketStops = 0

    // When: the default daemon starter receives a Slack action through Socket Mode.
    const running = runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
      daemonWorkflowFactory: () => ({
        handleDetectedIncident: async () => undefined,
        handleSlackAction: async (intent) => {
          actions.push(intent)
        },
      }),
      signal: controller.signal,
      slackSocketModeFactory: (options) => {
        dispatch = options.dispatch
        return {
          start: async () => {
            socketStarted.resolve()
          },
          stop: () => {
            socketStops += 1
          },
        }
      },
    })
    await socketStarted.promise
    await dispatch?.(analyzeIntent())
    controller.abort()
    const result = await running

    // Then: the action reaches the workflow and the real adapter stop path is used.
    expect(result.exitCode).toBe(0)
    expect(actions.map((action) => action.kind)).toEqual(["analyze_requested"])
    expect(socketStops).toBe(1)
  })

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
