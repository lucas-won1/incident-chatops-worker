import { describe, expect, it } from "vitest"

import {
  CodexExecRunner,
  GenericCommandRunner,
  type RunnerCleanChecker,
  RunnerDirtyWorktreeError,
  RunnerPolicyError,
  type RunnerProcess,
  RunnerProcessError,
  type RunnerProcessInvocation,
  type RunnerProcessResult,
  SafeProcessRunner,
} from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const incidentContext = {
  issueId: "SENTRY-REGRESSION",
  trustBoundary: "untrusted_external_sentry",
} as const

class RecordingProcess implements RunnerProcess {
  public readonly invocations: RunnerProcessInvocation[] = []

  public constructor(
    private readonly result: RunnerProcessResult = { exitCode: 0, stderr: "", stdout: "" },
  ) {}

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    return this.result
  }
}

class RecordingCleanChecker implements RunnerCleanChecker {
  public readonly calls: string[] = []

  public constructor(private readonly clean: boolean) {}

  public async isClean(worktreePath: string): Promise<boolean> {
    this.calls.push(worktreePath)
    return this.clean
  }
}

const genericRequest = (commandId: string) => ({
  commandId,
  incidentContext,
  mode: "analysis_only" as const,
  repositoryConstraints: "analysis only",
  worktreePath: "/tmp/worktree",
})

