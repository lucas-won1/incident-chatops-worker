import { describe, expect, it } from "vitest"

import type { RunnerRequest, RunnerResult } from "../../src/runner/types.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { RecordingRunner, runnerResult } from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

class FailingRunner {
  public readonly calls: RunnerRequest[] = []

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request)
    throw new Error("runner failed")
  }
}

describe("incident workflow fix cleanup", () => {
  it("closes the fix worktree when the runner fails", async () => {
    // Given: a fix action whose runner fails after the worktree opens.
    const runner = new FailingRunner()
    const { repo, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the terminal failure still closes the worktree session.
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    expect(repo.pushRequests).toHaveLength(0)
    store.close()
  })

  it("closes the fix worktree when verification fails before push", async () => {
    // Given: a fix runner reports ambiguous, non-passing verification text.
    const runner = new RecordingRunner([
      runnerResult({ mode: "fix_and_mr", verificationResults: "verification skipped by operator" }),
    ])
    const { mrProvider, repo, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: no push/MR occurs and the worktree is closed.
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    expect(repo.pushRequests).toHaveLength(0)
    expect(mrProvider.calls).toHaveLength(0)
    store.close()
  })

  it("closes the fix worktree when push fails", async () => {
    // Given: verification passes but branch push fails.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { mrProvider, repo, store, workflow } = createWorkflow(runner)
    repo.pushFailure = new Error("push rejected")
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: MR creation is skipped and cleanup still runs.
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    expect(repo.pushRequests).toHaveLength(1)
    expect(mrProvider.calls).toHaveLength(0)
    store.close()
  })

  it("closes the fix worktree after MR failure while retaining branch recovery metadata", async () => {
    // Given: push succeeds but MR creation fails after branch publication.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { mrProvider, repo, store, workflow } = createWorkflow(runner)
    mrProvider.failure = new Error("GitLab unavailable")
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: branch recovery state is preserved and the local worktree session is closed.
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    expect(repo.pushRequests).toHaveLength(1)
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain(
      "workflow.mr_failed_after_push",
    )
    store.close()
  })
})
