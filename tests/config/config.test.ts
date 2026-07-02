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

const genericRunnerBlock = `  generic:\n    analysisCommandId: echo-analysis\n    fixCommandId: echo-fix\n    commandAllowlist:\n      - echo\n    definitions:\n      - id: echo-analysis\n        type: generic\n        command: echo\n        args:\n          - analysis\n      - id: echo-fix\n        type: generic\n        command: echo\n        args:\n          - fix\n`

const yamlWithRunnerBlock = (runnerBlock: string): string =>
  validYaml.replace(
    `  genericCommandAllowlist:\n    - echo\n  definitions:\n    - id: echo-safe\n      type: generic\n      command: echo\n      args:\n        - safe\n`,
    runnerBlock,
  )

const yamlWithoutAllowlists = validYaml
  .replace("repos:\n  allowlist:\n    - /Users/won/Work/incident-chatops-worker\n", "")
  .replace("  genericCommandAllowlist:\n    - echo\n", "")

const unsafeYaml = validYaml
  .replace("    - /Users/won/Work/incident-chatops-worker", "    - ../incident-chatops-worker")
  .replace("  prefix: incident/", "  prefix: ../incident/")
  .replace("      command: echo", "      command: /bin/sh")

describe("worker YAML config parsing", () => {
  it("accepts non-secret policy config with allowlists and safe defaults", () => {
    // Given: a YAML policy file that contains mappings but no secrets.
    const env = parseWorkerEnv(validEnv)

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(validYaml, env)

    // Then: the typed policy exposes only non-secret settings.
    expect(config.branchPrefix).toBe("incident/")
    expect(config.repos.allowlist).toEqual(["/Users/won/Work/incident-chatops-worker"])
    expect(config.runners.provider).toBe("codex")
    expect(config.runners.generic.commandAllowlist).toEqual(["echo"])
    expect(config.runners.generic.definitions[0]?.id).toBe("echo-safe")
    expect(config.runners.definitions[0]?.id).toBe("echo-safe")
    expect(config.worktreePrepare).toEqual({ commands: [], timeoutMs: 600_000 })
    expect(config.mr.provider).toBe("gitlab")
    expect(config.mr.gitlab).toEqual({
      baseUrl: configuredGitLabBaseUrl,
      defaultLabels: ["incident-chatops", "automated"],
      draft: true,
      project: "acme/frontend",
    })
  })

  it("accepts worktree preparation commands for project bootstrap", () => {
    // Given: YAML declares a dependency bootstrap command to run before the agent starts.
    const env = parseWorkerEnv(validEnv)
    const yaml = validYaml.replace(
      "worktree:\n  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees\n",
      `worktree:
  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees
  prepare:
    timeoutMs: 900000
    commands:
      - command: pnpm
        args:
          - install
          - --frozen-lockfile
`,
    )

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(yaml, env)

    // Then: the command is preserved as structured argv policy, not as a shell string.
    expect(config.worktreePrepare).toEqual({
      commands: [{ args: ["install", "--frozen-lockfile"], command: "pnpm" }],
      timeoutMs: 900_000,
    })
  })

  it("accepts Claude Code runner provider instance config", () => {
    // Given: YAML selects Claude Code with safe headless CLI settings.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: claude-code\n  claudeCode:\n    bin: claude\n    configDir: /Users/won/.claude-worker\n    settingsPath: /Users/won/.claude-worker/settings.json\n    model: claude-sonnet-4\n    permissionMode: acceptEdits\n    allowedTools:\n      - Bash\n      - Edit\n    disallowedTools:\n      - WebFetch\n    extraEnvAllowlist:\n      - LANG\n${genericRunnerBlock}`,
    )

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(yaml, env)

    // Then: the Claude Code instance settings are typed and normalized.
    expect(config.runners.provider).toBe("claude-code")
    expect(config.runners.claudeCode).toEqual({
      allowedTools: ["Bash", "Edit"],
      bin: "claude",
      configDir: "/Users/won/.claude-worker",
      disallowedTools: ["WebFetch"],
      extraEnvAllowlist: ["LANG"],
      model: "claude-sonnet-4",
      permissionMode: "acceptEdits",
      settingsPath: "/Users/won/.claude-worker/settings.json",
    })
  })

  it("accepts Generic runner provider config with mode command ids", () => {
    // Given: YAML selects generic and names separate analysis and fix commands.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(`  provider: generic\n${genericRunnerBlock}`)

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(yaml, env)

    // Then: the generic provider config is normalized and legacy aliases remain populated.
    expect(config.runners.provider).toBe("generic")
    expect(config.runners.generic.analysisCommandId).toBe("echo-analysis")
    expect(config.runners.generic.fixCommandId).toBe("echo-fix")
    expect(config.runners.generic.commandAllowlist).toEqual(["echo"])
    expect(config.runners.generic.definitions.map((runner) => runner.id)).toEqual([
      "echo-analysis",
      "echo-fix",
    ])
    expect(config.runners.genericCommandAllowlist).toEqual(["echo"])
    expect(config.runners.definitions.map((runner) => runner.id)).toEqual([
      "echo-analysis",
      "echo-fix",
    ])
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

  it("rejects an unknown runner provider", () => {
    // Given: YAML names a runner provider outside the supported daemon-global set.
    const env = parseWorkerEnv(validEnv)
    const yaml = validYaml.replace("runners:\n", "runners:\n  provider: unknown-ai\n")

    // When / Then: validation fails at the config boundary.
    expect(() => parseWorkerConfigYaml(yaml, env)).toThrow(/provider/i)
  })

  it("rejects secret-looking runner env allowlist names", () => {
    // Given: YAML attempts to pass credential-like env names to a runner child process.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: codex\n  codex:\n    extraEnvAllowlist:\n      - SENTRY_TOKEN\n${genericRunnerBlock}`,
    )

    // When / Then: validation rejects the env name before runtime runner selection.
    expect(() => parseWorkerConfigYaml(yaml, env)).toThrow(/SENTRY_TOKEN|extraEnvAllowlist/i)
  })

  it("rejects dangerous Claude Code permission bypass mode", () => {
    // Given: YAML attempts to configure Claude Code with the bypass permission mode.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: claude-code\n  claudeCode:\n    permissionMode: bypassPermissions\n${genericRunnerBlock}`,
    )

    // When / Then: validation fails closed before a Claude CLI can be started.
    expect(() => parseWorkerConfigYaml(yaml, env)).toThrow(/bypassPermissions|permissionMode/i)
  })

  it("rejects flag-looking Claude Code permission bypass mode", () => {
    // Given: YAML attempts to smuggle a dangerous Claude permission flag as a mode value.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: claude-code\n  claudeCode:\n    permissionMode: --dangerously-skip-permissions\n${genericRunnerBlock}`,
    )

    // When / Then: validation fails before adapter construction.
    expect(() => parseWorkerConfigYaml(yaml, env)).toThrow(/dangerously|permissionMode/i)
  })

  it("rejects unsafe repo paths, branch prefixes, and unallowlisted absolute commands", () => {
    // Given: YAML policy contains path traversal, unsafe branch text, and an absolute command
    // outside the allowlist.
    const env = parseWorkerEnv(validEnv)

    // When / Then: all unsafe policy classes are rejected at parse time.
    expect(() => parseWorkerConfigYaml(unsafeYaml, env)).toThrow(/repo|branch|command/i)
  })
})
