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
import { SlackActionIds, type SlackActionIntent } from "../../src/slack/action-payload.js"

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

export const routingFixAndMrAction = (): SlackActionIntent => ({
  actionId: SlackActionIds.fixAndMr,
  actor: { slackUserId: slackUserId("U123") },
  channel: { id: slackChannelId("C123") },
  issueId: sentryIssueId("SENTRY-10"),
  kind: "fix_requested",
  repoId: repoId("frontend-sentry"),
  thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
