import { describe, expect, it } from "vitest"

import { parseWorkerConfigYaml, parseWorkerEnv } from "../../src/config/index.js"

const validEnv = {
  GITLAB_TOKEN: "glpat-redacted-example",
  HOME: "/Users/won",
  SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
  SLACK_APP_TOKEN: "xapp-redacted-example",
  SLACK_BOT_TOKEN: "xoxb-redacted-example",
}

const genericRunnerBlock = `  generic:
    analysisCommandId: echo-analysis
    fixCommandId: echo-fix
    commandAllowlist:
      - echo
    definitions:
      - id: echo-analysis
        type: generic
        command: echo
        args:
          - analysis
      - id: echo-fix
        type: generic
        command: echo
        args:
          - fix
`

const validYaml = `sentry:
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
    baseUrl: https://gitlab.example/api/v4
    project: acme/frontend
  defaultTargetBranch: main
`

const yamlWithRunnerBlock = (runnerBlock: string): string =>
  validYaml.replace(
    `  genericCommandAllowlist:
    - echo
  definitions:
    - id: echo-safe
      type: generic
      command: echo
      args:
        - safe
`,
    runnerBlock,
  )

describe("Codex runner YAML config parsing", () => {
  it("accepts Codex runner provider instance config", () => {
    // Given: YAML selects Codex and configures only non-secret instance settings.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: codex\n  codex:\n    home: /Users/won/.codex-worker\n    bin: codex\n    profile: incident-worker\n    model: gpt-5-codex\n    outputRoot: /Users/won/Work/incident-chatops-worker/.omo/runner-output\n    workspaceWriteNetworkAccess: true\n    extraEnvAllowlist:\n      - LANG\n      - LC_ALL\n${genericRunnerBlock}`,
    )

    // When: YAML crosses the config boundary.
    const config = parseWorkerConfigYaml(yaml, env)

    // Then: provider and instance settings are normalized without runtime side effects.
    expect(config.runners.provider).toBe("codex")
    expect(config.runners.codex).toEqual({
      bin: "codex",
      extraEnvAllowlist: ["LANG", "LC_ALL"],
      home: "/Users/won/.codex-worker",
      model: "gpt-5-codex",
      outputRoot: "/Users/won/Work/incident-chatops-worker/.omo/runner-output",
      profile: "incident-worker",
      workspaceWriteNetworkAccess: true,
    })
  })

  it("rejects removed Codex runner mode", () => {
    // Given: YAML selects Codex and asks for the removed app-server execution policy.
    const env = parseWorkerEnv(validEnv)
    const yaml = yamlWithRunnerBlock(
      `  provider: codex\n  codex:\n    mode: app-server\n${genericRunnerBlock}`,
    )

    // When / Then: YAML fails closed with the removed field named in the error.
    expect(() => parseWorkerConfigYaml(yaml, env)).toThrow(/runners\.codex\.mode/u)
  })
})
