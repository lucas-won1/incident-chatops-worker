import { describe, expect, it } from "vitest"

import { createProductionDaemonWorkflowRuntime } from "../../src/cli/daemon-runtime.js"
import { loadCommandSettings } from "../../src/cli/settings.js"
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
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  RecordingSlackPublisher,
  runnerResult,
} from "../workflow/incident-workflow-fakes.js"
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
  it("emits focused workflow status lines for Slack fix execution failures", async () => {
    // Given: a production workflow runtime with local fakes and a failing verification result.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const settings = loadCommandSettings(["--config", configPath, "--env-file", envPath]).settings
    const output: string[] = []
    const runtime = createProductionDaemonWorkflowRuntime(settings, {
      mrProviderFactory: () => new RecordingMergeRequestProvider(),
      repo: new RecordingRepoAdapter(),
      runner: new RecordingRunner([
        runnerResult({
          mode: "fix_and_mr",
          verificationResults: "failed: jest: command not found",
        }),
      ]),
      sentryContext: {
        fetchIssueContext: async (incident) => ({
          issueId: incident.issueId,
          trustBoundary: "untrusted_external_sentry",
        }),
      },
      slack: new RecordingSlackPublisher(),
      writeStatus: (line) => output.push(line),
    })

    // When: Slack approves a fix job.
    await runtime.handleSlackAction({
      actionId: SlackActionIds.fixAndMr,
      actor: { slackUserId: slackUserId("U123") },
      channel: { id: slackChannelId("C123") },
      issueId: sentryIssueId("SENTRY-CLI-11"),
      kind: "fix_requested",
      repoId: repoId("frontend"),
      thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
    })
    runtime.stop?.()

    // Then: daemon stdout receives the job milestones needed to debug the failure.
    expect(output.join("\n")).toContain(
      "workflow action received kind=fix_requested issue=SENTRY-CLI-11",
    )
    expect(output.join("\n")).toContain("workflow worktree opening")
    expect(output.join("\n")).toContain("workflow runner completed mode=fix_and_mr")
    expect(output.join("\n")).toContain("workflow verification status=failed")
    expect(output.join("\n")).toContain("summary=failed: jest: command not found")
    expect(output.join("\n")).toContain("workflow job failed state=verification_failed")
  })

  it("recovers abandoned active jobs when the production daemon runtime starts", () => {
    // Given: the state DB contains a running job from a previous daemon process.
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const settings = loadCommandSettings(["--config", configPath, "--env-file", envPath]).settings
    const seedStore = openSqliteStateStore({ path: dbPath })
    const incident = seedStore.upsertIncident({
      channelId: "C123",
      firstSeenAt: "2026-06-27T00:00:00.000Z",
      issueId: "SENTRY-CLI-RECOVER",
      lastSeenAt: "2026-06-27T00:00:00.000Z",
      repoId: "frontend",
      threadTs: "1712345678.000100",
      title: "abandoned daemon job",
    })
    const abandonedJob = seedStore.claimJobForSlackAction({
      actionIdempotencyKey: "slack-action-1",
      actor: "slack:U123",
      incidentId: incident.incidentId,
      jobKind: "fix",
      now: "2026-06-27T00:01:00.000Z",
    })
    seedStore.close()
    const output: string[] = []

    // When: production runtime opens the same DB on startup.
    const runtime = createProductionDaemonWorkflowRuntime(settings, {
      runner: new RecordingRunner([]),
      writeStatus: (line) => output.push(line),
    })
    const state = runtime.stateStore
    if (state === undefined) {
      throw new Error("expected production state store")
    }
    const retryJob = state.claimJobForSlackAction({
      actionIdempotencyKey: "slack-action-1",
      actor: "slack:U123",
      incidentId: incident.incidentId,
      jobKind: "fix",
      now: "2026-06-27T00:02:00.000Z",
    })
    const auditEntries = state.listAuditEntries()
    runtime.stop?.()

    // Then: startup frees the stale lease and records the abandoned job.
    expect(output.join("\n")).toContain("workflow recovered abandoned active jobs count=1")
    expect(output.join("\n")).toContain(abandonedJob.jobId)
    expect(retryJob.claimStatus).toBe("claimed")
    expect(retryJob.jobId).not.toBe(abandonedJob.jobId)
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "job.abandoned",
        jobId: abandonedJob.jobId,
        stateTo: "failed",
      }),
    )
  })

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

  it("stops default workflow runtime when Slack Socket Mode stop fails during shutdown", async () => {
    // Given: a resident default daemon whose Slack adapter rejects during normal shutdown.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const controller = new AbortController()
    const socketStarted = deferred()
    let workflowStops = 0

    // When: shutdown reaches the default Slack stop path.
    const running = runCliAsync(["daemon", "--config", configPath, "--env-file", envPath], {
      daemonWorkflowFactory: () => ({
        handleDetectedIncident: async () => undefined,
        handleSlackAction: async () => undefined,
        stop: () => {
          workflowStops += 1
        },
      }),
      signal: controller.signal,
      slackSocketModeFactory: () => ({
        start: async () => {
          socketStarted.resolve()
        },
        stop: async () => {
          throw new Error("socket stop failed")
        },
      }),
    })
    await socketStarted.promise
    controller.abort()

    // Then: the adapter error still propagates, but workflow cleanup is attempted.
    await expect(running).rejects.toThrow("socket stop failed")
    expect(workflowStops).toBe(1)
  })
})
