import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { ZodError, z } from "zod"

import { RunnerDirtyWorktreeError, RunnerOutputParseError, RunnerProcessError } from "./errors.js"
import { SafeProcessRunner } from "./process.js"
import { buildPromptEnvelope } from "./prompt.js"
import {
  defaultEnvAllowlist,
  defaultOutputLimitBytes,
  defaultRunnerTimeoutMs,
  redactRunnerOutput,
  selectAllowedEnv,
  validateExecutable,
} from "./safety.js"
import type {
  RunnerAdapter,
  RunnerCleanChecker,
  RunnerProcess,
  RunnerRequest,
  RunnerResult,
} from "./types.js"

const codexAnalysisOutputSchema = z
  .object({
    analysis: z.string().min(1),
  })
  .strict()

const codexFixOutputSchema = z.object({
  analysis: z.string().min(1),
  branchInfo: z.string().min(1),
  changesSummary: z.string().min(1),
  mrReadiness: z.string().min(1),
  verificationResults: z.string().min(1),
})

export type CodexExecRunnerOptions = {
  readonly cleanChecker: RunnerCleanChecker
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly envAllowlist?: readonly string[]
  readonly outputLimitBytes?: number
  readonly outputRoot?: string
  readonly processRunner?: RunnerProcess
  readonly secretEnvNames?: readonly string[]
  readonly secretValues?: readonly string[]
  readonly timeoutMs?: number
}

export class CodexExecRunner implements RunnerAdapter {
  readonly #options: CodexExecRunnerOptions
  readonly #processRunner: RunnerProcess
  readonly #codexBinEnvName = "CODEX_BIN"

  public constructor(options: CodexExecRunnerOptions) {
    this.#options = options
    this.#processRunner = options.processRunner ?? new SafeProcessRunner()
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    const envSource = this.#options.env ?? process.env
    const codexBin = envSource[this.#codexBinEnvName] ?? "codex"
    const secretValues = this.#secretValues(envSource)
    validateExecutable(codexBin, "Codex")
    const outputPath = await this.#outputPath(request.mode)
    const sandbox = request.mode === "analysis_only" ? "read-only" : "workspace-write"
    const result = await this.#processRunner.run({
      args: [
        "exec",
        "--json",
        "--cd",
        request.worktreePath,
        "--sandbox",
        sandbox,
        "--output-last-message",
        outputPath,
        "-",
      ],
      command: codexBin,
      cwd: request.worktreePath,
      env: selectAllowedEnv(envSource, [
        ...defaultEnvAllowlist,
        ...(this.#options.envAllowlist ?? []),
      ]),
      outputLimitBytes: this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretRedactionValues: secretValues,
      stdin: buildPromptEnvelope(request),
      timeoutMs: this.#options.timeoutMs ?? defaultRunnerTimeoutMs,
    })
    const dirtyAnalysisWorktree =
      request.mode === "analysis_only" &&
      !(await this.#options.cleanChecker.isClean(request.worktreePath))
    if (dirtyAnalysisWorktree) {
      throw new RunnerDirtyWorktreeError(
        request.worktreePath,
        result.exitCode === 0 ? undefined : { command: codexBin, exitCode: result.exitCode },
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
    const safeStdout = redactRunnerOutput(
      stdout,
      this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretValues,
    )
    const safeStderr = redactRunnerOutput(
      stderr,
      this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
      secretValues,
    )
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
      analysis: redactRunnerOutput(
        parsed.analysis,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
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
      analysis: redactRunnerOutput(
        parsed.analysis,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      branchInfo: redactRunnerOutput(
        parsed.branchInfo,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      changesSummary: redactRunnerOutput(
        parsed.changesSummary,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      command: "codex",
      mode: request.mode,
      mrReadiness: redactRunnerOutput(
        parsed.mrReadiness,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
      stderr: safeStderr,
      stdout: safeStdout,
      verificationResults: redactRunnerOutput(
        parsed.verificationResults,
        this.#options.outputLimitBytes ?? defaultOutputLimitBytes,
        secretValues,
      ),
    }
  }

  async #parseOutputLastMessage<T>(outputPath: string, schema: z.ZodType<T>): Promise<T> {
    const rawOutput = await this.#readOutputLastMessage(outputPath)
    if (rawOutput === undefined) {
      throw new RunnerOutputParseError(`Codex output-last-message JSON is missing: ${outputPath}`)
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawOutput)
      return schema.parse(parsedJson)
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        throw new RunnerOutputParseError(
          `Codex output-last-message JSON is invalid: ${error.message}`,
        )
      }
      throw error
    }
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
