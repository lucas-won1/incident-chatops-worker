import { describe, expect, it } from "vitest"

import {
  CodexExecRunner,
  GenericCommandRunner,
  type RunnerCleanChecker,
  type RunnerProcess,
  type RunnerProcessInvocation,
  type RunnerProcessResult,
} from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const mainServiceEnv = {
  CODEX_BIN: "/ambient/codex",
  CODEX_HOME: "/ambient/codex-home",
  CODEX_THREAD_ID: "019f-live-app-thread",
  GITLAB_TOKEN: "main-service-gitlab-secret",
  HOME: "/tmp",
  PATH: "/usr/bin",
  SENTRY_AUTH_TOKEN: "main-service-sentry-secret",
  SLACK_APP_TOKEN: "main-service-slack-app-secret",
  SLACK_BOT_TOKEN: "main-service-slack-bot-secret",
} as const

const mainServiceSecretNames = [
  "GITLAB_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
] as const

const envFileSecretValues = [
  "envfile_gitlab_exact_secret",
  "envfile_sentry_exact_secret",
  "envfile_slack_app_exact_secret",
  "envfile_slack_bot_exact_secret",
] as const

const request = {
  incidentContext: {
    issueId: "SENTRY-SECRET-ENV",
    trustBoundary: "untrusted_external_sentry",
  },
  mode: "analysis_only",
  repositoryConstraints: "analysis only",
  workspacePath: "/tmp/workspace",
} as const

class CleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return true
  }
}

class RecordingProcess implements RunnerProcess {
  public readonly invocations: RunnerProcessInvocation[] = []

  public constructor(private readonly result: RunnerProcessResult) {}

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    return this.result
  }
}

