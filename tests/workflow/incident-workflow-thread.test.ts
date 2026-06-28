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
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  RecordingSlackPublisher,
  runnerResult,
} from "./incident-workflow-fakes.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-workflow-thread-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Sentry-created incident Slack thread persistence", () => {
  it("persists returned Slack root timestamp before posting analysis follow-up", async () => {
    // Given: Sentry polling created an incident without a Slack root thread timestamp yet.
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const slack = new RecordingSlackPublisher()
    const rootThreadTs = "1719990000.000300"
    slack.rootPostTs = rootThreadTs
    const workflow = new IncidentWorkflow({
      branchPrefix: "incident/",
      defaultTargetBranch: "main",
      mrProvider: new RecordingMergeRequestProvider(),
      remoteName: "origin",
      repo: new RecordingRepoAdapter(),
      repoPaths: { "repo-api": "/allowed/repo-api" },
      runner: new RecordingRunner([runnerResult({ mode: "analysis_only" })]),
      slack,
      state: store,
    })
    await workflow.handleDetectedIncident({
      issueId: "SENTRY-10",
      repoId: "repo-api",
      repoPath: "/allowed/repo-api",
      channelId: "C123",
      threadTs: "pending",
      title: "Checkout crash",
      firstSeenAt: "2026-06-26T00:00:00.000Z",
      lastSeenAt: "2026-06-26T00:01:00.000Z",
    })

    // When: the user clicks the analyze button on the real Slack root message.
    await workflow.handleSlackAction({
      actionId: SlackActionIds.analyze,
      actor: { slackUserId: slackUserId("U123") },
      channel: { id: slackChannelId("C123") },
      issueId: sentryIssueId("SENTRY-10"),
      kind: "analyze_requested",
      repoId: repoId("repo-api"),
      thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs(rootThreadTs) },
    })

    // Then: persisted state and the analysis completion reply use the real root thread.
    expect(store.getIncidentByIssueId("SENTRY-10")?.threadTs).toBe(rootThreadTs)
    expect(slack.messages.at(-1)?.threadTs).toBe(rootThreadTs)
    expect(slack.messages.at(-1)?.threadTs).not.toBe("pending")
    store.close()
  })
})
