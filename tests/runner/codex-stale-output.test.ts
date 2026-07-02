import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  CodexExecRunner,
  type RunnerCleanChecker,
  type RunnerModeName,
  RunnerOutputParseError,
  type RunnerProcess,
  type RunnerProcessInvocation,
  type RunnerProcessResult,
} from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const incidentContext = {
  issueId: "SENTRY-123",
  trustBoundary: "untrusted_external_sentry",
} as const

class RecordingProcess implements RunnerProcess {
  public readonly invocations: RunnerProcessInvocation[] = []

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    return { exitCode: 0, stderr: "", stdout: "codex transport stdout" }
  }
}

class FixedCleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return true
  }
}

const createRunner = (outputRoot: string, processRunner: RunnerProcess): CodexExecRunner =>
  new CodexExecRunner({
    cleanChecker: new FixedCleanChecker(),
    env: { CODEX_BIN: "codex", HOME: "/tmp", PATH: "/usr/bin" },
    outputRoot,
    processRunner,
  })

const runCodex = async (runner: CodexExecRunner, mode: RunnerModeName) =>
  runner.run({
    allowedCommands: ["pnpm test"],
    incidentContext,
    mode,
    repositoryConstraints: "Use only the approved workspace.",
    workspacePath: "/tmp/incident-workspace",
  })

const outputLastMessagePath = (invocation: RunnerProcessInvocation | undefined): string => {
  if (invocation === undefined) {
    throw new Error("missing process invocation")
  }
  const outputFlagIndex = invocation.args.indexOf("--output-last-message")
  const outputPath = invocation.args[outputFlagIndex + 1]
  if (outputFlagIndex === -1 || outputPath === undefined) {
    throw new Error("missing --output-last-message path")
  }
  return outputPath
}

describe("Codex stale output-last-message protection", () => {
  it("rejects stale analysis output when the current process exits without writing", async () => {
    // Given: a previous analysis run wrote valid structured output under the same output root.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-stale-analysis-"))
    const firstProcess = new LastMessageProcess(JSON.stringify({ analysis: "stale analysis" }))
    const secondProcess = new RecordingProcess()
    const firstRunner = createRunner(outputRoot, firstProcess)
    const secondRunner = createRunner(outputRoot, secondProcess)

    try {
      const firstResult = await runCodex(firstRunner, "analysis_only")
      expect(firstResult.analysis).toBe("stale analysis")

      // When / Then: a later successful process that writes nothing must fail closed.
      await expect(runCodex(secondRunner, "analysis_only")).rejects.toThrow(RunnerOutputParseError)
      expect(outputLastMessagePath(secondProcess.invocations[0])).not.toBe(
        outputLastMessagePath(firstProcess.invocations[0]),
      )
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it("rejects stale fix output when the current process exits without writing", async () => {
    // Given: a previous fix run wrote valid structured output under the same output root.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-stale-fix-"))
    const firstProcess = new LastMessageProcess(
      JSON.stringify({
        analysis: "stale fix analysis",
        branchInfo: "incident/SENTRY-123",
        changesSummary: "stale changes",
        mergeRequestBody: "## 요약\n\n- stale changes",
        mrReadiness: "ready",
        verificationResults: "passed: stale",
      }),
    )
    const secondProcess = new RecordingProcess()
    const firstRunner = createRunner(outputRoot, firstProcess)
    const secondRunner = createRunner(outputRoot, secondProcess)

    try {
      const firstResult = await runCodex(firstRunner, "fix_and_mr")
      expect(firstResult.verificationResults).toBe("passed: stale")

      // When / Then: a later successful process that writes nothing must fail closed.
      await expect(runCodex(secondRunner, "fix_and_mr")).rejects.toThrow(RunnerOutputParseError)
      expect(outputLastMessagePath(secondProcess.invocations[0])).not.toBe(
        outputLastMessagePath(firstProcess.invocations[0]),
      )
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
