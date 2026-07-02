import { describe, expect, it } from "vitest"

import type { RunnerRequest, RunnerResult } from "../../src/runner/types.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { RecordingRunner, runnerResult } from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

const createDeferred = (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} => {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

class BlockingRunner {
  public readonly calls: RunnerRequest[] = []
  readonly #blocked = createDeferred()
  readonly #firstCall = createDeferred()
  readonly #result: RunnerResult

  public constructor(result: RunnerResult) {
    this.#result = result
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request)
    if (this.calls.length === 1) {
      this.#firstCall.resolve()
    }
    await this.#blocked.promise
    return this.#result
  }

  public async waitForFirstCall(): Promise<void> {
    await this.#firstCall.promise
  }

  public release(): void {
    this.#blocked.resolve()
  }
}

describe("incident workflow concurrency and recovery", () => {
  it("deduplicates duplicate Slack actions while the first action is still running", async () => {
    // Given: an analysis action whose runner is blocked in-flight.
    const runner = new BlockingRunner(runnerResult({ mode: "analysis_only" }))
    const { repo, slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)
    const intent = slackAction("analyze_requested", SlackActionIds.analyze)

    // When: the same Slack action is submitted twice before the first runner completes.
    const firstAction = workflow.handleSlackAction(intent)
    const duplicateAction = workflow.handleSlackAction(intent)
    await runner.waitForFirstCall()
    runner.release()
    const results = await Promise.allSettled([firstAction, duplicateAction])

    // Then: only the original action performs side effects and the duplicate gets status.
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    expect(runner.calls).toHaveLength(1)
    expect(repo.openRequests).toHaveLength(0)
    expect(store.listAuditEntries().filter((entry) => entry.action === "job.claimed")).toHaveLength(
      1,
    )
    expect(
      slack.messages.filter((message) => JSON.stringify(message.blocks).includes("Root cause")),
    ).toHaveLength(1)
    expect(
      slack.messages.filter((message) => message.text.includes("이미 진행 중인 작업입니다")),
    ).toHaveLength(1)
    store.close()
  })

  it("safely rejects a distinct Slack action while another job is active", async () => {
    // Given: an analysis action whose runner is blocked in-flight.
    const runner = new BlockingRunner(runnerResult({ mode: "analysis_only" }))
    const { mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: a distinct fix action is submitted before analysis completes.
    const analysisAction = workflow.handleSlackAction(
      slackAction("analyze_requested", SlackActionIds.analyze),
    )
    await runner.waitForFirstCall()
    const staleFixResult = await Promise.allSettled([
      workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr)),
    ])
    runner.release()
    await analysisAction

    // Then: the stale action is handled safely without second runner, push, or MR side effects.
    expect(staleFixResult.map((result) => result.status)).toEqual(["fulfilled"])
    expect(runner.calls).toHaveLength(1)
    expect(repo.openRequests).toHaveLength(0)
    expect(repo.pushRequests).toHaveLength(0)
    expect(mrProvider.calls).toHaveLength(0)
    expect(
      slack.messages.filter((message) =>
        message.text.includes("이미 이 incident의 작업이 진행 중입니다"),
      ),
    ).toHaveLength(1)
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain("job.rejected_active")
    store.close()
  })

  it("stops before push when verification fails", async () => {
    // Given: a fix runner that reports verification failure.
    const runner = new RecordingRunner([
      runnerResult({ mode: "fix_and_mr", verificationResults: "failed" }),
    ])
    const { mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves direct fix from the initial buttons.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: no push/MR occurs and Slack receives a safe failure.
    expect(repo.pushRequests).toHaveLength(0)
    expect(mrProvider.calls).toHaveLength(0)
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain("verification failed")
    store.close()
  })

  it("stores branch metadata and safe recovery summary when MR fails after push", async () => {
    // Given: push succeeds but MR creation fails.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    mrProvider.failure = new Error("GitLab unavailable glpat-secret")
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: pushed branch metadata is stored safely and posted for recovery.
    expect(repo.pushRequests).toHaveLength(1)
    const auditDetails = store
      .listAuditEntries()
      .map((entry) => entry.details)
      .join("\n")
    expect(auditDetails).toContain("mr_failed_after_push")
    expect(auditDetails).toContain("incident/SENTRY-10")
    expect(auditDetails).not.toContain("glpat-secret")
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "브랜치 push 이후 MR 생성에 실패했습니다",
    )
    store.close()
  })

  it("records cleanup failure without hiding the completed job result", async () => {
    // Given: a successful fix whose cleanup will fail after MR creation.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { repo, slack, store, workflow } = createWorkflow(runner)
    repo.cleanupFails = true
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the MR result is still posted and cleanup failure is audited separately.
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "https://gitlab.example/incidents/merge_requests/7",
    )
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain("cleanup_failed")
    store.close()
  })

  it("stores and posts the runner analysis field instead of transport stdout", async () => {
    // Given: analysis completes with a distinct structured summary and noisy runner stdout.
    const analysisSummary = "Parsed structured root cause from Codex last-message JSON."
    const runner = new RecordingRunner([
      runnerResult({
        analysis: analysisSummary,
        mode: "analysis_only",
        stdout: "codex transport stdout",
      }),
    ])
    const { slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: persistent state and Slack both expose the structured analysis summary only.
    const incident = store.getIncidentByIssueId("SENTRY-10")
    expect(incident).toBeDefined()
    const storedSummary =
      incident === undefined ? undefined : store.getLatestAnalysisSummary(incident.incidentId)
    const postedMessage = JSON.stringify(slack.messages.at(-1)?.blocks)
    expect(storedSummary?.summaryMarkdown).toBe(analysisSummary)
    expect(postedMessage).toContain(analysisSummary)
    expect(postedMessage).not.toContain("codex transport stdout")
    store.close()
  })

  it("posts safe errors and writes audit rows when workflow execution fails", async () => {
    // Given: opening a fix worktree fails with a sensitive message.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { repo, slack, store, workflow } = createWorkflow(runner)
    repo.openWorktree = async () => {
      throw new Error("boom xoxb-secret-token")
    }
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: Slack and audit output are redacted and no runner spawned.
    expect(runner.calls).toHaveLength(0)
    const safeOutput = JSON.stringify(slack.messages.at(-1)?.blocks)
    expect(safeOutput).toContain("[REDACTED]")
    expect(safeOutput).not.toContain("xoxb-secret-token")
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain("workflow.failed")
    store.close()
  })
})
