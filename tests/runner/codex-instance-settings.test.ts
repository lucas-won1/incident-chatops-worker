import { describe, expect, it } from "vitest"

import {
  CodexExecRunner,
  type RunnerCleanChecker,
  type RunnerProcessInvocation,
} from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const incidentContext = {
  issueId: "SENTRY-INSTANCE",
  trustBoundary: "untrusted_external_sentry",
} as const

class FixedCleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return true
  }
}

const runCodexWithInstanceSettings = async (): Promise<RunnerProcessInvocation | undefined> => {
  const processRunner = new LastMessageProcess(JSON.stringify({ analysis: "analysis" }))
  const runner = new CodexExecRunner({
    bin: "/opt/worker-codex/bin/codex",
    cleanChecker: new FixedCleanChecker(),
    env: {
      CODEX_BIN: "/ambient/codex",
      CODEX_HOME: "/ambient/codex-home",
      CODEX_THREAD_ID: "019f-live-app-thread",
      HOME: "/Users/test",
      PATH: "/usr/bin",
    },
    home: "/var/lib/incident-worker/codex",
    model: "gpt-5-codex",
    outputRoot: "/tmp/incident-runner-output",
    processRunner,
    profile: "incident-worker",
  })

  await runner.run({
    incidentContext,
    mode: "analysis_only",
    repositoryConstraints: "Use only the configured workspace.",
    workspacePath: "/tmp/incident-workspace",
  })

  return processRunner.invocations[0]
}

describe("Codex instance settings", () => {
  it("passes home as CODEX_HOME and profile/model as exec flags", async () => {
    // Given: a Codex runner has explicit executable, home, profile, and model settings.
    const workspacePath = "/tmp/incident-workspace"

    // When: analysis-only execution is requested.
    const invocation = await runCodexWithInstanceSettings()

    // Then: instance settings are separate env and argv fields, not derived paths.
    expect([invocation?.command, ...(invocation?.args ?? [])]).toEqual([
      "/opt/worker-codex/bin/codex",
      "exec",
      "--profile",
      "incident-worker",
      "--model",
      "gpt-5-codex",
      "--json",
      "--cd",
      workspacePath,
      "--sandbox",
      "read-only",
      "--output-last-message",
      expect.stringMatching(
        /^\/tmp\/incident-runner-output\/analysis_only-.+\/analysis-output\.json$/u,
      ),
      "-",
    ])
    expect(invocation?.env).toEqual({
      CODEX_HOME: "/var/lib/incident-worker/codex",
      HOME: "/Users/test",
      PATH: "/usr/bin",
    })
    expect(invocation?.args).not.toContain("/var/lib/incident-worker/codex/incident-worker")
    expect(invocation?.args).not.toContain("/var/lib/incident-worker/codex/gpt-5-codex")
    expect(invocation?.args).not.toContain("/var/lib/incident-worker/codex/bin")
  })
})
