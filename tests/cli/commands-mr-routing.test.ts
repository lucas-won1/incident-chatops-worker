import { describe, expect, it } from "vitest"

import { createProductionDaemonWorkflowRuntime } from "../../src/cli/daemon-runtime.js"
import type {
  CreateMergeRequestInput,
  CreateMergeRequestResult,
  MergeRequestProviderId,
} from "../../src/mr/types.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  RecordingSlackPublisher,
  runnerResult,
} from "../workflow/incident-workflow-fakes.js"
import {
  configuredGitHubBaseUrl,
  configuredGitLabBaseUrl,
  createWorkflowTempDir,
  loadRoutingSettings,
  readSavedMrLinks,
  routingDetectedIncident,
  routingFixAndMrAction,
} from "../workflow/incident-workflow-support.js"

type CapturedGitLabRoute = {
  readonly baseUrl: string
  readonly project: string
  readonly provider: MergeRequestProviderId
  readonly token: string
}

type CapturedGitHubRoute = {
  readonly baseUrl: string
  readonly owner: string
  readonly provider: MergeRequestProviderId
  readonly repo: string
  readonly token: string
}

describe("production MR routing", () => {
  it("configures production GitLab MR routing from YAML instead of Sentry project defaults", async () => {
    // Given: production settings with a GitLab project that differs from the Sentry project slug.
    const settings = loadRoutingSettings(
      {
        GITLAB_TOKEN: "glpat-redacted-example",
        SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
        SLACK_APP_TOKEN: "xapp-redacted-example",
        SLACK_BOT_TOKEN: "xoxb-redacted-example",
        STATE_DB_PATH: `${createWorkflowTempDir()}/state.sqlite`,
      },
      `
  provider: gitlab
  gitlab:
    baseUrl: ${configuredGitLabBaseUrl}
    project: platform/service-api
    defaultLabels:
      - incident-chatops
    draft: true
  defaultTargetBranch: main
`,
    )
    let capturedRoute: CapturedGitLabRoute | undefined

    // When: the production daemon runtime wires its MR provider.
    const runtime = createProductionDaemonWorkflowRuntime(settings, {
      mrProviderFactory: (options) => {
        if (options.provider !== "gitlab") {
          throw new Error(`expected GitLab route, got ${options.provider}`)
        }
        capturedRoute = {
          baseUrl: options.baseUrl,
          project: options.project,
          provider: options.provider,
          token: options.token,
        }
        return {
          provider: "gitlab",
          createMergeRequest: async (
            _input: CreateMergeRequestInput,
          ): Promise<CreateMergeRequestResult> => ({
            url: "https://gitlab.internal.example/platform/service-api/-/merge_requests/1",
          }),
        }
      },
    })
    await runtime.stop?.()

    // Then: configured GitLab route is used instead of the Sentry project slug.
    expect(capturedRoute).toEqual({
      baseUrl: configuredGitLabBaseUrl,
      project: "platform/service-api",
      provider: "gitlab",
      token: "glpat-redacted-example",
    })
    expect(capturedRoute?.project).not.toBe("frontend-sentry")
  })

  it("configures production GitHub PR routing from selected provider settings", async () => {
    // Given: production settings select GitHub without a GitLab token or GitLab route.
    const settings = loadRoutingSettings(
      {
        GITHUB_TOKEN: "github_pat_redacted_example",
        SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
        SLACK_APP_TOKEN: "xapp-redacted-example",
        SLACK_BOT_TOKEN: "xoxb-redacted-example",
        STATE_DB_PATH: `${createWorkflowTempDir()}/state.sqlite`,
      },
      `
  provider: github
  github:
    baseUrl: ${configuredGitHubBaseUrl}
    owner: platform
    repo: service-api
    defaultLabels:
      - incident-chatops
    draft: true
  defaultTargetBranch: main
`,
    )
    let capturedRoute: CapturedGitHubRoute | undefined

    // When: the production daemon runtime wires its PR provider.
    const runtime = createProductionDaemonWorkflowRuntime(settings, {
      mrProviderFactory: (options) => {
        if (options.provider !== "github") {
          throw new Error(`expected GitHub route, got ${options.provider}`)
        }
        capturedRoute = {
          baseUrl: options.baseUrl,
          owner: options.owner,
          provider: options.provider,
          repo: options.repo,
          token: options.token,
        }
        return {
          provider: "github",
          createMergeRequest: async (
            _input: CreateMergeRequestInput,
          ): Promise<CreateMergeRequestResult> => ({
            url: "https://github.enterprise.example/platform/service-api/pull/1",
          }),
        }
      },
    })
    await runtime.stop?.()

    // Then: the selected GitHub route and only the GitHub token are passed to provider creation.
    expect(capturedRoute).toEqual({
      baseUrl: configuredGitHubBaseUrl,
      owner: "platform",
      provider: "github",
      repo: "service-api",
      token: "github_pat_redacted_example",
    })
  })

  it("runs GitHub settings through production runtime provider creation and workflow success", async () => {
    // Given: GitHub settings loaded from config/env and local fakes for runtime side effects.
    const prUrl = "https://github.enterprise.example/platform/service-api/pull/19"
    const stateDbPath = `${createWorkflowTempDir()}/state.sqlite`
    const settings = loadRoutingSettings(
      {
        GITHUB_TOKEN: "github_pat_redacted_example",
        SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
        SLACK_APP_TOKEN: "xapp-redacted-example",
        SLACK_BOT_TOKEN: "xoxb-redacted-example",
        STATE_DB_PATH: stateDbPath,
      },
      `
  provider: github
  github:
    baseUrl: ${configuredGitHubBaseUrl}
    owner: platform
    repo: service-api
    defaultLabels:
      - incident-chatops
    draft: false
  defaultTargetBranch: main
`,
    )
    const mrProvider = new RecordingMergeRequestProvider("github", prUrl)
    const repo = new RecordingRepoAdapter()
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const slack = new RecordingSlackPublisher()
    let capturedRoute: CapturedGitHubRoute | undefined
    const runtime = createProductionDaemonWorkflowRuntime(settings, {
      mrProviderFactory: (options) => {
        if (options.provider !== "github") {
          throw new Error(`expected GitHub route, got ${options.provider}`)
        }
        capturedRoute = {
          baseUrl: options.baseUrl,
          owner: options.owner,
          provider: options.provider,
          repo: options.repo,
          token: options.token,
        }
        return mrProvider
      },
      repo,
      runner,
      sentryContext: {
        fetchIssueContext: async (incident) => ({
          events: [{ issueId: incident.issueId, title: incident.title }],
          issueId: incident.issueId,
          title: incident.title,
          trustBoundary: "untrusted_external_sentry",
        }),
      },
      slack,
    })

    try {
      // When: a detected incident is fixed through the production runtime workflow.
      await runtime.handleDetectedIncident(routingDetectedIncident)
      await runtime.handleSlackAction(routingFixAndMrAction())
    } finally {
      await runtime.stop?.()
    }

    // Then: selected GitHub route, DB persistence, and Slack success all agree on the PR URL.
    const slackOutput = JSON.stringify(slack.messages)
    expect(capturedRoute).toEqual({
      baseUrl: configuredGitHubBaseUrl,
      owner: "platform",
      provider: "github",
      repo: "service-api",
      token: "github_pat_redacted_example",
    })
    expect(repo.pushRequests).toHaveLength(1)
    expect(mrProvider.calls).toHaveLength(1)
    expect(readSavedMrLinks(stateDbPath)).toEqual([{ provider: "github", url: prUrl }])
    expect(slackOutput).toContain(prUrl)
    expect(slackOutput).not.toContain("github_pat_redacted_example")
  })
})
