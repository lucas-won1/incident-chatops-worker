import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import type { RunnerAdapter, RunnerIncidentContext, RunnerRequest } from "../../src/runner/types.js"
import { SlackActionIds, type SlackActionIntent } from "../../src/slack/action-payload.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { IncidentRecord } from "../../src/state/types.js"
import type { WorkflowWorktreePreparer } from "../../src/workflow/index.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingSlackPublisher,
} from "./incident-workflow-fakes.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-workflow-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

export const detectedIncident = {
  issueId: "SENTRY-10",
  repoId: "repo-api",
  repoPath: "/allowed/repo-api",
  channelId: "C123",
  threadTs: "1712345678.000100",
  title: "Checkout crash xoxb-secret-token",
  firstSeenAt: "2026-06-26T00:00:00.000Z",
  lastSeenAt: "2026-06-26T00:01:00.000Z",
} as const

export const detailedSentryContext = {
  events: [
    {
      culprit: "src/payment/checkout.ts",
      dateCreated: "2026-06-26T00:00:30.000Z",
      entries: [
        {
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    {
                      filename: "src/payment/checkout.ts",
                      function: "submitCheckout",
                    },
                  ],
                },
              },
            ],
          },
          type: "exception",
        },
      ],
      eventID: "event-10",
      message: "TypeError: Cannot read properties of undefined",
      tags: [
        ["environment", "production"],
        ["release", "checkout@2026.06.26"],
      ],
      title: "Checkout submit crashed",
    },
  ],
  issueId: "SENTRY-10",
  trustBoundary: "untrusted_external_sentry",
} satisfies RunnerIncidentContext

export const slackAction = (
  kind: SlackActionIntent["kind"],
  actionId: SlackActionIntent["actionId"],
): SlackActionIntent => {
  const base = {
    issueId: sentryIssueId("SENTRY-10"),
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

type CreateWorkflowOptions = {
  readonly allowedRunnerCommands?: readonly string[]
  readonly mrProvider?: RecordingMergeRequestProvider
  readonly sentryContext?: {
    readonly fetchIssueContext: (incident: IncidentRecord) => Promise<RunnerIncidentContext>
  }
  readonly sentryContextSecretValues?: readonly string[]
  readonly worktreePreparer?: WorkflowWorktreePreparer
}

export const createWorkflow = <TRunner extends RunnerAdapter<RunnerRequest>>(
  runner: TRunner,
  workflowOptions: CreateWorkflowOptions = {},
) => {
  const dbPath = createTempDbPath()
  const store = openSqliteStateStore({ path: dbPath })
  const slack = new RecordingSlackPublisher()
  const repo = new RecordingRepoAdapter()
  const mrProvider = workflowOptions.mrProvider ?? new RecordingMergeRequestProvider()
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
    ...workflowOptions,
  })
  return { dbPath, mrProvider, repo, runner, slack, store, workflow }
}
