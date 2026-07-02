import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  parseWorkerConfigYaml,
  parseWorkerEnv,
  type WorkerSettings,
} from "../../src/config/index.js"
import type { RunnerAdapter, RunnerCleanChecker, RunnerRequest } from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const runnerResult = {
  analysis: "injected analysis",
  command: "injected",
  mode: "analysis_only",
  stderr: "",
  stdout: "",
} as const

const envForStatePath = (stateDbPath: string) =>
  parseWorkerEnv({
    GITLAB_TOKEN: "glpat-redacted-example",
    HOME: "/Users/won",
    SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
    SLACK_APP_TOKEN: "xapp-redacted-example",
    SLACK_BOT_TOKEN: "xoxb-redacted-example",
    STATE_DB_PATH: stateDbPath,
  })

const baseYaml = `sentry:
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
  generic:
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
mr:
  provider: gitlab
  gitlab:
    baseUrl: https://gitlab.example/api/v4
    project: acme/frontend
  defaultTargetBranch: main
`

const settingsForProvider = (provider: "codex" | "claude-code" | "generic"): WorkerSettings => ({
  config: parseWorkerConfigYaml(
    baseYaml.replace("runners:\n", `runners:\n  provider: ${provider}\n`),
    envForStatePath("/tmp/incident-chatops-worker/state.sqlite"),
  ),
  env: envForStatePath(join(mkdtempSync(join(tmpdir(), "runner-factory-")), "state.sqlite")),
})

const settingsForProjectEnv = (provider: "codex" | "claude-code" | "generic"): WorkerSettings => ({
  config: parseWorkerConfigYaml(
    baseYaml.replace(
      "runners:\n",
      `runners:
  provider: ${provider}
  projectEnv:
    command: /Users/won/.local/bin/mise
    args:
      - exec
      - --
`,
    ),
    envForStatePath("/tmp/incident-chatops-worker/state.sqlite"),
  ),
  env: envForStatePath(join(mkdtempSync(join(tmpdir(), "runner-factory-")), "state.sqlite")),
})

class CleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return true
  }
}

describe("production runner factory", () => {
  it("selects distinct runner paths for codex, generic, and claude-code providers", async () => {
    // Given: normalized settings name each daemon-global runner provider.
    const { createProductionRunner } = await import("../../src/runner/factory.js")

    // When: production runner instances are created from config.
    const codex = createProductionRunner(settingsForProvider("codex"))
    const generic = createProductionRunner(settingsForProvider("generic"))
    const claude = createProductionRunner(settingsForProvider("claude-code"))

    // Then: each provider uses a distinct adapter path.
    expect(codex.constructor.name).toBe("CodexExecRunner")
    expect(generic.constructor.name).toBe("ModeAwareGenericRunner")
    expect(claude.constructor.name).toBe("ClaudeCodeRunner")
  })

  it("routes production daemon runtime through the provider factory when no runner is injected", async () => {
    // Given: config selects Claude Code without injecting a runner.
    const { createProductionDaemonWorkflowRuntime } = await import(
      "../../src/cli/daemon-runtime.js"
    )

    // When: runtime composition uses the production factory.
    const runtime = createProductionDaemonWorkflowRuntime(settingsForProvider("claude-code"), {
      mrProviderFactory: () => ({
        createMergeRequest: async () => ({ url: "https://gitlab.example/mr/1" }),
        provider: "gitlab",
      }),
    })

    // Then: composition succeeds with a factory-created runner.
    expect(runtime.stateStore).toBeDefined()
    await runtime.stop?.()
  })

  it("keeps dependency-injected daemon runners ahead of provider factory selection", async () => {
    // Given: config selects Claude Code and an explicit runner is injected.
    const { createProductionDaemonWorkflowRuntime } = await import(
      "../../src/cli/daemon-runtime.js"
    )
    const injectedRunner: RunnerAdapter<RunnerRequest> = {
      run: async (request) => ({ ...runnerResult, mode: request.mode }),
    }

    // When: the daemon runtime is composed with an injected runner.
    const runtime = createProductionDaemonWorkflowRuntime(settingsForProvider("claude-code"), {
      mrProviderFactory: () => ({
        createMergeRequest: async () => ({ url: "https://gitlab.example/mr/1" }),
        provider: "gitlab",
      }),
      runner: injectedRunner,
    })

    // Then: runtime composition succeeds without asking the provider factory for Claude Code.
    expect(runtime.stateStore).toBeDefined()
    await runtime.stop?.()
  })

  it("wraps the selected runner command in the configured project environment", async () => {
    // Given: production config declares a project environment wrapper.
    const processRunner = new LastMessageProcess(JSON.stringify({ analysis: "project env" }))
    const { createProductionRunner } = await import("../../src/runner/factory.js")
    const runner = createProductionRunner(settingsForProjectEnv("codex"), {
      cleanChecker: new CleanChecker(),
      env: {
        HOME: "/Users/test",
        PATH: "/usr/bin",
      },
      processRunner,
    })

    // When: the factory-created runner handles an analysis request.
    await runner.run({
      allowedCommands: ["pnpm test"],
      incidentContext: {
        issueId: "SENTRY-PROJECT-ENV",
        trustBoundary: "untrusted_external_sentry",
      },
      mode: "analysis_only",
      repositoryConstraints: "analysis only",
      workspacePath: "/tmp/incident-workspace",
    })

    // Then: project environment command owns the process and receives the runner command as argv.
    const invocation = processRunner.invocations[0]
    expect(invocation?.command).toBe("/Users/won/.local/bin/mise")
    expect(invocation?.args.slice(0, 4)).toEqual(["exec", "--", "codex", "exec"])
    expect(invocation?.args).toContain("--cd")
    expect(invocation?.args).toContain("/tmp/incident-workspace")
    expect(invocation?.cwd).toBe("/tmp/incident-workspace")
    expect(invocation?.env).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin",
    })
  })
})
