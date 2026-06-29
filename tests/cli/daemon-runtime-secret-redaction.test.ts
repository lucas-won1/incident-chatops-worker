import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createProductionDaemonWorkflowRuntime } from "../../src/cli/daemon-runtime.js"
import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"
import {
  repoId,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../../src/domain/ids.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { createTempDir } from "./command-fixtures.js"

vi.mock("ky", () => ({
  default: {
    post: vi.fn(async () => ({
      json: async () => ({ ok: true, ts: "1712345678.000200" }),
      status: 200,
    })),
  },
}))

const envFileSecrets = {
  github: "github_pat_envfile_exact_secret",
  gitlab: "envfile_gitlab_exact_secret",
  sentry: "envfile_sentry_exact_secret",
  slackApp: "envfile_slack_app_exact_secret",
  slackBot: "envfile_slack_bot_exact_secret",
} as const

const serviceTokenEnvNames = [
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
] as const

type RedactionScenario = {
  readonly issueId: string
  readonly provider: "gitlab" | "github"
}

const withNoServiceTokenProcessEnv = async (action: () => Promise<void>): Promise<void> => {
  const originalValues = Object.fromEntries(
    serviceTokenEnvNames.map((name) => [name, process.env[name]]),
  )
  for (const name of serviceTokenEnvNames) {
    delete process.env[name]
  }
  try {
    await action()
  } finally {
    for (const name of serviceTokenEnvNames) {
      const value = originalValues[name]
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

const initRepo = (repoPath: string): void => {
  mkdirSync(repoPath, { recursive: true })
  execFileSync("git", ["init"], { cwd: repoPath })
  writeFileSync(join(repoPath, "README.md"), "fixture\n")
  execFileSync("git", ["add", "README.md"], { cwd: repoPath })
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
    { cwd: repoPath },
  )
}

const writeCodexFixture = (scriptPath: string, capturePath: string): void => {
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const outputPath = args[args.indexOf("--output-last-message") + 1]
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
  GITLAB_TOKEN: process.env.GITLAB_TOKEN ?? null,
  SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN ?? null,
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? null,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? null,
}))
fs.writeFileSync(outputPath, JSON.stringify({
  analysis: "analysis leaked ${envFileSecrets.gitlab} and ${envFileSecrets.github}",
}))
process.stdout.write("stdout leaked ${envFileSecrets.sentry}")
process.stderr.write("stderr leaked ${envFileSecrets.slackBot}")
`,
  )
  chmodSync(scriptPath, 0o700)
}

const providerEnv = {
  github: { GITHUB_TOKEN: envFileSecrets.github },
  gitlab: { GITLAB_TOKEN: envFileSecrets.gitlab },
} as const

const providerConfigYaml = {
  gitlab: `provider: gitlab
  gitlab:
    baseUrl: https://gitlab.example/api/v4
    project: demo/repo-api`,
  github: `provider: github
  github:
    baseUrl: https://api.github.example
    owner: demo
    repo: repo-api`,
} as const

const providerUrl = {
  github: "https://github.example/demo/repo/pull/1",
  gitlab: "https://gitlab.example/mr/1",
} as const

const expectedChildEnvCapture = {
  GITHUB_TOKEN: null,
  GITLAB_TOKEN: null,
  SENTRY_AUTH_TOKEN: null,
  SLACK_APP_TOKEN: null,
  SLACK_BOT_TOKEN: null,
} as const

const runRedactionScenario = async (
  scenario: RedactionScenario,
): Promise<{
  readonly capturePath: string
  readonly summaryMarkdown: string
}> => {
  const root = createTempDir()
  const repoPath = join(root, "repo")
  const worktreeRoot = join(root, "worktrees")
  const capturePath = join(root, "child-env.json")
  const codexBin = join(root, "codex-fixture.js")
  initRepo(repoPath)
  const allowedRepoPath = realpathSync(repoPath)
  writeCodexFixture(codexBin, capturePath)
  vi.stubEnv("CODEX_BIN", codexBin)

  const env = parseWorkerEnv({
    ...providerEnv[scenario.provider],
    SENTRY_AUTH_TOKEN: envFileSecrets.sentry,
    SENTRY_BASE_URL: "https://sentry.invalid/api/0",
    SLACK_APP_TOKEN: envFileSecrets.slackApp,
    SLACK_BOT_TOKEN: envFileSecrets.slackBot,
    STATE_DB_PATH: join(root, "state.sqlite"),
  })
  const config = parseWorkerConfigYaml(
    `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: repo-api
      slackChannel: "#incidents"
repos:
  allowlist:
    - ${allowedRepoPath}
worktree:
  root: ${worktreeRoot}
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
  ${providerConfigYaml[scenario.provider]}
  defaultTargetBranch: main
`,
    env,
  )

  let summaryMarkdown = ""
  await withNoServiceTokenProcessEnv(async () => {
    const runtime = createProductionDaemonWorkflowRuntime(
      { config, env },
      {
        mrProviderFactory: () => ({
          provider: scenario.provider,
          createMergeRequest: async () => ({ url: providerUrl[scenario.provider] }),
        }),
      },
    )
    const state = runtime.stateStore
    if (state === undefined) {
      throw new Error("expected production state store")
    }
    const upserted = state.upsertIncident({
      channelId: "C123",
      firstSeenAt: "2026-06-27T00:00:00.000Z",
      issueId: scenario.issueId,
      lastSeenAt: "2026-06-27T00:00:00.000Z",
      repoId: "repo-api",
      threadTs: "1712345678.000100",
      title: "production env-file redaction gap",
    })
    state.saveSentryIssueSnapshot?.({
      capturedAt: "2026-06-27T00:00:01.000Z",
      incidentId: upserted.incidentId,
      issueId: scenario.issueId,
      snapshotJson: JSON.stringify({
        issueId: scenario.issueId,
        title: "production env-file redaction gap",
        trustBoundary: "untrusted_external_sentry",
      }),
    })

    await runtime.handleSlackAction({
      actionId: SlackActionIds.analyze,
      actor: { slackUserId: slackUserId("U123") },
      channel: { id: slackChannelId("C123") },
      issueId: sentryIssueId(scenario.issueId),
      kind: "analyze_requested",
      repoId: repoId("repo-api"),
      thread: { channelId: slackChannelId("C123"), threadTs: slackThreadTs("1712345678.000100") },
    })
    const summary = state.getLatestAnalysisSummary(upserted.incidentId)
    if (summary === undefined) {
      throw new Error(JSON.stringify(state.listAuditEntries()))
    }
    summaryMarkdown = summary.summaryMarkdown
    await runtime.stop?.()
  })
  return { capturePath, summaryMarkdown }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("production daemon env-file secret redaction", () => {
  it("redacts env-file-only service tokens from Codex output without passing them to the child env", async () => {
    // Given: production settings contain service tokens that are not present in process.env.
    const result = await runRedactionScenario({
      issueId: "SENTRY-PROD-ENV",
      provider: "gitlab",
    })
    // When: production runtime handles an approved analysis action through the real Codex runner.
    expect(result.summaryMarkdown).toContain("[REDACTED]")
    expect(result.summaryMarkdown).not.toContain(envFileSecrets.gitlab)
    // Then: service tokens are absent from the child env capture but redacted from persisted output.
    expect(JSON.parse(readFileSync(result.capturePath, "utf8"))).toEqual(expectedChildEnvCapture)
  })

  it("redacts selected GitHub service token from Codex output without passing it to the child env", async () => {
    // Given: production GitHub settings contain a GitHub token that is not present in process.env.
    const result = await runRedactionScenario({
      issueId: "SENTRY-PROD-GITHUB",
      provider: "github",
    })
    // When: production runtime handles an approved analysis action through the real Codex runner.
    expect(result.summaryMarkdown).toContain("[REDACTED]")
    expect(result.summaryMarkdown).not.toContain(envFileSecrets.github)
    // Then: GitHub token is absent from the child env capture but redacted from persisted output.
    expect(JSON.parse(readFileSync(result.capturePath, "utf8"))).toEqual(expectedChildEnvCapture)
  })
})
