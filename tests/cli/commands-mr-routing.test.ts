import { describe, expect, it } from "vitest"

import { createProductionDaemonWorkflowRuntime } from "../../src/cli/daemon-runtime.js"
import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"
import type { CreateMergeRequestInput, CreateMergeRequestResult } from "../../src/mr/types.js"
import { createTempDir } from "./command-fixtures.js"

const configuredGitLabBaseUrl = ["https:", "", "gitlab.internal.example", "api", "v4"].join("/")

describe("production MR routing", () => {
  it("configures production GitLab MR routing from YAML instead of Sentry project defaults", async () => {
    // Given: production settings with a GitLab project that differs from the Sentry project slug.
    const env = parseWorkerEnv({
      GITLAB_TOKEN: "glpat-redacted-example",
      SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
      SLACK_APP_TOKEN: "xapp-redacted-example",
      SLACK_BOT_TOKEN: "xoxb-redacted-example",
      STATE_DB_PATH: `${createTempDir()}/state.sqlite`,
    })
    const config = parseWorkerConfigYaml(
      `
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
  provider: gitlab
  gitlab:
    baseUrl: ${configuredGitLabBaseUrl}
    project: platform/service-api
    defaultLabels:
      - incident-chatops
    draft: true
  defaultTargetBranch: main
`,
      env,
    )
    let capturedRoute: { readonly baseUrl: string; readonly project: string } | undefined

    // When: the production daemon runtime wires its MR provider.
    const runtime = createProductionDaemonWorkflowRuntime(
      { config, env },
      {
        mrProviderFactory: (options) => {
          capturedRoute = { baseUrl: options.baseUrl, project: options.project }
          return {
            createMergeRequest: async (
              _input: CreateMergeRequestInput,
            ): Promise<CreateMergeRequestResult> => ({
              url: "https://gitlab.internal.example/platform/service-api/-/merge_requests/1",
            }),
          }
        },
      },
    )
    await runtime.stop?.()

    // Then: configured GitLab route is used and the token is not exposed through the capture.
    expect(capturedRoute).toEqual({
      baseUrl: configuredGitLabBaseUrl,
      project: "platform/service-api",
    })
    expect(JSON.stringify(capturedRoute)).not.toContain("glpat-redacted-example")
    expect(capturedRoute?.project).not.toBe("frontend-sentry")
  })
})
