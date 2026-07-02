import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { z } from "zod"
import {
  analysisFields,
  claudeAnalysisOutputSchema,
  claudeFixOutputSchema,
  fixFields,
  jsonSchemaFor,
  parseClaudeOutput,
} from "./claude-code-output.js"
import { dirtyStatusFor } from "./clean-checker.js"
import { RunnerDirtyWorktreeError, RunnerPolicyError, RunnerProcessError } from "./errors.js"
import { SafeProcessRunner } from "./process.js"
import { applyProjectEnvironment, type ProjectEnvironmentConfig } from "./project-env.js"
import { buildPromptEnvelope } from "./prompt.js"
import {
  defaultOutputLimitBytes,
  defaultRunnerTimeoutMs,
  redactRunnerOutput,
  selectAllowedEnv,
  validateArgs,
  validateExecutable,
} from "./safety.js"
import type {
  RunnerAdapter,
  RunnerCleanChecker,
  RunnerProcess,
  RunnerRequest,
  RunnerResult,
} from "./types.js"
import { runnerWorkspacePath } from "./types.js"

const claudeEnvAllowlist = ["PATH", "HOME"] as const

const forbiddenPermissionTokens = [
  "bypasspermissions",
  "--dangerously-bypass-",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
] as const

export type ClaudeCodeRunnerOptions = {
  readonly allowedTools?: readonly string[]
  readonly bin?: string | undefined
  readonly cleanChecker: RunnerCleanChecker
  readonly configDir?: string | undefined
  readonly disallowedTools?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly envAllowlist?: readonly string[]
  readonly model?: string | undefined
  readonly outputLimitBytes?: number
  readonly permissionMode?: string | undefined
  readonly processRunner?: RunnerProcess
  readonly projectEnv?: ProjectEnvironmentConfig | undefined
  readonly secretEnvNames?: readonly string[]
  readonly secretValues?: readonly string[]
  readonly settingsPath?: string | undefined
  readonly timeoutMs?: number
}

export class ClaudeCodeRunner implements RunnerAdapter {
  readonly #options: ClaudeCodeRunnerOptions
  readonly #processRunner: RunnerProcess

  public constructor(options: ClaudeCodeRunnerOptions) {
    this.#rejectDangerousPermissionConfig(options)
    this.#options = options
    this.#processRunner = options.processRunner ?? new SafeProcessRunner()
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    const workspacePath = runnerWorkspacePath(request)
    const envSource = this.#options.env ?? process.env
    const claudeBin = this.#options.bin ?? "claude"
    const instanceArgs = this.#instanceArgs()
    const secretValues = this.#secretValues(envSource)
    validateExecutable(claudeBin, "Claude Code")
    validateArgs(instanceArgs, "Claude Code instance")
    const schemaDirectory = await mkdtemp(path.join(tmpdir(), "claude-code-schema-"))
    const schemaPath = path.join(schemaDirectory, "schema.json")
    const schemaFields = request.mode === "analysis_only" ? analysisFields : fixFields
    await writeFile(schemaPath, JSON.stringify(jsonSchemaFor(schemaFields)), "utf8")
    const claudeInvocation = applyProjectEnvironment(
      {
        args: ["-p", "--output-format", "json", "--json-schema", schemaPath, ...instanceArgs],
        command: claudeBin,
      },
      this.#options.projectEnv,
    )

    try {
      const processResult = await this.#processRunner.run({
        args: claudeInvocation.args,
        command: claudeInvocation.command,
        cwd: workspacePath,
        env: this.#childEnv(envSource),
        outputLimitBytes: this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretRedactionValues: secretValues,
        stdin: buildPromptEnvelope(request),
        timeoutMs: this.#options.timeoutMs ?? defaultRunnerTimeoutMs,
      })
      const dirtyAnalysisWorktree =
        request.mode === "analysis_only" &&
        !(await this.#options.cleanChecker.isClean(workspacePath))
      if (dirtyAnalysisWorktree) {
        throw new RunnerDirtyWorktreeError(
          workspacePath,
          processResult.exitCode === 0
            ? undefined
            : { command: claudeBin, exitCode: processResult.exitCode },
          await dirtyStatusFor(this.#options.cleanChecker, workspacePath),
        )
      }
      if (processResult.exitCode !== 0) {
        throw new RunnerProcessError(
          claudeBin,
          processResult.exitCode,
          this.#redact(processResult.stderr, secretValues),
        )
      }
      return this.#result(request, processResult.stdout, processResult.stderr, secretValues)
    } finally {
      await rm(schemaDirectory, { force: true, recursive: true })
    }
  }

