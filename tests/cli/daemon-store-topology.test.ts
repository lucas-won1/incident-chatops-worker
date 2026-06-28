import { describe, expect, it } from "vitest"

import { runDaemonPollOnce } from "../../src/cli/daemon-runtime.js"
import { loadCommandSettings } from "../../src/cli/settings.js"
import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import type { PollOnceOptions, PollOnceResult } from "../../src/sentry/index.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import type { SlackRenderedMessage } from "../../src/slack/block-kit.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { IncidentInput } from "../../src/state/types.js"
import type { WorkflowSlackPublisher } from "../../src/workflow/index.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  runnerResult,
} from "../workflow/incident-workflow-fakes.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

const issueId = "SENTRY-DAEMON-STORE-11"

class FlakyRootSlackPublisher implements WorkflowSlackPublisher {
  public readonly messages: SlackRenderedMessage[] = []
  public rootPostAttempts = 0
  public failNextRootPost = true

  readonly #rootThreadTs: string

  public constructor(rootThreadTs: string) {
    this.#rootThreadTs = rootThreadTs
  }

  public async postMessage(message: SlackRenderedMessage): Promise<{ readonly ts?: string }> {
    this.messages.push(message)
    if (message.threadTs !== "pending") {
      return {}
    }
    this.rootPostAttempts += 1
    if (this.failNextRootPost) {
      this.failNextRootPost = false
      throw new Error("Slack root post failed")
    }
    return { ts: this.#rootThreadTs }
  }
}

const sentryIncident = (): IncidentInput => ({
  channelId: "#incidents",
  firstSeenAt: "2026-06-26T00:00:00.000Z",
  issueId,
  lastSeenAt: "2026-06-26T00:05:00.000Z",
  repoId: "frontend",
  threadTs: "pending",
  title: "Daemon store topology crash",
})

const pollDetectedIncident = async (options: PollOnceOptions): Promise<PollOnceResult> => {
  await options.onDetectedIncident?.(sentryIncident())
  return {
    detailFetches: 0,
    newIncidents: 1,
    skippedIncidents: 0,
    status: "ok",
    updatedIncidents: 0,
  }
}

const freshThreadTs = (dbPath: string): string | undefined => {
  const fresh = openSqliteStateStore({ accessMode: "read", createIfMissing: false, path: dbPath })
  try {
    return fresh.getIncidentByIssueId(issueId)?.threadTs
  } finally {
    fresh.close()
  }
}

describe("daemon state store topology", () => {
  it("keeps workflow thread writes visible to fresh SQLite readers after daemon polls", async () => {
    // Given: the daemon workflow owns a long-lived state store and Slack fails the first root post.
    const rootThreadTs = "1719995555.000800"
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const { settings } = loadCommandSettings(["--config", configPath, "--env-file", envPath])
    const workflowStore = openSqliteStateStore({ path: dbPath })
    const slack = new FlakyRootSlackPublisher(rootThreadTs)
    const workflow = new IncidentWorkflow({
      branchPrefix: "incident/",
      defaultTargetBranch: "main",
      mrProvider: new RecordingMergeRequestProvider(),
      remoteName: "origin",
      repo: new RecordingRepoAdapter(),
      repoPaths: { frontend: "/Users/won/Work/incident-chatops-worker" },
      runner: new RecordingRunner([runnerResult({ mode: "analysis_only" })]),
      slack,
      state: workflowStore,
    })
    const workflowRuntime = {
      handleDetectedIncident: (incident: IncidentInput) =>
        workflow.handleDetectedIncident({
          ...incident,
          repoPath: "/Users/won/Work/incident-chatops-worker",
        }),
      handleSlackAction: () => Promise.resolve(),
      stateStore: workflowStore,
      stop: () => workflowStore.close(),
    }

    try {
      // When: the first daemon poll stores a pending incident but root Slack posting fails.
      const first = await runDaemonPollOnce(settings, workflowRuntime, {
        pollOnce: pollDetectedIncident,
      })

      // Then: a fresh DB reader immediately sees the pending state without waiting for stop.
      expect(first.status).toBe("degraded")
      expect(freshThreadTs(dbPath)).toBe("pending")

      // When: the next poll retries the pending root post and Slack returns the real root ts.
      const second = await runDaemonPollOnce(settings, workflowRuntime, {
        pollOnce: pollDetectedIncident,
      })

      // Then: fresh readers see the real root ts immediately, and workflow follow-ups use it.
      expect(second.status).toBe("ok")
      expect(slack.rootPostAttempts).toBe(2)
      expect(freshThreadTs(dbPath)).toBe(rootThreadTs)
      await workflow.handleSlackAction({
        actionId: SlackActionIds.analyze,
        actor: { slackUserId: slackUserId("U123") },
        channel: { id: slackChannelId("#incidents") },
        issueId: sentryIssueId(issueId),
        kind: "analyze_requested",
        repoId: repoId("frontend"),
        thread: { channelId: slackChannelId("#incidents"), threadTs: slackThreadTs(rootThreadTs) },
      })
      expect(slack.messages.at(-1)?.threadTs).toBe(rootThreadTs)
    } finally {
      await workflowRuntime.stop()
    }
  })

  it("keeps daemon thread writes after an older read handle closes", async () => {
    // Given: a read-style handle opens while the incident still has the pending thread marker.
    const rootThreadTs = "1719998888.001100"
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })
    const { settings } = loadCommandSettings(["--config", configPath, "--env-file", envPath])
    const workflowStore = openSqliteStateStore({ path: dbPath })
    const slack = new FlakyRootSlackPublisher(rootThreadTs)
    slack.failNextRootPost = false
    const workflow = new IncidentWorkflow({
      branchPrefix: "incident/",
      defaultTargetBranch: "main",
      mrProvider: new RecordingMergeRequestProvider(),
      remoteName: "origin",
      repo: new RecordingRepoAdapter(),
      repoPaths: { frontend: "/Users/won/Work/incident-chatops-worker" },
      runner: new RecordingRunner([runnerResult({ mode: "analysis_only" })]),
      slack,
      state: workflowStore,
    })
    workflowStore.upsertIncident(sentryIncident())
    const staleReader = openSqliteStateStore({
      accessMode: "read",
      createIfMissing: false,
      path: dbPath,
    })
    let staleReaderClosed = false
    expect(staleReader.getIncidentByIssueId(issueId)?.threadTs).toBe("pending")
    const workflowRuntime = {
      handleDetectedIncident: (incident: IncidentInput) =>
        workflow.handleDetectedIncident({
          ...incident,
          repoPath: "/Users/won/Work/incident-chatops-worker",
        }),
      handleSlackAction: () => Promise.resolve(),
      stateStore: workflowStore,
      stop: () => workflowStore.close(),
    }

    try {
      // When: the daemon workflow persists the real Slack root ts before the older reader closes.
      const result = await runDaemonPollOnce(settings, workflowRuntime, {
        pollOnce: pollDetectedIncident,
      })
      expect(result.status).toBe("ok")
      expect(freshThreadTs(dbPath)).toBe(rootThreadTs)
      staleReader.close()
      staleReaderClosed = true

      // Then: the older read handle must not overwrite the real root ts with its stale snapshot.
      expect(freshThreadTs(dbPath)).toBe(rootThreadTs)
    } finally {
      if (!staleReaderClosed) {
        staleReader.close()
      }
      await workflowRuntime.stop()
    }
  })
})
