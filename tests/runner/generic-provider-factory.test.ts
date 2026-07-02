import { describe, expect, it } from "vitest"

import {
  parseWorkerConfigYaml,
  parseWorkerEnv,
  type WorkerSettings,
} from "../../src/config/index.js"
import { createProductionRunner } from "../../src/runner/factory.js"
import type {
  RunnerCleanChecker,
  RunnerProcess,
  RunnerProcessInvocation,
  RunnerProcessResult,
} from "../../src/runner/index.js"

const envForStatePath = (stateDbPath: string) =>
  parseWorkerEnv({
    GITLAB_TOKEN: "glpat-redacted-example",
    HOME: "/Users/won",
    SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
    SLACK_APP_TOKEN: "xapp-redacted-example",
    SLACK_BOT_TOKEN: "xoxb-redacted-example",
    STATE_DB_PATH: stateDbPath,
  })

const genericProviderYaml = `sentry:
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
  provider: generic
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

const genericSettings = (): WorkerSettings => {
  const env = envForStatePath("/tmp/incident-chatops-worker/generic-provider-state.sqlite")
  return {
    config: parseWorkerConfigYaml(genericProviderYaml, env),
    env,
  }
}

class CleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return true
  }
}

class RecordingProcess implements RunnerProcess {
  public readonly invocations: RunnerProcessInvocation[] = []

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    return { exitCode: 0, stderr: "", stdout: "generic complete" }
  }
}

const runnerRequest = (mode: "analysis_only" | "fix_and_mr") => ({
  allowedCommands: ["not-the-executable"],
  incidentContext: {
    issueId: "SENTRY-GENERIC",
    trustBoundary: "untrusted_external_sentry",
  } as const,
  mode,
  repositoryConstraints: "Use only the configured workspace.",
  workspacePath: "/tmp/incident-workspace",
})

describe("generic provider production factory", () => {
  it("uses configured mode command ids instead of request allowedCommands", async () => {
    // Given: production config selects different generic commands per mode.
    const processRunner = new RecordingProcess()
    const runner = createProductionRunner(genericSettings(), {
      cleanChecker: new CleanChecker(),
      env: { HOME: "/Users/test", PATH: "/usr/bin" },
      processRunner,
    })

    // When: both runner modes execute with unrelated request allowedCommands policy.
    const analysis = await runner.run(runnerRequest("analysis_only"))
    const fix = await runner.run(runnerRequest("fix_and_mr"))

    // Then: executable selection comes from mode config, not the request prompt policy.
    expect(analysis.command).toBe("echo-analysis")
    expect(fix.command).toBe("echo-fix")
    expect(processRunner.invocations.map((invocation) => invocation.args)).toEqual([
      ["analysis"],
      ["fix"],
    ])
  })
})