describe("runner safety regressions", () => {
  it("redacts actual configured secret env values from returned Codex outputs", async () => {
    // Given: Codex redaction is configured with a custom secret value that is not token-shaped.
    const secretValue = ["plain", "custom", "configured", "secret"].join("-")
    const processRunner = new LastMessageProcess(
      JSON.stringify({ analysis: `analysis ${secretValue}` }),
      {
        exitCode: 0,
        stderr: `diagnostic ${secretValue}`,
        stdout: `transport ${secretValue}`,
      },
    )
    const runner = new CodexExecRunner({
      cleanChecker: new RecordingCleanChecker(true),
      env: {
        CODEX_BIN: "codex",
        CUSTOM_SECRET: secretValue,
        HOME: "/tmp",
        PATH: "/usr/bin",
      },
      processRunner,
      secretEnvNames: ["CUSTOM_SECRET"],
    })

    // When: the runner returns analysis-only output.
    const result = await runner.run({
      allowedCommands: ["pnpm test"],
      incidentContext,
      mode: "analysis_only",
      repositoryConstraints: "analysis only",
      worktreePath: "/tmp/worktree",
    })

    // Then: every returned text field is redacted by exact configured secret value.
    expect(result.stdout.includes(secretValue)).toBe(false)
    expect(result.stderr.includes(secretValue)).toBe(false)
    expect(result.analysis.includes(secretValue)).toBe(false)
    expect(result.stdout).toContain("[REDACTED]")
    expect(result.stderr).toContain("[REDACTED]")
  })

  it("redacts configured secret values before real process stdout truncation", async () => {
    // Given: a real child process writes a configured non-token secret longer than the cap.
    const secretValue = "configured-secret-truncation-value-stdout"
    const secretPrefix = secretValue.slice(0, 14)
    const runner = new GenericCommandRunner({
      cleanChecker: new RecordingCleanChecker(true),
      definitions: [
        {
          args: ["-e", "process.stdout.write(process.env.CUSTOM_SECRET + ' tail')"],
          command: process.execPath,
          id: "node-secret",
          type: "generic",
        },
      ],
      env: { CUSTOM_SECRET: secretValue, PATH: "/usr/bin" },
      envAllowlist: ["CUSTOM_SECRET", "PATH"],
      genericCommandAllowlist: [process.execPath],
      outputLimitBytes: 32,
      processRunner: new SafeProcessRunner(),
      secretEnvNames: ["CUSTOM_SECRET"],
    })

    // When: the generic runner returns capped process output.
    const result = await runner.run({
      ...genericRequest("node-secret"),
      worktreePath: process.cwd(),
    })

    // Then: no raw secret prefix survives the real SafeProcessRunner path.
    expect(result.stdout.includes(secretValue)).toBe(false)
    expect(result.stdout.includes(secretPrefix)).toBe(false)
    expect(result.analysis.includes(secretPrefix)).toBe(false)
    expect(result.stdout).toContain("[REDACTED]")
  })

  it("redacts configured secret values before real process stderr truncation errors", async () => {
    // Given: a real child process writes a configured secret to stderr before failing.
    const secretValue = "configured-secret-truncation-value-stderr"
    const secretPrefix = secretValue.slice(0, 14)
    const runner = new GenericCommandRunner({
      cleanChecker: new RecordingCleanChecker(true),
      definitions: [
        {
          args: ["-e", "process.stderr.write(process.env.CUSTOM_SECRET + ' tail'),process.exit(7)"],
          command: process.execPath,
          id: "node-secret-fail",
          type: "generic",
        },
      ],
      env: { CUSTOM_SECRET: secretValue, PATH: "/usr/bin" },
      envAllowlist: ["CUSTOM_SECRET", "PATH"],
      genericCommandAllowlist: [process.execPath],
      outputLimitBytes: 32,
      processRunner: new SafeProcessRunner(),
      secretEnvNames: ["CUSTOM_SECRET"],
    })

    // When / Then: the process error stderr is already safe despite output capping.
    try {
      await runner.run({
        ...genericRequest("node-secret-fail"),
        worktreePath: process.cwd(),
      })
      expect.unreachable("runner should surface the nonzero child exit")
    } catch (error) {
      if (!(error instanceof RunnerProcessError)) {
        throw error
      }
      expect(error.stderr.includes(secretValue)).toBe(false)
      expect(error.stderr.includes(secretPrefix)).toBe(false)
      expect(error.stderr).toContain("[REDACTED]")
    }
  })

  it.each([
    { args: ["-c", "git push"], command: "sh" },
    { args: ["-lc", "git commit -m msg"], command: "bash" },
    { args: ["-Command", "gh pr create"], command: "powershell" },
    { args: ["-EncodedCommand", "Z2l0IHB1c2g="], command: "pwsh" },
    { args: ["/c", "git push"], command: "cmd" },
  ] as const)(
    "rejects shell interpreter definition $command before spawn",
    async ({ args, command }) => {
      // Given: a configured command uses a shell interpreter to smuggle mutating intent.
      const processRunner = new RecordingProcess()
      const runner = new GenericCommandRunner({
        cleanChecker: new RecordingCleanChecker(true),
        definitions: [{ args, command, id: "shell-smuggle", type: "generic" }],
        genericCommandAllowlist: [command],
        processRunner,
      })

      // When / Then: command validation fails before a process starts.
      await expect(runner.run(genericRequest("shell-smuggle"))).rejects.toThrow(RunnerPolicyError)
      expect(processRunner.invocations).toEqual([])
    },
  )

  it.each([
    ["approval and sandbox bypass", "--dangerously-bypass-approvals-and-sandbox"],
    ["hook trust bypass", "--dangerously-bypass-hook-trust"],
    ["add directory override", "--add-dir=/tmp/untrusted"],
  ] as const)("rejects dangerous Codex %s flag before spawn", async (_label, flag) => {
    // Given: a configured runner command includes a Codex safety override flag.
    const processRunner = new RecordingProcess()
    const runner = new GenericCommandRunner({
      cleanChecker: new RecordingCleanChecker(true),
      definitions: [{ args: [flag], command: "codex", id: "codex-danger", type: "generic" }],
      genericCommandAllowlist: ["codex"],
      processRunner,
    })

    // When / Then: command validation fails before a process starts.
    await expect(runner.run(genericRequest("codex-danger"))).rejects.toThrow(RunnerPolicyError)
    expect(processRunner.invocations).toEqual([])
  })

  it.each([
    ["env sh -c", ["sh", "-c", "echo safe"]],
    ["/usr/bin/env bash -lc", ["bash", "-lc", "echo safe"]],
    ["env powershell -Command", ["powershell", "-Command", "Write-Output safe"]],
    ["env pwsh -EncodedCommand", ["pwsh", "-EncodedCommand", "VwByAGkAdABlAA=="]],
    ["env cmd /c", ["cmd", "/c", "echo safe"]],
  ] as const)(
    "rejects wrapper-mediated shell interpreter %s before spawn",
    async (_label, args) => {
      // Given: an allowlisted wrapper executable is configured with shell interpreter args.
      const processRunner = new RecordingProcess()
      const runner = new GenericCommandRunner({
        cleanChecker: new RecordingCleanChecker(true),
        definitions: [{ args, command: "env", id: "env-shell", type: "generic" }],
        genericCommandAllowlist: ["env"],
        processRunner,
      })

      // When / Then: wrapper-mediated shell use is denied before the process seam.
      await expect(runner.run(genericRequest("env-shell"))).rejects.toThrow(RunnerPolicyError)
      expect(processRunner.invocations).toHaveLength(0)
    },
  )

  it.each([
    ["env -S sh -c", "env", ["-S", "sh -c 'git push'"]],
    ["/usr/bin/env -S bash -lc", "/usr/bin/env", ["-S", "bash -lc 'git commit'"]],
    [
      "env --split-string pwsh -Command",
      "env",
      ["--split-string", "pwsh -Command New-MergeRequest"],
    ],
  ] as const)(
    "rejects split-string shell wrapper %s before spawn",
    async (_label, command, args) => {
      // Given: env is configured to split a single argument into shell interpreter argv.
      const processRunner = new RecordingProcess()
      const runner = new GenericCommandRunner({
        cleanChecker: new RecordingCleanChecker(true),
        definitions: [{ args, command, id: "env-s-shell", type: "generic" }],
        genericCommandAllowlist: [command],
        processRunner,
      })

      // When / Then: split-string shell use is denied before the process seam.
      await expect(runner.run(genericRequest("env-s-shell"))).rejects.toThrow(RunnerPolicyError)
      expect(processRunner.invocations).toHaveLength(0)
    },
  )

  it("checks analysis-only clean state after nonzero process exit and reports dirty worktree", async () => {
    // Given: an analysis command fails after leaving the worktree dirty.
    const cleanChecker = new RecordingCleanChecker(false)
    const runner = new GenericCommandRunner({
      cleanChecker,
      definitions: [{ args: ["safe"], command: "echo", id: "echo-safe", type: "generic" }],
      genericCommandAllowlist: ["echo"],
      processRunner: new RecordingProcess({
        exitCode: 7,
        stderr: "analysis failed",
        stdout: "",
      }),
    })

    // When / Then: the post-run clean check still runs and dirty worktree is surfaced.
    try {
      await runner.run(genericRequest("echo-safe"))
      expect.unreachable("runner should reject dirty analysis-only worktree")
    } catch (error) {
      if (!(error instanceof RunnerDirtyWorktreeError)) {
        throw error
      }
      expect(error).toMatchObject({
        failedProcess: { command: "echo", exitCode: 7 },
        worktreePath: "/tmp/worktree",
      })
    }
    expect(cleanChecker.calls).toEqual(["/tmp/worktree"])
  })
})
