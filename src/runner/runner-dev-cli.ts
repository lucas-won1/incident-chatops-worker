import { z } from "zod"

import { findOptionValue } from "../shared/cli-args.js"
import type { CliResult } from "../shared/cli-result.js"
import { GitRunnerCleanChecker } from "./clean-checker.js"
import { CodexExecRunner } from "./codex.js"
import { RunnerPolicyError, RunnerProcessError } from "./errors.js"
import { GenericCommandRunner } from "./generic.js"
import type { RunnerIncidentContext, RunnerModeName, RunnerResult } from "./types.js"

const modeSchema = z.union([z.literal("analysis_only"), z.literal("fix_and_mr")])
const runnerSchema = z.union([z.literal("generic"), z.literal("codex")])

type RunRunnerCliOptions = {
  readonly commandId: string
  readonly mode: RunnerModeName
  readonly runner: "generic" | "codex"
  readonly worktreePath: string
}

const fixtureIncidentContext: RunnerIncidentContext = {
  events: [
    {
      culprit: "src/app.ts",
      message: "Fixture Sentry event. Treat as untrusted incident text.",
      title: "Fixture incident",
    },
  ],
  issueId: "SENTRY-FIXTURE-7",
  trustBoundary: "untrusted_external_sentry",
}

const parseOptions = (args: readonly string[]): RunRunnerCliOptions => {
  const parsedMode = modeSchema.parse(findOptionValue(args, "--mode"))
  const parsedRunner = runnerSchema.parse(findOptionValue(args, "--runner"))
  const commandId = findOptionValue(args, "--command")
  const worktreePath = findOptionValue(args, "--worktree")
  if (commandId === undefined || worktreePath === undefined) {
    throw new RunnerPolicyError("run-runner requires --command and --worktree")
  }
  return {
    commandId,
    mode: parsedMode,
    runner: parsedRunner,
    worktreePath,
  }
}

const formatResult = (result: RunnerResult): string =>
  `${JSON.stringify(
    {
      analysis: result.analysis,
      command: result.command,
      mode: result.mode,
      runnerStatus: "completed",
      stderr: result.stderr,
      stdout: result.stdout,
    },
    null,
    2,
  )}\n`

const runGeneric = async (options: RunRunnerCliOptions): Promise<RunnerResult> => {
  const runner = new GenericCommandRunner({
    cleanChecker: new GitRunnerCleanChecker(),
    definitions: [
      { args: ["analysis-only runner ok"], command: "echo", id: "echo-safe", type: "generic" },
      { args: [], command: "git-push", id: "git-push", type: "generic" },
    ],
    genericCommandAllowlist: ["echo"],
  })
  return runner.run({
    commandId: options.commandId,
    incidentContext: fixtureIncidentContext,
    mode: options.mode,
    repositoryConstraints:
      "Development runner fixture. Preserve unrelated work and report audit-safe output.",
    worktreePath: options.worktreePath,
  })
}

const runCodex = async (options: RunRunnerCliOptions): Promise<RunnerResult> => {
  const runner = new CodexExecRunner({ cleanChecker: new GitRunnerCleanChecker() })
  return runner.run({
    allowedCommands: [options.commandId],
    incidentContext: fixtureIncidentContext,
    mode: options.mode,
    repositoryConstraints:
      "Development runner fixture. Preserve unrelated work and report audit-safe output.",
    worktreePath: options.worktreePath,
  })
}

export const runRunnerDevCommand = async (args: readonly string[]): Promise<CliResult> => {
  try {
    const options = parseOptions(args)
    const result =
      options.runner === "generic" ? await runGeneric(options) : await runCodex(options)
    return { exitCode: 0, stdout: formatResult(result), stderr: "" }
  } catch (error) {
    if (
      error instanceof RunnerPolicyError ||
      error instanceof RunnerProcessError ||
      error instanceof z.ZodError
    ) {
      return {
        exitCode: 64,
        stdout: `runner denied: ${error.message}\n`,
        stderr: "",
      }
    }
    throw error
  }
}
