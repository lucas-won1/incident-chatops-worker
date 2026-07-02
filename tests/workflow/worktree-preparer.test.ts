import { describe, expect, it } from "vitest"

import type {
  RunnerProcess,
  RunnerProcessInvocation,
  RunnerProcessResult,
} from "../../src/runner/types.js"
import type { WorkflowWorktreeSession } from "../../src/workflow/index.js"
import {
  CommandWorktreePreparer,
  WorktreePreparationError,
} from "../../src/workflow/worktree-preparer.js"

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

const session: WorkflowWorktreeSession = {
  branchName: "incident/SENTRY-10",
  close: async () => {},
  repoPath: "/repo",
  worktreePath: "/repo/.worktrees/job-1",
}

describe("command worktree preparer", () => {
  it("runs project bootstrap commands through the configured project environment", async () => {
    // Given: a worktree preparer with a project environment wrapper.
    const processRunner = new RecordingProcess()
    const preparer = new CommandWorktreePreparer({
      commands: [{ args: ["install", "--frozen-lockfile"], command: "pnpm" }],
      env: {
        GITLAB_TOKEN: "glpat-not-forwarded",
        HOME: "/Users/test",
        PATH: "/usr/bin",
      },
      processRunner,
      projectEnv: { args: ["exec", "--"], command: "/Users/test/.local/bin/mise" },
      timeoutMs: 900_000,
    })

    // When: the worktree is prepared.
    await preparer.prepare({ session })

    // Then: the command runs in the worktree with only safe environment variables.
    expect(processRunner.invocations).toEqual([
      {
        args: ["exec", "--", "pnpm", "install", "--frozen-lockfile"],
        command: "/Users/test/.local/bin/mise",
        cwd: "/repo/.worktrees/job-1",
        env: {
          HOME: "/Users/test",
          PATH: "/usr/bin",
        },
        outputLimitBytes: 204_800,
        secretRedactionValues: [],
        timeoutMs: 900_000,
      },
    ])
  })

  it("fails closed when a worktree preparation command fails", async () => {
    // Given: the project bootstrap command exits non-zero.
    const processRunner = new RecordingProcess({
      exitCode: 1,
      stderr: "missing pnpm store tarball",
      stdout: "",
    })
    const preparer = new CommandWorktreePreparer({
      commands: [{ args: ["install", "--offline"], command: "pnpm" }],
      env: { HOME: "/Users/test", PATH: "/usr/bin" },
      processRunner,
      timeoutMs: 600_000,
    })

    // When / Then: workflow sees a typed preparation failure before runner execution.
    await expect(preparer.prepare({ session })).rejects.toThrow(WorktreePreparationError)
  })
})
