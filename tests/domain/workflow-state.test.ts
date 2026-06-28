import { describe, expect, expectTypeOf, it } from "vitest"
import { createAnalysisOnlyJobRequest, createDetectedIncident } from "../../src/domain/incident.js"
import type { AnalysisOnlyJobRequest } from "../../src/domain/runner-mode.js"
import {
  completeAnalysis,
  InvalidWorkflowTransitionError,
  ignoreIncident,
  markFixClosed,
  markFixFailed,
  markMrCreated,
  requestAnalysis,
  requestFix,
  startAnalysis,
  startFix,
} from "../../src/domain/workflow-state.js"
import { parseSlackActionPayload } from "../../src/slack/action-payload.js"

describe("incident workflow states", () => {
  it("moves through every allowed state transition when approvals arrive", () => {
    // Given: a newly detected incident.
    const detected = createDetectedIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
    })

    // When: the approved analysis and fix flow progresses.
    const analysisRequested = requestAnalysis(detected)
    const analysisRunning = startAnalysis(analysisRequested)
    const analysisCompleted = completeAnalysis(analysisRunning)
    const fixRequested = requestFix(analysisCompleted)
    const fixRunning = startFix(fixRequested)

    // Then: terminal fix outcomes are explicit workflow variants.
    expect(markMrCreated(fixRunning).kind).toBe("mr_created")
    expect(markFixFailed(fixRunning, "verification_failed").kind).toBe("failed")
    expect(markFixClosed(fixRunning).kind).toBe("closed")
  })

  it("moves detected incidents directly to ignored when the ignore action is approved", () => {
    // Given: a newly detected incident.
    const detected = createDetectedIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
    })

    // When: the human chooses ignore.
    const ignored = ignoreIncident(detected)

    // Then: the state records an ignored terminal variant.
    expect(ignored.kind).toBe("ignored")
  })

  it("throws a typed error when a transition skips required states", () => {
    // Given: a newly detected incident.
    const detected = createDetectedIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
    })

    // When: code tries to start analysis before it was requested.
    const transition = (): unknown => startAnalysis(detected)

    // Then: the failure is typed and names both states.
    expect(transition).toThrow(InvalidWorkflowTransitionError)
    expect(transition).toThrow("detected -> analysis_running")
  })

  it.each([
    { actionId: "incident.analyze", expectedKind: "analyze_requested" },
    { actionId: "incident.fix_mr", expectedKind: "fix_requested" },
    { actionId: "incident.fix_after_analysis", expectedKind: "fix_requested" },
    { actionId: "incident.ignore", expectedKind: "ignored" },
    { actionId: "incident.close", expectedKind: "closed" },
  ] as const)("parses Slack action ID $actionId into $expectedKind workflow intent", (testCase) => {
    // Given: a Slack block action payload for a registered workflow button.
    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "1712345678.000100" },
      actions: [
        {
          action_id: testCase.actionId,
          value: JSON.stringify({ issueId: "SENTRY-123", repoId: "repo-api" }),
        },
      ],
    }

    // When: the boundary parser handles the payload.
    const intent = parseSlackActionPayload(payload)

    // Then: the intent is ready for the workflow API without stringly action checks.
    expect(intent).toEqual({
      kind: testCase.expectedKind,
      actionId: testCase.actionId,
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channel: { id: "C123" },
      thread: { channelId: "C123", threadTs: "1712345678.000100" },
      actor: { slackUserId: "U123" },
    })
  })

  it("rejects unknown Slack action IDs with a typed validation error", () => {
    // Given: a Slack block action payload for an unregistered button.
    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "1712345678.000100" },
      actions: [
        {
          action_id: "incident.launch_missiles",
          value: JSON.stringify({ issueId: "SENTRY-123", repoId: "repo-api" }),
        },
      ],
    }

    // When: the boundary parser handles the payload.
    const parse = (): unknown => parseSlackActionPayload(payload)

    // Then: the typed error names the bad action without dumping payload text.
    expect(parse).toThrow("Unknown Slack action_id: incident.launch_missiles")
    expect(parse).not.toThrow("SENTRY-123")
  })

  it("does not expose commit, push, or merge request fields for analysis-only jobs", () => {
    // Given: an analysis-only job request.
    const detected = createDetectedIncident({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
    })

    // When: the job request is created through the analysis-only API.
    const request = createAnalysisOnlyJobRequest(detected)

    // Then: the runtime and static shape cannot carry mutation requests.
    expect(request).toEqual({
      kind: "analysis_job_requested",
      mode: { kind: "analysis_only" },
      issueId: "SENTRY-123",
      repoId: "repo-api",
    })
    expectTypeOf<AnalysisOnlyJobRequest>().not.toHaveProperty("commit")
    expectTypeOf<AnalysisOnlyJobRequest>().not.toHaveProperty("push")
    expectTypeOf<AnalysisOnlyJobRequest>().not.toHaveProperty("mergeRequest")
  })
})
