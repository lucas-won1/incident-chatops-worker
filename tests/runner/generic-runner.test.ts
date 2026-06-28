import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  GenericCommandRunner,
  type GenericRunnerRequest,
  type RunnerCleanChecker,
  RunnerPolicyError,
  type RunnerProcess,
  type RunnerProcessInvocation,
  type RunnerProcessResult,
  RunnerTimeoutError,
  SafeProcessRunner,
} from "../../src/runner/index.js"

const incidentContext = {
  issueId: "SENTRY-123",
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

class FixedCleanChecker implements RunnerCleanChecker {
  public constructor(private readonly clean: boolean) {}

  public async isClean(): Promise<boolean> {
    return this.clean
  }
}

const genericRequest = (
  commandId: string,
  mode: GenericRunnerRequest["mode"] = "analysis_only",
): GenericRunnerRequest => ({
  commandId,
  incidentContext,
  mode,
  repositoryConstraints: "analysis only",
  worktreePath: "/tmp/worktree",
})

describe("generic command runner", () => {
  it("rejects analysis-only commit, push, and MR commands even when the executable is allowlisted", async () => {
    // Given: a generic runner definition that would mutate repository state.
    const runner = new GenericCommandRunner({
      cleanChecker: new FixedCleanChecker(true),
      definitions: [
        { args: ["push", "origin", "main"], command: "git", id: "git-push", type: "generic" },
      ],
      genericCommandAllowlist: ["git"],
      processRunner: new RecordingProcess(),
    })

    // When / Then: analysis-only mode denies mutation before process spawn.
    await expect(runner.run(genericRequest("git-push"))).rejects.toThrow(RunnerPolicyError)
  })

  it("rejects command definitions outside the configured allowlist", async () => {
    // Given: a command definition whose executable is not allowlisted.
    const runner = new GenericCommandRunner({
      cleanChecker: new FixedCleanChecker(true),
      definitions: [{ args: ["ok"], command: "node", id: "node-task", type: "generic" }],
      genericCommandAllowlist: ["echo"],
      processRunner: new RecordingProcess(),
    })

    // When / Then: command allowlist enforcement denies it.
    await expect(runner.run(genericRequest("node-task"))).rejects.toThrow(/allowlist/u)
  })

  it.each([
    "--add-dir=/tmp",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-approvals-and-sandbox=true",
    "--dangerously-bypass-hook-trust",
    "--dangerously-bypass-hook-trust=true",
  ] as const)("rejects dangerous Codex argument %s before spawning", async (argument) => {
    // Given: a command definition attempts to smuggle a forbidden Codex flag.
    const processRunner = new RecordingProcess()
    const runner = new GenericCommandRunner({
      cleanChecker: new FixedCleanChecker(true),
      definitions: [{ args: [argument], command: "echo", id: "echo-dangerous", type: "generic" }],
      genericCommandAllowlist: ["echo"],
      processRunner,
    })

    // When / Then: argv validation denies the argument and no process is spawned.
    await expect(runner.run(genericRequest("echo-dangerous"))).rejects.toThrow(RunnerPolicyError)
    expect(processRunner.invocations).toEqual([])
  })

  it("fails analysis-only runs when the worktree is dirty after process exit", async () => {
    // Given: an analysis command succeeds but the post-run clean check reports dirty state.
    const runner = new GenericCommandRunner({
      cleanChecker: new FixedCleanChecker(false),
      definitions: [{ args: ["safe"], command: "echo", id: "echo-safe", type: "generic" }],
      genericCommandAllowlist: ["echo"],
      processRunner: new RecordingProcess({ exitCode: 0, stderr: "", stdout: "analysis complete" }),
    })

    // When / Then: analysis-only fails closed on dirty worktree state.
    await expect(runner.run(genericRequest("echo-safe"))).rejects.toThrow(/dirty/u)
  })

  it("redacts and truncates process output before returning it", async () => {
    // Given: a generic command emits token-looking output over the configured cap.
    const runner = new GenericCommandRunner({
      cleanChecker: new FixedCleanChecker(true),
      definitions: [{ args: ["safe"], command: "echo", id: "echo-safe", type: "generic" }],
      genericCommandAllowlist: ["echo"],
      outputLimitBytes: 40,
      processRunner: new RecordingProcess({
        exitCode: 0,
        stderr: "",
        stdout: `analysis glpat-secret-value ${"x".repeat(80)}`,
      }),
    })

    // When: the command is run through the adapter.
    const result = await runner.run(genericRequest("echo-safe"))

    // Then: the observable output is safe for audit storage.
    expect(result.stdout).toContain("[REDACTED]")
    expect(result.stdout).not.toContain("glpat-secret-value")
    expect(result.stdout).toContain("[TRUNCATED]")
    expect(result.stdout.length).toBeLessThanOrEqual(40)
  })

  it("kills hung commands at timeout instead of waiting indefinitely", async () => {
    // Given: a real child process that never exits.
    const tempRoot = mkdtempSync(path.join(tmpdir(), "incident-runner-hang-"))
    const hangingScript = path.join(tempRoot, "hang.js")
    await writeFile(hangingScript, "setInterval(() => undefined, 1000)\n")
    chmodSync(hangingScript, 0o755)
    const runner = new SafeProcessRunner()

    try {
      // When / Then: safe spawning rejects with a typed timeout error.
      await expect(
        runner.run({
          args: [hangingScript],
          command: process.execPath,
          cwd: tempRoot,
          env: {},
          outputLimitBytes: 1024,
          timeoutMs: 25,
        }),
      ).rejects.toThrow(RunnerTimeoutError)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
