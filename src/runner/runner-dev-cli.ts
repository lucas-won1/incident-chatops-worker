import { z } from "zod"
import { loadCommandSettings } from "../cli/settings.js"
import type { WorkerSettings } from "../config/index.js"
import { assertNever } from "../shared/assert-never.js"
import { findOptionValue } from "../shared/cli-args.js"
import type { CliResult } from "../shared/cli-result.js"
import { ClaudeCodeRunner } from "./claude-code.js"
import { GitRunnerCleanChecker } from "./clean-checker.js"
import { CodexExecRunner } from "./codex.js"
import { RunnerPolicyError, RunnerProcessError } from "./errors.js"
import { createProductionRunner } from "./factory.js"
import { GenericCommandRunner } from "./generic.js"
import type {
  RunnerCleanChecker,
  RunnerIncidentContext,
  RunnerModeName,
  RunnerProcess,
  RunnerRequest,
  RunnerResult,
} from "./types.js"

const modeSchema = z.union([z.literal("analysis_only"), z.literal("fix_and_mr")])
const runnerSchema = z.union([z.literal("generic"), z.literal("codex"), z.literal("claude-code")])

type RunRunnerCliOptions = {
  readonly commandId: string
  readonly mode: RunnerModeName
  readonly runner: "generic" | "codex" | "claude-code"
  readonly workspacePath: string
}

export type RunRunnerDevRuntimeOptions = {
  readonly cleanChecker?: RunnerCleanChecker
  readonly processRunner?: RunnerProcess
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
  const workspacePath = findOptionValue(args, "--workspace") ?? findOptionValue(args, "--worktree")
  if (commandId === undefined || workspacePath === undefined) {
    throw new RunnerPolicyError("run-runner requires --command and --workspace")
  }
  return {
    commandId,
    mode: parsedMode,
    runner: parsedRunner,
    workspacePath,
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
    workspacePath: options.workspacePath,
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
    workspacePath: options.workspacePath,
  })
}

const runClaudeCode = async (options: RunRunnerCliOptions): Promise<RunnerResult> => {
  const runner = new ClaudeCodeRunner({ cleanChecker: new GitRunnerCleanChecker() })
  return runner.run({
    allowedCommands: [options.commandId],
    incidentContext: fixtureIncidentContext,
    mode: options.mode,
    repositoryConstraints:
      "Development runner fixture. Preserve unrelated work and report audit-safe output.",
    workspacePath: options.workspacePath,
  })
}

const runFixtureRunner = async (options: RunRunnerCliOptions): Promise<RunnerResult> => {
  switch (options.runner) {
    case "generic":
      return await runGeneric(options)
    case "codex":
      return await runCodex(options)
    case "claude-code":
      return await runClaudeCode(options)
    default:
      return assertNever(options.runner)
  }
}

const productionRunnerFactoryOptions = (runtime: RunRunnerDevRuntimeOptions) => ({
  ...(runtime.cleanChecker === undefined ? {} : { cleanChecker: runtime.cleanChecker }),
  ...(runtime.processRunner === undefined ? {} : { processRunner: runtime.processRunner }),
})

const configuredRunnerRequest = (options: RunRunnerCliOptions): RunnerRequest => ({
  allowedCommands: [options.commandId],
  incidentContext: fixtureIncidentContext,
  mode: options.mode,
  repositoryConstraints:
    "Development runner fixture. Preserve unrelated work and report audit-safe output.",
  workspacePath: options.workspacePath,
})

const runConfiguredRunner = async (
  settings: WorkerSettings,
  options: RunRunnerCliOptions,
  runtime: RunRunnerDevRuntimeOptions,
): Promise<RunnerResult> => {
  if (settings.config.runners.provider !== options.runner) {
    throw new RunnerPolicyError(
      `run-runner --runner ${options.runner} does not match configured provider ${settings.config.runners.provider}`,
    )
  }
  const runner = createProductionRunner(settings, productionRunnerFactoryOptions(runtime))
  return await runner.run(configuredRunnerRequest(options))
}

export const runRunnerDevCommand = async (
  args: readonly string[],
  runtime: RunRunnerDevRuntimeOptions = {},
): Promise<CliResult> => {
  try {
    const options = parseOptions(args)
    const settings =
      findOptionValue(args, "--config") === undefined
        ? undefined
        : loadCommandSettings(args).settings
    const result =
      settings === undefined
        ? await runFixtureRunner(options)
        : await runConfiguredRunner(settings, options, runtime)
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
