import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runWorkflowScenarioCommand } from "../../src/workflow/scenario-cli.js"

const tempDirs: string[] = []

const writeScenarioFixture = (name: string, yaml: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-scenario-cli-test-"))
  tempDirs.push(dir)
  const path = join(dir, `${name}.yaml`)
  writeFileSync(path, yaml)
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("workflow scenario CLI", () => {
  it("reports analysis-only execution without worker worktree side effects", async () => {
    // Given: an analysis-only scenario fixture.
    const fixture = writeScenarioFixture(
      "analysis-only",
      `
name: analysis-only
incident:
  channelId: C_SCENARIO
  issueId: SENTRY-ANALYSIS
  repoId: demo-repo
  repoPath: /tmp/demo-repo
  threadTs: "1719356400.000000"
  title: Analysis fixture
actions:
  - analyze
runner:
  analysisSummary: Root cause from fixture.
  dirtyAnalysis: false
`,
    )

    // When: the scenario command runs through the CLI surface helper.
    const result = await runWorkflowScenarioCommand(["--fixture", fixture])

    // Then: the transcript exposes the no-worktree/no-push/no-MR contract.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("runner executions: 1")
    expect(result.stdout).toContain("worker worktree opens: 0")
    expect(result.stdout).toContain("push calls: 0")
    expect(result.stdout).toContain("MR calls: 0")
  })

  it("reports fix MR side effects and cleanup receipt", async () => {
    // Given: a scenario that analyzes and then approves a fix MR.
    const fixture = writeScenarioFixture(
      "fix-mr",
      `
name: fix-mr
incident:
  channelId: C_SCENARIO
  issueId: SENTRY-FIX
  repoId: demo-repo
  repoPath: /tmp/demo-repo
  threadTs: "1719356400.000000"
  title: Fix fixture
actions:
  - analyze
  - fix
runner:
  analysisSummary: Root cause from fixture.
  dirtyAnalysis: false
  verification: passed
mr:
  provider: gitlab
`,
    )

    // When: the scenario command runs through the CLI surface helper.
    const result = await runWorkflowScenarioCommand(["--fixture", fixture])

    // Then: the transcript exposes fix worktree, push, MR, and cleanup outcomes.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("worker worktree opens: 1")
    expect(result.stdout).toContain("push calls: 1")
    expect(result.stdout).toContain("MR calls: 1")
    expect(result.stdout).toContain("worker worktree cleanup calls: 1")
  })

  it("rejects dirty analysis before runner execution", async () => {
    // Given: a dirty analysis fixture.
    const fixture = writeScenarioFixture(
      "dirty-analysis",
      `
name: dirty-analysis
incident:
  channelId: C_SCENARIO
  issueId: SENTRY-DIRTY
  repoId: demo-repo
  repoPath: /tmp/demo-repo
  threadTs: "1719356400.000000"
  title: Dirty analysis fixture
actions:
  - analyze
runner:
  analysisSummary: Root cause from fixture.
  dirtyAnalysis: true
`,
    )

    // When: the scenario command runs through the CLI surface helper.
    const result = await runWorkflowScenarioCommand(["--fixture", fixture])

    // Then: the failure is visible and no runner call is made.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("runner executions: 0")
    expect(result.stdout).toContain("workflow failed: yes")
    expect(result.stdout).toContain("source repository is dirty before analysis")
  })
})
