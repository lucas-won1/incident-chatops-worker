import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import { pollOnce } from "../../src/sentry/index.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import type { SlackRenderedMessage } from "../../src/slack/block-kit.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { IncidentInput } from "../../src/state/types.js"
import type { WorkflowSlackPublisher } from "../../src/workflow/index.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import { json, startSentryServer } from "../sentry/sentry-test-server.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  runnerResult,
} from "./incident-workflow-fakes.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-pending-retry-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("pending incident Slack root-post retry", () => {
  it("retries initial Slack root post on the next poll when the stored thread is pending", async () => {
    // Given: Sentry keeps returning the same unresolved issue and Slack fails the first root post.
    const rootThreadTs = "1719991111.000400"
    const slack = new FlakyRootSlackPublisher(rootThreadTs)
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const workflow = new IncidentWorkflow({
      branchPrefix: "incident/",
      defaultTargetBranch: "main",
      mrProvider: new RecordingMergeRequestProvider(),
      remoteName: "origin",
      repo: new RecordingRepoAdapter(),
      repoPaths: { frontend: "/allowed/frontend" },
      runner: new RecordingRunner([runnerResult({ mode: "analysis_only" })]),
      slack,
      state: store,
    })
    const server = await startSentryServer((_request, response) => {
      json(response, [
        {
          culprit: "Checkout.tsx in submitOrder",
          firstSeen: "2026-06-26T00:00:00.000Z",
          id: "1234567890",
          lastSeen: "2026-06-26T00:05:00.000Z",
          permalink: "https://sentry.example/issues/1234567890/",
          project: { slug: "frontend" },
          shortId: "FRONTEND-1",
          status: "unresolved",
          title: "Checkout crash",
        },
      ])
    })
    const pollOptions = {
      authToken: "sntrys_redacted_example",
      baseUrl: server.baseUrl,
      onDetectedIncident: (incident: IncidentInput) =>
        workflow.handleDetectedIncident({ ...incident, repoPath: "/allowed/frontend" }),
      projects: [
        { organizationSlug: "demo-org", projectSlug: "frontend", slackChannel: "#incidents" },
      ],
      store,
    }

    try {
      // When: the first poll persists the incident but Slack root posting fails.
      await expect(pollOnce(pollOptions)).rejects.toThrow("Slack root post failed")
      const storedAfterFailure = store.getIncidentByIssueId("1234567890")

      // Then: the next poll retries the initial root post instead of skipping the pending incident.
      expect(storedAfterFailure?.threadTs).toBe("pending")
      const retry = await pollOnce(pollOptions)
      expect(retry.skippedIncidents).toBe(0)
      expect(slack.rootPostAttempts).toBe(2)
      expect(store.getIncidentByIssueId("1234567890")?.threadTs).toBe(rootThreadTs)

      // And: follow-up analysis replies use the real root thread after the retry succeeds.
      await workflow.handleSlackAction({
        actionId: SlackActionIds.analyze,
        actor: { slackUserId: slackUserId("U123") },
        channel: { id: slackChannelId("#incidents") },
        issueId: sentryIssueId("1234567890"),
        kind: "analyze_requested",
        repoId: repoId("frontend"),
        thread: { channelId: slackChannelId("#incidents"), threadTs: slackThreadTs(rootThreadTs) },
      })
      expect(slack.messages.at(-1)?.threadTs).toBe(rootThreadTs)
    } finally {
      store.close()
      await server.close()
    }
  })
})