describe("runner secret env separation", () => {
  it("keeps main service tokens out of Codex child env while still redacting their values", async () => {
    // Given: production secret names are configured for redaction and Codex output leaks their values.
    const processRunner = new LastMessageProcess(
      JSON.stringify({ analysis: `analysis ${mainServiceEnv.GITLAB_TOKEN}` }),
      {
        exitCode: 0,
        stderr: `stderr ${mainServiceEnv.SLACK_BOT_TOKEN}`,
        stdout: `stdout ${mainServiceEnv.SENTRY_AUTH_TOKEN}`,
      },
    )
    const runner = new CodexExecRunner({
      cleanChecker: new CleanChecker(),
      env: mainServiceEnv,
      processRunner,
      secretEnvNames: mainServiceSecretNames,
    })

    // When: the Codex runner executes with default env pass-through.
    const result = await runner.run(request)

    // Then: child env excludes service tokens and all returned output is redacted.
    expect(processRunner.invocations[0]?.env).toEqual({
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
    expect(JSON.stringify(result)).toContain("[REDACTED]")
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.GITLAB_TOKEN)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.SENTRY_AUTH_TOKEN)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.SLACK_BOT_TOKEN)
  })

  it("uses configured Codex home without passing service tokens or ambient CODEX_HOME", async () => {
    // Given: Codex has a worker-owned home and the ambient env contains service tokens.
    const processRunner = new LastMessageProcess(
      JSON.stringify({ analysis: `analysis ${mainServiceEnv.GITLAB_TOKEN}` }),
      {
        exitCode: 0,
        stderr: `stderr ${mainServiceEnv.SLACK_BOT_TOKEN}`,
        stdout: `stdout ${mainServiceEnv.SENTRY_AUTH_TOKEN}`,
      },
    )
    const runner = new CodexExecRunner({
      cleanChecker: new CleanChecker(),
      env: mainServiceEnv,
      home: "/var/lib/incident-worker/codex",
      processRunner,
      secretEnvNames: mainServiceSecretNames,
    })

    // When: the Codex runner executes with configured instance isolation.
    const result = await runner.run(request)

    // Then: CODEX_HOME is overridden and service token values remain redacted.
    expect(processRunner.invocations[0]?.env).toEqual({
      CODEX_HOME: "/var/lib/incident-worker/codex",
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
    expect(JSON.stringify(result)).toContain("[REDACTED]")
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.CODEX_HOME)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.GITLAB_TOKEN)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.SENTRY_AUTH_TOKEN)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.SLACK_BOT_TOKEN)
  })

  it("ignores ambient Codex process variables unless they are explicitly configured", async () => {
    // Given: the daemon inherited a live Codex app environment from the terminal.
    const processRunner = new LastMessageProcess(JSON.stringify({ analysis: "analysis" }))
    const runner = new CodexExecRunner({
      cleanChecker: new CleanChecker(),
      env: {
        CODEX_BIN: "/ambient/codex",
        CODEX_HOME: "/ambient/codex-home",
        CODEX_SESSION_ID: "ambient-session",
        CODEX_THREAD_ID: "019f-live-app-thread",
        HOME: "/tmp",
        PATH: "/usr/bin",
      },
      processRunner,
    })

    // When: the Codex runner starts its isolated CLI process.
    await runner.run(request)

    // Then: ambient Codex env does not choose the binary or leak into the child env.
    expect(processRunner.invocations[0]?.command).toBe("codex")
    expect(processRunner.invocations[0]?.env).toEqual({
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
  })

  it("keeps main service tokens out of generic child env while still redacting their values", async () => {
    // Given: a generic command emits main service token values without receiving those env names.
    const processRunner = new RecordingProcess({
      exitCode: 0,
      stderr: `stderr ${mainServiceEnv.SLACK_APP_TOKEN}`,
      stdout: `stdout ${mainServiceEnv.GITLAB_TOKEN}`,
    })
    const runner = new GenericCommandRunner({
      cleanChecker: new CleanChecker(),
      definitions: [{ args: ["ok"], command: "echo", id: "echo-safe", type: "generic" }],
      env: mainServiceEnv,
      genericCommandAllowlist: ["echo"],
      processRunner,
      secretEnvNames: mainServiceSecretNames,
    })

    // When: the generic runner executes with default env pass-through.
    const result = await runner.run({ ...request, commandId: "echo-safe" })

    // Then: child env excludes service tokens and returned output is still redacted.
    expect(processRunner.invocations[0]?.env).toEqual({
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
    expect(JSON.stringify(result)).toContain("[REDACTED]")
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.GITLAB_TOKEN)
    expect(JSON.stringify(result)).not.toContain(mainServiceEnv.SLACK_APP_TOKEN)
  })

  it("redacts explicit Codex secret values that are absent from the child env source", async () => {
    // Given: Codex leaks env-file-only values that are not present in the runner env source.
    const processRunner = new LastMessageProcess(
      JSON.stringify({ analysis: `analysis ${envFileSecretValues[0]}` }),
      {
        exitCode: 0,
        stderr: `stderr ${envFileSecretValues[3]}`,
        stdout: `stdout ${envFileSecretValues[1]}`,
      },
    )
    const runner = new CodexExecRunner({
      cleanChecker: new CleanChecker(),
      env: { CODEX_BIN: "codex", HOME: "/tmp", PATH: "/usr/bin" },
      processRunner,
      secretEnvNames: mainServiceSecretNames,
      secretValues: envFileSecretValues,
    })

    // When: the Codex runner executes without receiving those service token env names.
    const result = await runner.run(request)

    // Then: child env excludes service tokens while stdout, stderr, and parsed fields are redacted.
    expect(processRunner.invocations[0]?.env).toEqual({
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
    expect(JSON.stringify(result)).toContain("[REDACTED]")
    for (const secret of envFileSecretValues) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it("redacts explicit generic runner secret values that are absent from the child env source", async () => {
    // Given: a generic command leaks env-file-only values from stdout and stderr.
    const processRunner = new RecordingProcess({
      exitCode: 0,
      stderr: `stderr ${envFileSecretValues[2]}`,
      stdout: `stdout ${envFileSecretValues[0]}`,
    })
    const runner = new GenericCommandRunner({
      cleanChecker: new CleanChecker(),
      definitions: [{ args: ["ok"], command: "echo", id: "echo-safe", type: "generic" }],
      env: { CODEX_HOME: "/tmp/codex-home", HOME: "/tmp", PATH: "/usr/bin" },
      genericCommandAllowlist: ["echo"],
      processRunner,
      secretEnvNames: mainServiceSecretNames,
      secretValues: envFileSecretValues,
    })

    // When: the generic runner executes without receiving service token env names.
    const result = await runner.run({ ...request, commandId: "echo-safe" })

    // Then: child env excludes service tokens while stdout, stderr, and analysis are redacted.
    expect(processRunner.invocations[0]?.env).toEqual({
      HOME: "/tmp",
      PATH: "/usr/bin",
    })
    expect(JSON.stringify(result)).toContain("[REDACTED]")
    for (const secret of envFileSecretValues) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })
})
