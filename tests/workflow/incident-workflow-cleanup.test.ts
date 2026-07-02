import { describe, expect, it } from "vitest"

import type { RunnerRequest, RunnerResult } from "../../src/runner/types.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { readSavedMrLinks } from "./incident-workflow-db-support.js"
import { RecordingPreparer, RecordingRunner, runnerResult } from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

class FailingRunner {
  public readonly calls: RunnerRequest[] = []

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request)
    throw new Error("runner failed")
  }
}

describe("incident workflow fix cleanup", () => {
  it("closes the fix worktree after MR link persistence and Slack success", async () => {
    // Given: a fix workflow whose push and MR creation succeed.
    const runner = new RecordingRunner([
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { dbPath, mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    let closeObservedAfterSuccess = false
    repo.onClose = () => {
      closeObservedAfterSuccess =
        readSavedMrLinks(dbPath).some(
          (link) => link.provider === mrProvider.provider && link.url === mrProvider.url,
        ) && JSON.stringify(slack.messages.at(-1)?.blocks).includes(mrProvider.url)
    }
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix and MR creation completes.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: persisted MR success is visible when the worker worktree cleanup runs.
    expect(repo.pushRequests).toHaveLength(1)
    expect(mrProvider.calls).toHaveLength(1)
    expect(readSavedMrLinks(dbPath)).toEqual([
      {
        provider: "gitlab",
        url: "https://gitlab.example/incidents/merge_requests/7",
      },
    ])
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "https://gitlab.example/incidents/merge_requests/7",
    )
    expect(closeObservedAfterSuccess).toBe(true)
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    store.close()
  })

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

  it("prepares the fix worktree before starting the runner", async () => {
    // Given: a fix workflow with a configured worktree preparation step.
    const preparer = new RecordingPreparer()
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { repo, store, workflow } = createWorkflow(runner, { worktreePreparer: preparer })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: preparation sees the opened session before the runner receives the request.
    expect(preparer.calls).toHaveLength(1)
    expect(preparer.calls[0]?.session.worktreePath).toBe(repo.sessions[0]?.worktreePath)
    expect(runner.calls).toHaveLength(1)
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    store.close()
  })

  it("fails before runner execution when worktree preparation fails", async () => {
    // Given: dependency bootstrap fails in the opened worktree.
    const preparer = new RecordingPreparer()
    preparer.failure = new Error("pnpm install failed")
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { repo, store, workflow } = createWorkflow(runner, { worktreePreparer: preparer })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the runner is not started against an unprepared workspace.
    expect(preparer.calls).toHaveLength(1)
    expect(runner.calls).toHaveLength(0)
    expect(repo.sessions.at(-1)?.closeCalls).toBeGreaterThan(0)
    expect(repo.pushRequests).toHaveLength(0)
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
