import { daemonSecretValues, serviceTokenEnvNames } from "../cli/mr-provider-routing.js"
import type { WorkerSettings } from "../config/index.js"
import { assertNever } from "../shared/assert-never.js"
import { ClaudeCodeRunner } from "./claude-code.js"
import { GitRunnerCleanChecker } from "./clean-checker.js"
import { CodexExecRunner } from "./codex.js"
import { RunnerPolicyError } from "./errors.js"
import { GenericCommandRunner } from "./generic.js"
import type {
  GenericRunnerRequest,
  RunnerAdapter,
  RunnerCleanChecker,
  RunnerProcess,
  RunnerRequest,
  RunnerResult,
} from "./types.js"

export class UnsupportedRunnerProviderError extends RunnerPolicyError {
  public constructor(provider: string) {
    super(`runner provider ${provider} is not supported by the production factory yet`)
    this.name = "UnsupportedRunnerProviderError"
  }
}

export class UnsupportedRunnerModeError extends RunnerPolicyError {
  public constructor(provider: string, mode: string, reason: string) {
    super(`runner provider ${provider} mode ${mode} is not supported: ${reason}`)
    this.name = "UnsupportedRunnerModeError"
  }
}

export class ModeAwareGenericRunner implements RunnerAdapter<RunnerRequest> {
  readonly #analysisCommandId: string | undefined
  readonly #fixCommandId: string | undefined
  readonly #runner: GenericCommandRunner

  public constructor(options: {
    readonly analysisCommandId?: string | undefined
    readonly fixCommandId?: string | undefined
    readonly runner: GenericCommandRunner
  }) {
    this.#analysisCommandId = options.analysisCommandId
    this.#fixCommandId = options.fixCommandId
    this.#runner = options.runner
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    return await this.#runner.run({
      ...request,
      commandId: this.#commandId(request.mode),
    } satisfies GenericRunnerRequest)
  }

  #commandId(mode: RunnerRequest["mode"]): string {
    switch (mode) {
      case "analysis_only":
        return this.#configuredCommandId(this.#analysisCommandId, mode)
      case "fix_and_mr":
        return this.#configuredCommandId(this.#fixCommandId, mode)
      default:
        return assertNever(mode)
    }
  }

  #configuredCommandId(commandId: string | undefined, mode: RunnerRequest["mode"]): string {
    if (commandId === undefined) {
      throw new RunnerPolicyError(`generic runner ${mode} command id is not configured`)
    }
    return commandId
  }
}

export type ProductionRunnerFactoryOptions = {
  readonly cleanChecker?: RunnerCleanChecker
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly processRunner?: RunnerProcess
}

export const createProductionRunner = (
  settings: WorkerSettings,
  options: ProductionRunnerFactoryOptions = {},
): RunnerAdapter<RunnerRequest> => {
  const cleanChecker = options.cleanChecker ?? new GitRunnerCleanChecker()
  const envOption = options.env === undefined ? {} : { env: options.env }
  const processOption =
    options.processRunner === undefined ? {} : { processRunner: options.processRunner }
  const projectEnvOption =
    settings.config.runners.projectEnv === undefined
      ? {}
      : { projectEnv: settings.config.runners.projectEnv }

  switch (settings.config.runners.provider) {
    case "codex": {
      const codex = settings.config.runners.codex
      return new CodexExecRunner({
        ...(codex.bin === undefined ? {} : { bin: codex.bin }),
        cleanChecker,
        ...envOption,
        envAllowlist: codex.extraEnvAllowlist,
        ...(codex.home === undefined ? {} : { home: codex.home }),
        ...(codex.model === undefined ? {} : { model: codex.model }),
        ...(codex.outputRoot === undefined ? {} : { outputRoot: codex.outputRoot }),
        ...(codex.profile === undefined ? {} : { profile: codex.profile }),
        ...projectEnvOption,
        ...processOption,
        secretEnvNames: serviceTokenEnvNames,
        secretValues: daemonSecretValues(settings),
        workspaceWriteNetworkAccess: codex.workspaceWriteNetworkAccess,
      })
    }
    case "generic":
      return new ModeAwareGenericRunner({
        analysisCommandId: settings.config.runners.generic.analysisCommandId,
        fixCommandId: settings.config.runners.generic.fixCommandId,
        runner: new GenericCommandRunner({
          cleanChecker,
          definitions: settings.config.runners.generic.definitions,
          ...envOption,
          genericCommandAllowlist: settings.config.runners.generic.commandAllowlist,
          ...projectEnvOption,
          ...processOption,
          secretEnvNames: serviceTokenEnvNames,
          secretValues: daemonSecretValues(settings),
        }),
      })
    case "claude-code":
      return new ClaudeCodeRunner({
        allowedTools: settings.config.runners.claudeCode.allowedTools,
        ...(settings.config.runners.claudeCode.bin === undefined
          ? {}
          : { bin: settings.config.runners.claudeCode.bin }),
        cleanChecker,
        ...(settings.config.runners.claudeCode.configDir === undefined
          ? {}
          : { configDir: settings.config.runners.claudeCode.configDir }),
        disallowedTools: settings.config.runners.claudeCode.disallowedTools,
        ...envOption,
        envAllowlist: settings.config.runners.claudeCode.extraEnvAllowlist,
        ...(settings.config.runners.claudeCode.model === undefined
          ? {}
          : { model: settings.config.runners.claudeCode.model }),
        ...(settings.config.runners.claudeCode.permissionMode === undefined
          ? {}
          : { permissionMode: settings.config.runners.claudeCode.permissionMode }),
        ...projectEnvOption,
        ...processOption,
        secretEnvNames: serviceTokenEnvNames,
        secretValues: daemonSecretValues(settings),
        ...(settings.config.runners.claudeCode.settingsPath === undefined
          ? {}
          : { settingsPath: settings.config.runners.claudeCode.settingsPath }),
      })
    default:
      return assertNever(settings.config.runners.provider)
  }
}
