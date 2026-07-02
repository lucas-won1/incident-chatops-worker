import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { CodexExecRunner, type RunnerCleanChecker } from "../../src/runner/index.js"
import { LastMessageProcess } from "./codex-test-fakes.js"

const incidentContext = {
  issueId: "SENTRY-DIRTY",
  trustBoundary: "untrusted_external_sentry",
} as const

class DirtyStatusCleanChecker implements RunnerCleanChecker {
  public async isClean(): Promise<boolean> {
    return false
  }

  public async dirtyStatus(): Promise<string> {
    return " M apps/web/page.tsx\n?? scratch.txt"
  }
}

describe("Codex analysis-only dirty workspace diagnostics", () => {
  it("includes git status details when analysis-only execution modifies files", async () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), "incident-codex-dirty-output-"))
    const runner = new CodexExecRunner({
      cleanChecker: new DirtyStatusCleanChecker(),
      env: { CODEX_BIN: "codex", HOME: "/tmp", PATH: "/usr/bin" },
      outputRoot,
      processRunner: new LastMessageProcess(JSON.stringify({ analysis: "analysis" })),
    })

    try {
      await expect(
        runner.run({
          allowedCommands: ["pnpm test"],
          incidentContext,
          mode: "analysis_only",
          repositoryConstraints: "Use only the approved workspace.",
          workspacePath: "/tmp/incident-workspace",
        }),
      ).rejects.toThrow(/apps\/web\/page\.tsx.*scratch\.txt/su)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
