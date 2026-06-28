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
import type { RunnerAdapter, RunnerRequest } from "../../src/runner/types.js"
import { SlackActionIds, type SlackActionIntent } from "../../src/slack/action-payload.js"
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
  const dir = mkdtempSync(join(tmpdir(), "incident-workflow-audit-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const detectedIncident = {
  issueId: "SENTRY-AUDIT",
  repoId: "repo-api",
  repoPath: "/allowed/repo-api",
  channelId: "C123",
  threadTs: "1712345678.000100",
  title: "Checkout crash xoxb-secret-token",
  firstSeenAt: "2026-06-26T00:00:00.000Z",
  lastSeenAt: "2026-06-26T00:01:00.000Z",
} as const

const slackAction = (
  kind: SlackActionIntent["kind"],
  actionId: SlackActionIntent["actionId"],
): SlackActionIntent => {
  const base = {
    issueId: sentryIssueId("SENTRY-AUDIT"),
    repoId: repoId("repo-api"),
    channel: { id: slackChannelId("C123") },
    thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
    actor: { slackUserId: slackUserId("U123") },
  }
  switch (kind) {
    case "analyze_requested":
      return { ...base, kind, actionId: SlackActionIds.analyze }
    case "fix_requested":
      if (actionId === SlackActionIds.fixAndMr || actionId === SlackActionIds.fixAfterAnalysis) {
        return { ...base, kind, actionId }
      }
      return { ...base, kind, actionId: SlackActionIds.fixAfterAnalysis }
    case "ignored":
      return { ...base, kind, actionId: SlackActionIds.ignore }
    case "closed":
      return { ...base, kind, actionId: SlackActionIds.close }
  }
}

const createWorkflow = <TRunner extends RunnerAdapter<RunnerRequest>>(runner: TRunner) => {
  const store = openSqliteStateStore({ path: createTempDbPath() })
  const slack = new RecordingSlackPublisher()
  const repo = new RecordingRepoAdapter()
  const mrProvider = new RecordingMergeRequestProvider()
  const workflow = new IncidentWorkflow({
    branchPrefix: "incident/",
    defaultTargetBranch: "main",
    mrProvider,
    remoteName: "origin",
    repo,
    repoPaths: { "repo-api": "/allowed/repo-api" },
    runner,
    slack,
    state: store,
  })
  return { repo, runner, store, workflow }
}

describe("workflow transition audit", () => {
  it("writes audit rows for happy analysis and fix state transitions", async () => {
    // Given: a detected incident with approved analysis and fix runner results.
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis and then fix.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: every workflow state transition has a named audit action with safe details.
    const audit = store.listAuditEntries()
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "workflow.analysis_requested",
        "workflow.analysis_running",
        "workflow.analysis_completed",
        "workflow.fix_requested",
        "workflow.fix_running",
        "workflow.mr_created",
      ]),
    )
    expect(audit.map((entry) => `${entry.stateFrom}->${entry.stateTo}`)).toEqual(
      expect.arrayContaining([
        "detected->analysis_requested",
        "analysis_requested->analysis_running",
        "analysis_running->analysis_completed",
        "analysis_completed->fix_requested",
        "fix_requested->fix_running",
        "fix_running->mr_created",
      ]),
    )
    expect(JSON.stringify(audit)).not.toContain("xoxb-secret-token")
    store.close()
  })

  it("writes audit rows for failure and closed terminal state transitions", async () => {
    // Given: a detected incident with a runner failure and another detected incident to close.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { repo, store, workflow } = createWorkflow(runner)
    repo.openWorktree = async () => {
      throw new Error("boom xoxb-secret-token")
    }
    await workflow.handleDetectedIncident(detectedIncident)

    // When: analysis fails and the incident is closed.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))
    await workflow.handleSlackAction(slackAction("closed", SlackActionIds.close))

    // Then: terminal transitions are audited and sensitive failure text is redacted.
    const audit = store.listAuditEntries()
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["workflow.failed", "workflow.closed"]),
    )
    expect(audit.map((entry) => `${entry.stateFrom}->${entry.stateTo}`)).toEqual(
      expect.arrayContaining(["analysis_running->failed", "failed->closed"]),
    )
    expect(JSON.stringify(audit)).not.toContain("xoxb-secret-token")
    store.close()
  })
})
