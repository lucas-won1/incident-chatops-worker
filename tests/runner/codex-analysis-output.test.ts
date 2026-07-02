import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  CodexExecRunner,
  type RunnerCleanChecker,
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

  public constructor(
    private readonly result: RunnerProcessResult = { exitCode: 0, stderr: "", stdout: "" },
  ) {}

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    return this.result
  }
}

class FixedCleanChecker implements RunnerCleanChecker {
  public constructor(private readonly clean: boolean) {}

  public async isClean(): Promise<boolean> {
    return this.clean
  }
}

const createRunner = (outputRoot: string, processRunner: RunnerProcess): CodexExecRunner =>
  new CodexExecRunner({
    cleanChecker: new FixedCleanChecker(true),
    env: { CODEX_BIN: "codex", HOME: "/tmp", PATH: "/usr/bin" },
    outputRoot,
    processRunner,
  })

const runAnalysis = async (runner: CodexExecRunner) =>
  runner.run({
    allowedCommands: ["pnpm test"],
    incidentContext,
    mode: "analysis_only",
    repositoryConstraints: "Use only the approved workspace.",
    workspacePath: "/tmp/incident-workspace",
  })

const runFix = async (runner: CodexExecRunner) =>
  runner.run({
    allowedCommands: ["pnpm test"],
    incidentContext,
    mode: "fix_and_mr",
    repositoryConstraints: "Use only the approved workspace.",
    workspacePath: "/tmp/incident-workspace",
  })

describe("Codex analysis-only structured output", () => {
  it("returns parsed output-last-message analysis instead of transport stdout", async () => {
    // Given: Codex writes structured analysis to the last-message file and emits transport logs.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-analysis-output-"))
    const processRunner = new LastMessageProcess(
      JSON.stringify({ analysis: "Parsed root cause." }),
      {
        exitCode: 0,
        stderr: "codex transport stderr",
        stdout: "codex transport stdout",
      },
    )
    const runner = createRunner(outputRoot, processRunner)

    try {
      // When: analysis-only execution completes successfully at the process layer.
      const result = await runAnalysis(runner)

      // Then: workflow-visible analysis comes from structured JSON, while logs remain logs.
      expect(result.analysis).toBe("Parsed root cause.")
      expect(result.stdout).toBe("codex transport stdout")
      expect(result.stderr).toBe("codex transport stderr")
      expect(result.verificationResults).toBeUndefined()
      expect(result.analysis).not.toContain("transport")
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it("rejects missing output-last-message instead of treating stdout as success", async () => {
    // Given: Codex exits successfully but does not write the required analysis last-message file.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-missing-analysis-output-"))
    const runner = createRunner(
      outputRoot,
      new RecordingProcess({
        exitCode: 0,
        stderr: "",
        stdout: "codex transport stdout",
      }),
    )

    try {
      // When / Then: the adapter fails closed with a typed output error.
      await expect(runAnalysis(runner)).rejects.toThrow(RunnerOutputParseError)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it.each([
    { lastMessageJson: "{not-json", name: "malformed JSON" },
    { lastMessageJson: JSON.stringify({ analysis: "" }), name: "empty analysis" },
    {
      lastMessageJson: JSON.stringify({ analysis: "Parsed root cause.", extra: "unexpected" }),
      name: "extra field",
    },
  ] as const)("rejects $name output-last-message", async ({ lastMessageJson }) => {
    // Given: Codex exits successfully but writes invalid analysis last-message content.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-bad-analysis-output-"))
    const runner = createRunner(outputRoot, new LastMessageProcess(lastMessageJson))

    try {
      // When / Then: the adapter fails closed at the structured JSON boundary.
      await expect(runAnalysis(runner)).rejects.toThrow(RunnerOutputParseError)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  it("returns runner-authored merge request body from fix output", async () => {
    // Given: Codex writes a complete project-aware MR body in the fix last-message JSON.
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-fix-output-"))
    const runner = createRunner(
      outputRoot,
      new LastMessageProcess(
        JSON.stringify({
          analysis: "원인",
          branchInfo: "incident/SENTRY-123",
          changesSummary: "수정",
          mergeRequestBody: "## 요약\n\n- 프로젝트 규칙 반영",
          mrReadiness: "준비됨",
          verificationResults: "passed: pnpm test",
        }),
      ),
    )

    try {
      // When: fix execution completes successfully.
      const result = await runFix(runner)

      // Then: workflow-visible MR body comes from structured runner output.
      expect(result.mergeRequestBody).toBe("## 요약\n\n- 프로젝트 규칙 반영")
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