  #instanceArgs(): readonly string[] {
    return [
      ...(this.#options.settingsPath === undefined
        ? []
        : ["--settings", this.#options.settingsPath]),
      ...(this.#options.model === undefined ? [] : ["--model", this.#options.model]),
      ...(this.#options.permissionMode === undefined
        ? []
        : ["--permission-mode", this.#options.permissionMode]),
      ...this.#toolArg("--allowedTools", this.#options.allowedTools ?? []),
      ...this.#toolArg("--disallowedTools", this.#options.disallowedTools ?? []),
    ]
  }

  #toolArg(flag: string, tools: readonly string[]): readonly string[] {
    return tools.length === 0 ? [] : [flag, tools.join(",")]
  }

  #childEnv(
    envSource: Readonly<Record<string, string | undefined>>,
  ): Readonly<Record<string, string>> {
    const selected = selectAllowedEnv(envSource, [
      ...claudeEnvAllowlist,
      ...(this.#options.envAllowlist ?? []),
    ])
    if (this.#options.configDir === undefined) {
      return selected
    }
    return {
      ...selected,
      CLAUDE_CONFIG_DIR: this.#options.configDir,
    }
  }

  #secretValues(envSource: Readonly<Record<string, string | undefined>>): readonly string[] {
    const envValues = (this.#options.secretEnvNames ?? []).flatMap((name) => {
      const value = envSource[name]
      return value === undefined ? [] : [value]
    })
    return [...(this.#options.secretValues ?? []), ...envValues]
  }

  #result(
    request: RunnerRequest,
    stdout: string,
    stderr: string,
    secretValues: readonly string[],
  ): RunnerResult {
    const safeStdout = this.#redact(stdout, secretValues)
    const safeStderr = this.#redact(stderr, secretValues)
    if (request.mode === "analysis_only") {
      const parsed = this.#parseOutput(stdout, claudeAnalysisOutputSchema)
      return {
        analysis: this.#redact(parsed.analysis, secretValues),
        command: "claude-code",
        mode: request.mode,
        stderr: safeStderr,
        stdout: safeStdout,
      }
    }
    const parsed = this.#parseOutput(stdout, claudeFixOutputSchema)
    return {
      analysis: this.#redact(parsed.analysis, secretValues),
      branchInfo: this.#redact(parsed.branchInfo, secretValues),
      changesSummary: this.#redact(parsed.changesSummary, secretValues),
      command: "claude-code",
      mergeRequestBody: this.#redact(parsed.mergeRequestBody, secretValues),
      mode: request.mode,
      mrReadiness: this.#redact(parsed.mrReadiness, secretValues),
      stderr: safeStderr,
      stdout: safeStdout,
      verificationResults: this.#redact(parsed.verificationResults, secretValues),
    }
  }

  #parseOutput<T>(stdout: string, schema: z.ZodType<T>): T {
    return parseClaudeOutput(stdout, schema)
  }

  #redact(value: string, secretValues: readonly string[]): string {
    return redactRunnerOutput(
      value,
      this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretValues,
    )
  }

  #rejectDangerousPermissionConfig(options: ClaudeCodeRunnerOptions): void {
    for (const value of [
      options.permissionMode,
      ...(options.allowedTools ?? []),
      ...(options.disallowedTools ?? []),
    ]) {
      const lowered = value?.toLowerCase() ?? ""
      if (forbiddenPermissionTokens.some((token) => lowered.includes(token))) {
        throw new RunnerPolicyError("Claude Code config contains forbidden permission bypass")
      }
    }
  }
}
