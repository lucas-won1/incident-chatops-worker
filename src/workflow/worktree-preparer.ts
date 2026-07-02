import { SafeProcessRunner } from "../runner/process.js"
import { applyProjectEnvironment, type ProjectEnvironmentConfig } from "../runner/project-env.js"
import {
  defaultEnvAllowlist,
  defaultOutputLimitBytes,
  rejectShellInterpreterCommand,
  selectAllowedEnv,
  validateArgs,
  validateExecutable,
} from "../runner/safety.js"
import type { RunnerProcess } from "../runner/types.js"
import type { WorkflowWorktreePreparer } from "./types.js"

export type WorktreePreparationCommand = {
  readonly args: readonly string[]
  readonly command: string
}

export type CommandWorktreePreparerOptions = {
  readonly commands: readonly WorktreePreparationCommand[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly outputLimitBytes?: number
  readonly processRunner?: RunnerProcess
  readonly projectEnv?: ProjectEnvironmentConfig | undefined
  readonly secretValues?: readonly string[]
  readonly timeoutMs: number
}

export class WorktreePreparationError extends Error {
  public constructor(
    public readonly commandText: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(
      `worktree prepare command failed exit=${exitCode} command=${commandText} stderr=${stderr}`,
    )
    this.name = "WorktreePreparationError"
  }
}

const commandText = (command: WorktreePreparationCommand): string =>
  [command.command, ...command.args].join(" ")

const validatePreparationCommand = (command: WorktreePreparationCommand): void => {
  validateExecutable(command.command, "worktree prepare")
  validateArgs(command.args, "worktree prepare")
  rejectShellInterpreterCommand(command.command, command.args, "worktree prepare")
}

export class CommandWorktreePreparer implements WorkflowWorktreePreparer {
  readonly #commands: readonly WorktreePreparationCommand[]
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #outputLimitBytes: number
  readonly #processRunner: RunnerProcess
  readonly #projectEnv: ProjectEnvironmentConfig | undefined
  readonly #secretValues: readonly string[]
  readonly #timeoutMs: number

  public constructor(options: CommandWorktreePreparerOptions) {
    this.#commands = options.commands
    this.#env = options.env ?? process.env
    this.#outputLimitBytes = options.outputLimitBytes ?? defaultOutputLimitBytes
    this.#processRunner = options.processRunner ?? new SafeProcessRunner()
    this.#projectEnv = options.projectEnv
    this.#secretValues = options.secretValues ?? []
    this.#timeoutMs = options.timeoutMs
  }

  public async prepare(input: Parameters<WorkflowWorktreePreparer["prepare"]>[0]): Promise<void> {
    for (const command of this.#commands) {
      validatePreparationCommand(command)
      const invocation = applyProjectEnvironment(command, this.#projectEnv)
      const result = await this.#processRunner.run({
        args: invocation.args,
        command: invocation.command,
        cwd: input.session.worktreePath,
        env: selectAllowedEnv(this.#env, defaultEnvAllowlist),
        outputLimitBytes: this.#outputLimitBytes,
        secretRedactionValues: this.#secretValues,
        timeoutMs: this.#timeoutMs,
      })
      if (result.exitCode !== 0) {
        throw new WorktreePreparationError(commandText(command), result.exitCode, result.stderr)
      }
    }
  }
}
