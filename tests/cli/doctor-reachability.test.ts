import { beforeEach, describe, expect, it, vi } from "vitest"

import { checkTokenReachability } from "../../src/cli/doctor.js"
import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"

const requestLog: Array<{
  readonly headers: Readonly<Record<string, string>>
  readonly method: "get" | "post"
  readonly url: string
}> = []

vi.mock("ky", () => ({
  default: {
    get: vi.fn(
      async (url: string, options: { readonly headers?: Readonly<Record<string, string>> }) => {
        requestLog.push({ headers: options.headers ?? {}, method: "get", url })
        return {
          json: async () => ({ ok: true }),
          status: 200,
        }
      },
    ),
    post: vi.fn(
      async (url: string, options: { readonly headers?: Readonly<Record<string, string>> }) => {
        requestLog.push({ headers: options.headers ?? {}, method: "post", url })
        return {
          json: async () => ({ ok: true, url: "wss://slack.example/socket" }),
          status: 200,
        }
      },
    ),
  },
}))

const gitProviderYaml = {
  github: `provider: github
  github:
    baseUrl: https://api.github.example
    owner: demo-org
    repo: frontend`,
  gitlab: `provider: gitlab
  gitlab:
    baseUrl: https://gitlab.example/api/v4
    project: demo-org/frontend`,
} as const

type Provider = keyof typeof gitProviderYaml

const settingsForProvider = (provider: Provider) => {
  const env = parseWorkerEnv({
    GITHUB_TOKEN: "ghp_probe",
    GITLAB_TOKEN: "glpat-probe",
    SENTRY_AUTH_TOKEN: "sntrys_probe",
    SENTRY_BASE_URL: "https://sentry.example/api/0",
    SLACK_APP_TOKEN: "xapp-probe",
    SLACK_BOT_TOKEN: "xoxb-probe",
    STATE_DB_PATH: "/tmp/incident-chatops-worker-test.sqlite",
  })
  const config = parseWorkerConfigYaml(
    `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
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
  ${gitProviderYaml[provider]}
  defaultTargetBranch: main
`,
    env,
  )
  return { config, env }
}

beforeEach(() => {
  requestLog.length = 0
})

describe("doctor live token reachability", () => {
  it("uses GitHub endpoint, bearer header, and selected GitHub token when GitHub is selected", async () => {
    // Given: production settings select GitHub and include both provider token types.
    const settings = settingsForProvider("github")

    // When: live reachability probes run.
    const report = await checkTokenReachability(settings)

    // Then: the provider probe uses the GitHub API surface and GitHub token only.
    expect(report.gitProvider.kind).toBe("ok")
    expect(requestLog).toContainEqual({
      headers: { authorization: "Bearer ghp_probe" },
      method: "get",
      url: "https://api.github.example/user",
    })
    expect(requestLog).not.toContainEqual({
      headers: { "private-token": "glpat-probe" },
      method: "get",
      url: "https://gitlab.com/api/v4/user",
    })
  })

  it("uses GitLab endpoint, private-token header, and selected GitLab token when GitLab is selected", async () => {
    // Given: production settings select GitLab.
    const settings = settingsForProvider("gitlab")

    // When: live reachability probes run.
    const report = await checkTokenReachability(settings)

    // Then: the provider probe keeps the GitLab endpoint/header/token contract.
    expect(report.gitProvider.kind).toBe("ok")
    expect(requestLog).toContainEqual({
      headers: { "private-token": "glpat-probe" },
      method: "get",
      url: "https://gitlab.example/api/v4/user",
    })
  })
})
