import { describe, expect, it } from "vitest"

import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"

const validEnv = {
  SLACK_APP_TOKEN: "xapp-redacted-example",
  SLACK_BOT_TOKEN: "xoxb-redacted-example",
  SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
  GITLAB_TOKEN: "glpat-redacted-example",
}

const configuredGitLabBaseUrl = ["https:", "", "gitlab.example", "api", "v4"].join("/")

const validYaml = `
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
      args:
        - safe
mr:
  provider: gitlab
  gitlab:
    baseUrl: ${configuredGitLabBaseUrl}
    project: acme/frontend
    defaultLabels:
      - incident-chatops
      - automated
    draft: true
  defaultTargetBranch: main
`

describe("worker env parsing", () => {
  it("defaults the Sentry poll interval to 300 seconds when env omits it", () => {
    // Given: required secrets are present and polling env is omitted.
    const env = validEnv

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env)

    // Then: the conservative default cadence is used.
    expect(parsed.sentryPollIntervalSeconds).toBe(300)
    expect(parsed.sentryPollMinIntervalSeconds).toBe(60)
  })

  it("uses the env poll interval override when it is not below the minimum", () => {
    // Given: required secrets and an explicit safe polling cadence.
    const env = {
      ...validEnv,
      SENTRY_POLL_INTERVAL_SECONDS: "600",
      SENTRY_POLL_MIN_INTERVAL_SECONDS: "60",
    }

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env)

    // Then: the override is preserved exactly.
    expect(parsed.sentryPollIntervalSeconds).toBe(600)
  })

  it("rejects an env poll interval below the configured minimum", () => {
    // Given: polling is configured faster than the minimum.
    const env = {
      ...validEnv,
      SENTRY_POLL_INTERVAL_SECONDS: "30",
      SENTRY_POLL_MIN_INTERVAL_SECONDS: "60",
    }

    // When / Then: validation rejects the unsafe cadence by env name.
    expect(() => parseWorkerEnv(env)).toThrow(/SENTRY_POLL_INTERVAL_SECONDS/)
  })
})

describe("worker YAML config parsing", () => {
  it("accepts non-secret policy config with allowlists and safe defaults", () => {
    // Given: a YAML policy file that contains mappings but no secrets.
    const env = parseWorkerEnv(validEnv)

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(validYaml, env)

    // Then: the typed policy exposes only non-secret settings.
    expect(config.branchPrefix).toBe("incident/")
    expect(config.repos.allowlist).toEqual(["/Users/won/Work/incident-chatops-worker"])
    expect(config.runners.definitions[0]?.id).toBe("echo-safe")
    expect(config.mr.provider).toBe("gitlab")
    expect(config.mr.gitlab).toEqual({
      baseUrl: configuredGitLabBaseUrl,
      defaultLabels: ["incident-chatops", "automated"],
      draft: true,
      project: "acme/frontend",
    })
  })

  it("rejects secrets placed in YAML", () => {
    // Given: YAML attempts to carry a GitLab token.
    const env = parseWorkerEnv(validEnv)
    const yamlWithSecret = `${validYaml}\ngitlab:\n  token: glpat-should-not-be-here\n`

    // When / Then: validation rejects secret material at the YAML boundary.
    expect(() => parseWorkerConfigYaml(yamlWithSecret, env)).toThrow(/secret/i)
  })

  it("rejects missing explicit GitLab routing", () => {
    // Given: YAML config omits production GitLab API and project routing.
    const env = parseWorkerEnv(validEnv)
    const gitLabRoutingBlock = `  gitlab:
    baseUrl: ${configuredGitLabBaseUrl}
    project: acme/frontend
    defaultLabels:
      - incident-chatops
      - automated
    draft: true
`
    const yamlWithoutGitLabRouting = validYaml.replace(gitLabRoutingBlock, "")

    // When / Then: validation fails closed instead of deriving a project from Sentry data.
    expect(() => parseWorkerConfigYaml(yamlWithoutGitLabRouting, env)).toThrow(/gitlab/i)
  })

  it("rejects missing repo and command allowlists", () => {
    // Given: YAML omits repo and command allowlists.
    const env = parseWorkerEnv(validEnv)
    const yamlWithoutAllowlists = `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
      slackChannel: "#incidents"
worktree:
  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees
branch:
  prefix: incident/
slack:
  channels:
    default: "#incidents"
runners:
  definitions:
    - id: echo-safe
      type: generic
      command: echo
mr:
  defaultTargetBranch: main
`

    // When / Then: validation fails closed instead of allowing arbitrary repos or commands.
    expect(() => parseWorkerConfigYaml(yamlWithoutAllowlists, env)).toThrow(/allowlist/i)
  })

  it("rejects unsafe repo paths, branch prefixes, and unallowlisted absolute commands", () => {
    // Given: YAML policy contains path traversal, unsafe branch text, and an absolute command
    // outside the allowlist.
    const env = parseWorkerEnv(validEnv)
    const unsafeYaml = `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
      slackChannel: "#incidents"
repos:
  allowlist:
    - ../incident-chatops-worker
worktree:
  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees
branch:
  prefix: ../incident/
slack:
  channels:
    default: "#incidents"
runners:
  genericCommandAllowlist:
    - echo
  definitions:
    - id: shell
      type: generic
      command: /bin/sh
mr:
  defaultTargetBranch: main
`

    // When / Then: all unsafe policy classes are rejected at parse time.
    expect(() => parseWorkerConfigYaml(unsafeYaml, env)).toThrow(/repo|branch|command/i)
  })
})
