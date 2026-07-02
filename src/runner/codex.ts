import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { z } from "zod"

import { dirtyStatusFor } from "./clean-checker.js"
import {
  codexAnalysisOutputSchema,
  codexFixOutputSchema,
  parseCodexOutputJson,
} from "./codex-output.js"
import { RunnerDirtyWorktreeError, RunnerOutputParseError, RunnerProcessError } from "./errors.js"
import { SafeProcessRunner } from "./process.js"
import { applyProjectEnvironment, type ProjectEnvironmentConfig } from "./project-env.js"
import { buildPromptEnvelope } from "./prompt.js"
import {
  defaultEnvAllowlist,
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

export type CodexExecRunnerOptions = {
  readonly bin?: string | undefined
  readonly cleanChecker: RunnerCleanChecker
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly envAllowlist?: readonly string[]
  readonly home?: string | undefined
  readonly model?: string | undefined
  readonly outputLimitBytes?: number
  readonly outputRoot?: string
  readonly profile?: string | undefined
  readonly projectEnv?: ProjectEnvironmentConfig | undefined
  readonly processRunner?: RunnerProcess
  readonly secretEnvNames?: readonly string[]
  readonly secretValues?: readonly string[]
  readonly timeoutMs?: number
  readonly workspaceWriteNetworkAccess?: boolean
}

export class CodexExecRunner implements RunnerAdapter {
  readonly #options: CodexExecRunnerOptions
  readonly #processRunner: RunnerProcess

  public constructor(options: CodexExecRunnerOptions) {
    this.#options = options
    this.#processRunner = options.processRunner ?? new SafeProcessRunner()
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    const workspacePath = runnerWorkspacePath(request)
    const envSource = this.#options.env ?? process.env
    const codexBin = this.#options.bin ?? "codex"
    const instanceArgs = this.#instanceArgs()
    const secretValues = this.#secretValues(envSource)
    validateExecutable(codexBin, "Codex")
    validateArgs(instanceArgs, "Codex instance")
    const outputPath = await this.#outputPath(request.mode)
    const sandbox = request.mode === "analysis_only" ? "read-only" : "workspace-write"
    const codexInvocation = applyProjectEnvironment(
      {
        args: [
          "exec",
          ...instanceArgs,
          "--json",
          "--cd",
          workspacePath,
          "--sandbox",
          sandbox,
          "--output-last-message",
          outputPath,
          "-",
        ],
        command: codexBin,
      },
      this.#options.projectEnv,
    )
    const result = await this.#processRunner.run({
      args: codexInvocation.args,
      command: codexInvocation.command,
      cwd: workspacePath,
      env: this.#childEnv(envSource),
      outputLimitBytes: this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretRedactionValues: secretValues,
      stdin: buildPromptEnvelope(request),
      timeoutMs: this.#options.timeoutMs ?? defaultRunnerTimeoutMs,
    })
    const dirtyAnalysisWorktree =
      request.mode === "analysis_only" && !(await this.#options.cleanChecker.isClean(workspacePath))
    if (dirtyAnalysisWorktree) {
      throw new RunnerDirtyWorktreeError(
        workspacePath,
        result.exitCode === 0 ? undefined : { command: codexBin, exitCode: result.exitCode },
        await dirtyStatusFor(this.#options.cleanChecker, workspacePath),
      )
    }
    if (result.exitCode !== 0) {
      throw new RunnerProcessError(
        codexBin,
        result.exitCode,
        redactRunnerOutput(
          result.stderr,
          this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
          secretValues,
        ),
      )
    }

    return await this.#result(request, result.stdout, result.stderr, outputPath, secretValues)
  }

  #instanceArgs(): readonly string[] {
    return [
      ...(this.#options.profile === undefined ? [] : ["--profile", this.#options.profile]),
      ...(this.#options.model === undefined ? [] : ["--model", this.#options.model]),
      ...(this.#options.workspaceWriteNetworkAccess === true
        ? ["-c", "sandbox_workspace_write.network_access=true"]
        : []),
    ]
  }

  #childEnv(
    envSource: Readonly<Record<string, string | undefined>>,
  ): Readonly<Record<string, string>> {
    const selected = selectAllowedEnv(envSource, [
      ...defaultEnvAllowlist,
      ...(this.#options.envAllowlist ?? []),
    ])
    if (this.#options.home === undefined) {
      return selected
    }
    return {
      ...selected,
      CODEX_HOME: this.#options.home,
    }
  }

  async #outputPath(mode: "analysis_only" | "fix_and_mr"): Promise<string> {
    const root = this.#options.outputRoot ?? path.join(tmpdir(), "incident-chatops-runner")
    await mkdir(root, { recursive: true })
    const runDirectory = await mkdtemp(path.join(root, `${mode}-`))
    const outputFile = mode === "analysis_only" ? "analysis-output.json" : "fix-output.json"
    return path.join(runDirectory, outputFile)
  }

  #secretValues(envSource: Readonly<Record<string, string | undefined>>): readonly string[] {
    const envValues = (this.#options.secretEnvNames ?? []).flatMap((name) => {
      const value = envSource[name]
      return value === undefined ? [] : [value]
    })
    return [...(this.#options.secretValues ?? []), ...envValues]
  }

  async #result(
    request: RunnerRequest,
    stdout: string,
    stderr: string,
    outputPath: string,
    secretValues: readonly string[],
  ): Promise<RunnerResult> {
    const safeStdout = this.#redact(stdout, secretValues)
    const safeStderr = this.#redact(stderr, secretValues)
    if (request.mode === "analysis_only") {
      return this.#analysisResult(request, safeStdout, safeStderr, outputPath, secretValues)
    }
    return this.#fixResult(request, safeStdout, safeStderr, outputPath, secretValues)
  }

  async #analysisResult(
    request: RunnerRequest,
    safeStdout: string,
    safeStderr: string,
    outputPath: string,
    secretValues: readonly string[],
  ): Promise<RunnerResult> {
    const parsed = await this.#parseOutputLastMessage(outputPath, codexAnalysisOutputSchema)
    return {
      analysis: this.#redact(parsed.analysis, secretValues),
      command: "codex",
      mode: request.mode,
      stderr: safeStderr,
      stdout: safeStdout,
    }
  }

  async #fixResult(
    request: RunnerRequest,
    safeStdout: string,
    safeStderr: string,
    outputPath: string,
    secretValues: readonly string[],
  ): Promise<RunnerResult> {
    const parsed = await this.#parseOutputLastMessage(outputPath, codexFixOutputSchema)
    return {
      analysis: this.#redact(parsed.analysis, secretValues),
      branchInfo: this.#redact(parsed.branchInfo, secretValues),
      changesSummary: this.#redact(parsed.changesSummary, secretValues),
      command: "codex",
      mergeRequestBody: this.#redact(parsed.mergeRequestBody, secretValues),
      mode: request.mode,
      mrReadiness: this.#redact(parsed.mrReadiness, secretValues),
      stderr: safeStderr,
      stdout: safeStdout,
      verificationResults: this.#redact(parsed.verificationResults, secretValues),
    }
  }

  #redact(value: string, secretValues: readonly string[]): string {
    return redactRunnerOutput(
      value,
      this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretValues,
    )
  }

  async #parseOutputLastMessage<T>(outputPath: string, schema: z.ZodType<T>): Promise<T> {
    const rawOutput = await this.#readOutputLastMessage(outputPath)
    if (rawOutput === undefined) {
      throw new RunnerOutputParseError(`Codex output-last-message JSON is missing: ${outputPath}`)
    }
    return parseCodexOutputJson(rawOutput, schema)
  }

  async #readOutputLastMessage(outputPath: string): Promise<string | undefined> {
    try {
      return await readFile(outputPath, "utf8")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined
      }
      if (error instanceof Error) {
        throw new RunnerOutputParseError(
          `Codex output-last-message JSON could not be read: ${error.message}`,
        )
      }
      throw error
    }
  }
}
