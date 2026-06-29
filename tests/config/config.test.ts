import { describe, expect, it } from "vitest"

import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"

const validEnv = {
  SLACK_APP_TOKEN: "xapp-redacted-example",
  SLACK_BOT_TOKEN: "xoxb-redacted-example",
  SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
  GITLAB_TOKEN: "glpat-redacted-example",
  HOME: "/Users/won",
}

const configuredGitLabBaseUrl = ["https:", "", "gitlab.example", "api", "v4"].join("/")

const gitLabRoutingBlock = `  gitlab:\n    baseUrl: ${configuredGitLabBaseUrl}\n    project: acme/frontend\n    defaultLabels:\n      - incident-chatops\n      - automated\n    draft: true\n`
const githubRoutingBlock =
  "  github:\n    baseUrl: https://api.github.com\n    owner: acme\n    repo: frontend\n    defaultLabels:\n      - incident-chatops\n    draft: false\n"
const validYaml = `sentry:\n  projects:\n    - organizationSlug: demo-org\n      projectSlug: frontend\n      slackChannel: "#incidents"\nrepos:\n  allowlist:\n    - /Users/won/Work/incident-chatops-worker\nworktree:\n  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees\nbranch:\n  prefix: incident/\nslack:\n  channels:\n    default: "#incidents"\nrunners:\n  genericCommandAllowlist:\n    - echo\n  definitions:\n    - id: echo-safe\n      type: generic\n      command: echo\n      args:\n        - safe\nmr:\n  provider: gitlab\n${gitLabRoutingBlock}  defaultTargetBranch: main\n`

const validGithubYaml = validYaml.replace(
  `  provider: gitlab\n${gitLabRoutingBlock}`,
  `  provider: github\n${githubRoutingBlock}`,
)

type StatePathScenario = {
  readonly name: string
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string>>
  readonly expected: string
}

const statePathScenarios = [
  {
    name: "macOS",
    platform: "darwin",
    env: { HOME: "/Users/demo" },
    expected: "/Users/demo/Library/Application Support/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Linux XDG",
    platform: "linux",
    env: { HOME: "/home/demo", XDG_STATE_HOME: "/tmp/xdg-state" },
    expected: "/tmp/xdg-state/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Linux home fallback",
    platform: "linux",
    env: { HOME: "/home/demo" },
    expected: "/home/demo/.local/state/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Windows",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
    expected: "C:\\Users\\demo\\AppData\\Local\\incident-chatops-worker\\state.sqlite",
  },
] satisfies readonly StatePathScenario[]

const yamlWithoutAllowlists = validYaml
  .replace("repos:\n  allowlist:\n    - /Users/won/Work/incident-chatops-worker\n", "")
  .replace("  genericCommandAllowlist:\n    - echo\n", "")

const unsafeYaml = validYaml
  .replace("    - /Users/won/Work/incident-chatops-worker", "    - ../incident-chatops-worker")
  .replace("  prefix: incident/", "  prefix: ../incident/")
  .replace("      command: echo", "      command: /bin/sh")

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

  it.each(statePathScenarios)(
    "uses the automatic $name state database path when env omits STATE_DB_PATH",
    ({ env, expected, platform }) => {
      // Given: required secrets are present and the OS state base is available.
      const input = { ...validEnv, ...env }

      // When: env crosses the config boundary without an explicit DB override.
      const parsed = parseWorkerEnv(input, { platform })

      // Then: the durable OS-specific state path is selected.
      expect(parsed.stateDbPath).toBe(expected)
    },
  )

  it("uses explicit STATE_DB_PATH override instead of the automatic state database path", () => {
    // Given: env includes both a HOME base and an explicit DB path.
    const env = {
      ...validEnv,
      HOME: "/Users/demo",
      STATE_DB_PATH: "/tmp/incident-worker/override.sqlite",
    }

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env, { platform: "darwin" })

    // Then: the explicit override wins.
    expect(parsed.stateDbPath).toBe("/tmp/incident-worker/override.sqlite")
  })

  it("rejects missing OS state base env when STATE_DB_PATH is omitted", () => {
    // Given: env omits both STATE_DB_PATH and the required macOS HOME base.
    const env = {
      SLACK_APP_TOKEN: "xapp-redacted-example",
      SLACK_BOT_TOKEN: "xoxb-redacted-example",
      SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
      GITLAB_TOKEN: "glpat-redacted-example",
    }

    // When / Then: validation fails instead of falling back to the working directory.
    expect(() => parseWorkerEnv(env, { platform: "darwin" })).toThrow(/HOME/)
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

  it("accepts GitHub provider routing config without GitLab routing", () => {
    // Given: GitHub is selected and only GitHub non-secret routing is present.
    const env = parseWorkerEnv({ ...validEnv, GITHUB_TOKEN: "ghp-redacted-example" })

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(validGithubYaml, env)

    // Then: GitHub routing is typed without requiring GitLab routing.
    expect(config.mr.provider).toBe("github")
    expect(config.mr.github).toEqual({
      baseUrl: "https://api.github.com",
      defaultLabels: ["incident-chatops"],
      draft: false,
      owner: "acme",
      repo: "frontend",
    })
  })

  it("rejects secrets placed in YAML", () => {
    // Given: YAML attempts to carry a GitLab token.
    const env = parseWorkerEnv(validEnv)
    const yamlWithSecret = `${validYaml}\ngitlab:\n  token: glpat-should-not-be-here\n`

    // When / Then: validation rejects secret material at the YAML boundary.
    expect(() => parseWorkerConfigYaml(yamlWithSecret, env)).toThrow(/secret/i)
  })

  it("rejects GitHub token-looking values placed in YAML", () => {
    // Given: YAML attempts to carry a GitHub token-shaped value.
    const env = parseWorkerEnv(validEnv)
    const yamlWithSecret = `${validYaml}\nnotes:\n  example: ghp_should_not_be_here\n`

    // When / Then: validation rejects secret material at the YAML boundary.
    expect(() => parseWorkerConfigYaml(yamlWithSecret, env)).toThrow(/secret/i)
  })

  it("rejects missing explicit GitLab routing", () => {
    // Given: YAML config omits production GitLab API and project routing.
    const env = parseWorkerEnv(validEnv)
    const yamlWithoutGitLabRouting = validYaml.replace(gitLabRoutingBlock, "")

    // When / Then: validation fails closed instead of deriving a project from Sentry data.
    expect(() => parseWorkerConfigYaml(yamlWithoutGitLabRouting, env)).toThrow(/gitlab/i)
  })

  it("rejects missing repo and command allowlists", () => {
    // Given: YAML omits repo and command allowlists.
    const env = parseWorkerEnv(validEnv)

    // When / Then: validation fails closed instead of allowing arbitrary repos or commands.
    expect(() => parseWorkerConfigYaml(yamlWithoutAllowlists, env)).toThrow(/allowlist/i)
  })

  it("rejects unsafe repo paths, branch prefixes, and unallowlisted absolute commands", () => {
    // Given: YAML policy contains path traversal, unsafe branch text, and an absolute command
    // outside the allowlist.
    const env = parseWorkerEnv(validEnv)

    // When / Then: all unsafe policy classes are rejected at parse time.
    expect(() => parseWorkerConfigYaml(unsafeYaml, env)).toThrow(/repo|branch|command/i)
  })
})
