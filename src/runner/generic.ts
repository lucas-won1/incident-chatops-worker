import { RunnerDirtyWorktreeError, RunnerPolicyError, RunnerProcessError } from "./errors.js"
import { SafeProcessRunner } from "./process.js"
import {
  defaultEnvAllowlist,
  defaultOutputLimitBytes,
  defaultRunnerTimeoutMs,
  ensureAnalysisCommandSafe,
  ensureCommandAllowed,
  redactRunnerOutput,
  rejectShellInterpreterCommand,
  selectAllowedEnv,
  validateArgs,
  validateExecutable,
} from "./safety.js"
import type {
  GenericRunnerRequest,
  RunnerAdapter,
  RunnerCleanChecker,
  RunnerCommandDefinition,
  RunnerProcess,
  RunnerResult,
} from "./types.js"

export type GenericCommandRunnerOptions = {
  readonly cleanChecker: RunnerCleanChecker
  readonly definitions: readonly RunnerCommandDefinition[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly envAllowlist?: readonly string[]
  readonly genericCommandAllowlist: readonly string[]
  readonly outputLimitBytes?: number
  readonly processRunner?: RunnerProcess
  readonly secretEnvNames?: readonly string[]
  readonly secretValues?: readonly string[]
  readonly timeoutMs?: number
}

export class GenericCommandRunner implements RunnerAdapter<GenericRunnerRequest> {
  readonly #options: GenericCommandRunnerOptions
  readonly #processRunner: RunnerProcess

  public constructor(options: GenericCommandRunnerOptions) {
    this.#options = options
    this.#processRunner = options.processRunner ?? new SafeProcessRunner()
  }

  public async run(request: GenericRunnerRequest): Promise<RunnerResult> {
    const definition = this.#findDefinition(request.commandId)
    ensureCommandAllowed(definition.command, this.#options.genericCommandAllowlist)
    validateExecutable(definition.command, "generic runner")
    validateArgs(definition.args, "generic runner")
    rejectShellInterpreterCommand(definition.command, definition.args, "generic runner")
    if (request.mode === "analysis_only") {
      ensureAnalysisCommandSafe([definition.id, definition.command, ...definition.args])
    }
    const envSource = this.#options.env ?? process.env
    const secretValues = this.#secretValues(envSource)

    const processResult = await this.#processRunner.run({
      args: definition.args,
      command: definition.command,
      cwd: request.worktreePath,
      env: selectAllowedEnv(envSource, this.#options.envAllowlist ?? defaultEnvAllowlist),
      outputLimitBytes: this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretRedactionValues: secretValues,
      timeoutMs: this.#options.timeoutMs ?? defaultRunnerTimeoutMs,
    })
    const dirtyAnalysisWorktree =
      request.mode === "analysis_only" &&
      !(await this.#options.cleanChecker.isClean(request.worktreePath))
    if (dirtyAnalysisWorktree) {
      throw new RunnerDirtyWorktreeError(
        request.worktreePath,
        processResult.exitCode === 0
          ? undefined
          : { command: definition.command, exitCode: processResult.exitCode },
      )
    }
    if (processResult.exitCode !== 0) {
      throw new RunnerProcessError(
        definition.command,
        processResult.exitCode,
        redactRunnerOutput(
          processResult.stderr,
          this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
          secretValues,
        ),
      )
    }

    return {
      analysis: redactRunnerOutput(
        processResult.stdout,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      command: definition.id,
      mode: request.mode,
      stderr: redactRunnerOutput(
        processResult.stderr,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      stdout: redactRunnerOutput(
        processResult.stdout,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
    }
  }

  #secretValues(envSource: Readonly<Record<string, string | undefined>>): readonly string[] {
    const envValues = (this.#options.secretEnvNames ?? []).flatMap((name) => {
      const value = envSource[name]
      return value === undefined ? [] : [value]
    })
    return [...(this.#options.secretValues ?? []), ...envValues]
  }

  #findDefinition(commandId: string): RunnerCommandDefinition {
    const definition = this.#options.definitions.find((candidate) => candidate.id === commandId)
    if (definition === undefined) {
      throw new RunnerPolicyError(`runner command ${commandId} is not configured`)
    }
    return definition
  }
}
