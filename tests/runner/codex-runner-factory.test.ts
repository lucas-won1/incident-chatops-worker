import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  parseWorkerConfigYaml,
  parseWorkerEnv,
  type WorkerSettings,
} from "../../src/config/index.js"
import type { RunnerCleanChecker } from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

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

const settingsForCodexInstance = (outputRoot: string): WorkerSettings => ({
  config: parseWorkerConfigYaml(
    baseYaml.replace(
      "runners:\n",
      `runners:
  provider: codex
  codex:
    bin: /opt/worker-codex/bin/codex
    home: /var/lib/incident-worker/codex
    profile: incident-worker
    model: gpt-5-codex
    outputRoot: ${outputRoot}
    workspaceWriteNetworkAccess: true
    extraEnvAllowlist:
      - CI
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

describe("Codex production runner factory", () => {
  it("maps Codex config into the production runner invocation", async () => {
    // Given: config defines a worker-owned Codex instance and the process seam records argv/env.
    const outputRoot = mkdtempSync(join(tmpdir(), "runner-factory-codex-"))
    const processRunner = new LastMessageProcess(JSON.stringify({ analysis: "factory analysis" }))
    const { createProductionRunner } = await import("../../src/runner/factory.js")
    vi.stubEnv("CODEX_BIN", "/bin/false")

    try {
      const runner = createProductionRunner(settingsForCodexInstance(outputRoot), {
        cleanChecker: new CleanChecker(),
        env: {
          CI: "1",
          CODEX_HOME: "/ambient/codex-home",
          CODEX_THREAD_ID: "019f-live-app-thread",
          HOME: "/Users/test",
          PATH: "/usr/bin",
        },
        processRunner,
      })

      // When: the factory-created runner handles an analysis request.
      await runner.run({
        allowedCommands: ["pnpm test"],
        incidentContext: {
          issueId: "SENTRY-FACTORY",
          trustBoundary: "untrusted_external_sentry",
        },
        mode: "analysis_only",
        repositoryConstraints: "analysis only",
        workspacePath: "/tmp/incident-workspace",
      })

      // Then: configured Codex executable, flags, home, output root, and allowlisted env are used.
      const invocation = processRunner.invocations[0]
      const outputPathPattern = new RegExp(
        `^${outputRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/analysis_only-.+/analysis-output\\.json$`,
        "u",
      )
      expect([invocation?.command, ...(invocation?.args ?? [])]).toEqual([
        "/opt/worker-codex/bin/codex",
        "exec",
        "--profile",
        "incident-worker",
        "--model",
        "gpt-5-codex",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--json",
        "--cd",
        "/tmp/incident-workspace",
        "--sandbox",
        "read-only",
        "--output-last-message",
        expect.stringMatching(outputPathPattern),
        "-",
      ])
      expect(invocation?.env).toEqual({
        CI: "1",
        CODEX_HOME: "/var/lib/incident-worker/codex",
        HOME: "/Users/test",
        PATH: "/usr/bin",
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it("selects Codex exec runner without a runner mode selector", async () => {
    // Given: config selects the Codex provider.
    const outputRoot = mkdtempSync(join(tmpdir(), "runner-factory-codex-"))
    const { createProductionRunner } = await import("../../src/runner/factory.js")

    try {
      // When: the production daemon composes a runner.
      const runner = createProductionRunner(settingsForCodexInstance(outputRoot))

      // Then: Codex provider uses the CLI exec adapter directly.
      expect(runner.constructor.name).toBe("CodexExecRunner")
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
