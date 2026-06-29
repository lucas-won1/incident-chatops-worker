import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import { loadWorkerSettings, type WorkerSettings } from "../../src/config/index.js"
import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import type { RunnerAdapter, RunnerIncidentContext, RunnerRequest } from "../../src/runner/types.js"
import { SlackActionIds, type SlackActionIntent } from "../../src/slack/action-payload.js"
import { openDatabase } from "../../src/state/sqlite-database.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { IncidentRecord } from "../../src/state/types.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingSlackPublisher,
} from "./incident-workflow-fakes.js"

const tempDirs: string[] = []
export const configuredGitLabBaseUrl = ["https:", "", "gitlab.internal.example", "api", "v4"].join(
  "/",
)
export const configuredGitHubBaseUrl = [
  "https:",
  "",
  "github.enterprise.example",
  "api",
  "v3",
].join("/")

type SavedMrLink = {
  readonly provider: string
  readonly url: string
}

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-workflow-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

const configYaml = (mrYaml: string): string => `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend-sentry
      slackChannel: "#incidents"
repos:
  allowlist:
    - /Users/won/Work/incident-chatops-worker
worktree:
  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees
branch:
  prefix: incident/
slack:
  channels:
    default: "#incidents"
runners:
  genericCommandAllowlist:
    - echo
  definitions:
    - id: echo-safe
      type: generic
      command: echo
mr:
${mrYaml}
`

export const createWorkflowTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-cli-"))
  tempDirs.push(dir)
  return dir
}

export const loadRoutingSettings = (
  env: Readonly<Record<string, string>>,
  mrYaml: string,
): WorkerSettings => {
  const dir = createWorkflowTempDir()
  const configPath = join(dir, "worker.yaml")
  const envFilePath = join(dir, "worker.env")
  writeFileSync(configPath, configYaml(mrYaml))
  writeFileSync(
    envFilePath,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
  )
  return loadWorkerSettings({ configPath, envFilePath })
}

export const readSavedMrLinks = (dbPath: string): readonly SavedMrLink[] => {
  const db = openDatabase(dbPath, false)
  try {
    const rows = db.exec("SELECT provider, url FROM mr_links ORDER BY created_at ASC")
    return (
      rows[0]?.values.map((row) => ({
        provider: String(row[0]),
        url: String(row[1]),
      })) ?? []
    )
  } finally {
    db.close()
  }
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

export const routingDetectedIncident = {
  channelId: "C123",
  firstSeenAt: "2026-06-29T00:00:00.000Z",
  issueId: "SENTRY-10",
  lastSeenAt: "2026-06-29T00:01:00.000Z",
  repoId: "frontend-sentry",
  repoPath: "/Users/won/Work/incident-chatops-worker",
  threadTs: "1712345678.000100",
  title: "Checkout crash",
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

export const routingFixAndMrAction = (): SlackActionIntent => ({
  actionId: SlackActionIds.fixAndMr,
  actor: { slackUserId: slackUserId("U123") },
  channel: { id: slackChannelId("C123") },
  issueId: sentryIssueId("SENTRY-10"),
  kind: "fix_requested",
  repoId: repoId("frontend-sentry"),
  thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
})

type CreateWorkflowOptions = {
  readonly allowedRunnerCommands?: readonly string[]
  readonly mrProvider?: RecordingMergeRequestProvider
  readonly sentryContext?: {
    readonly fetchIssueContext: (incident: IncidentRecord) => Promise<RunnerIncidentContext>
  }
  readonly sentryContextSecretValues?: readonly string[]
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
