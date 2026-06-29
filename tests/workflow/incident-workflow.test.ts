import { describe, expect, it } from "vitest"

import { buildPromptEnvelope } from "../../src/runner/prompt.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import {
  RecordingMergeRequestProvider,
  RecordingRunner,
  runnerResult,
} from "./incident-workflow-fakes.js"
import {
  createWorkflow,
  detailedSentryContext,
  detectedIncident,
  readSavedMrLinks,
  slackAction,
} from "./incident-workflow-support.js"

const onlyRunnerRequest = (runner: RecordingRunner) => {
  const request = runner.calls[0]
  if (request === undefined) {
    throw new Error("expected one runner call")
  }
  return request
}

describe("approval-gated incident workflow", () => {
  it("posts initial Slack buttons when a detected Sentry issue is new", async () => {
    // Given: a workflow with empty state.
    const { slack, store, workflow } = createWorkflow(new RecordingRunner([]))

    // When: Sentry polling detects a new issue.
    await workflow.handleDetectedIncident(detectedIncident)

    // Then: Slack receives the approval-gated initial buttons.
    expect(store.getIncidentByIssueId("SENTRY-10")?.workflowState).toBe("detected")
    expect(slack.messages).toHaveLength(1)
    expect(JSON.stringify(slack.messages[0]?.blocks)).toContain("분석하기")
    expect(JSON.stringify(slack.messages[0]?.blocks)).toContain("수정해서 MR")
    expect(JSON.stringify(slack.messages[0]?.blocks)).toContain("무시")
    store.close()
  })

  it("runs analysis after approval and posts the summary with second approval buttons", async () => {
    // Given: an incident and an analysis runner result.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: analysis is stored and Slack includes the summary plus [수정하기] [닫기].
    const incident = store.getIncidentByIssueId("SENTRY-10")
    expect(runner.calls).toHaveLength(1)
    expect(store.getLatestAnalysisSummary(incident?.incidentId ?? "")?.summaryMarkdown).toContain(
      "Root cause",
    )
    const renderedBlocks = JSON.stringify(slack.messages.at(-1)?.blocks)
    expect(renderedBlocks).toContain("Root cause")
    expect(renderedBlocks).toContain("수정하기")
    expect(renderedBlocks).toContain("닫기")
    store.close()
  })

  it("passes fetched Sentry event context to the approved analysis runner", async () => {
    // Given: an approved analysis workflow with an on-demand Sentry context provider.
    const fetchedIssueIds: string[] = []
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { store, workflow } = createWorkflow(runner, {
      allowedRunnerCommands: ["pnpm test", "pnpm build"],
      sentryContext: {
        fetchIssueContext: async (incident) => {
          fetchedIssueIds.push(incident.issueId)
          return detailedSentryContext
        },
      },
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: the runner request and prompt include rich event details and configured commands.
    const request = onlyRunnerRequest(runner)
    const incident = store.getIncidentByIssueId("SENTRY-10")
    expect(fetchedIssueIds).toEqual(["SENTRY-10"])
    expect(request?.incidentContext.events?.[0]).toMatchObject({
      culprit: "src/payment/checkout.ts",
      eventID: "event-10",
      message: "TypeError: Cannot read properties of undefined",
      tags: expect.arrayContaining([["environment", "production"]]),
    })
    expect(request?.allowedCommands).toEqual(["pnpm test", "pnpm build"])
    expect(buildPromptEnvelope(request)).toContain("pnpm test\npnpm build")
    expect(buildPromptEnvelope(request)).not.toContain("No commands declared.")
    expect(store.getLatestSentryIssueSnapshot(incident?.incidentId ?? "")?.snapshotJson).toContain(
      "event-10",
    )
    store.close()
  })

  it("runs approved fix through verification, push, mr creation, persistence, and result posting", async () => {
    // Given: an analyzed incident and a passing fix result.
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { dbPath, mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: verification precedes push/MR and Slack receives the persisted GitLab MR link.
    expect(runner.calls.map((call) => call.mode)).toEqual(["analysis_only", "fix_and_mr"])
    expect(repo.pushRequests).toHaveLength(1)
    expect(mrProvider.calls).toHaveLength(1)
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "https://gitlab.example/incidents/merge_requests/7",
    )
    expect(readSavedMrLinks(dbPath)).toEqual([
      {
        provider: "gitlab",
        url: "https://gitlab.example/incidents/merge_requests/7",
      },
    ])
    store.close()
  })

  it("creates a github mr/pr through the provider contract and posts the pull request url", async () => {
    // Given: a workflow using a provider implementation that identifies as GitHub.
    const mrProvider = new RecordingMergeRequestProvider("github")
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { dbPath, slack, store, workflow } = createWorkflow(runner, { mrProvider })
    await workflow.handleDetectedIncident(detectedIncident)
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // When: Slack approves the fix and MR/PR creation completes.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: persisted MR link metadata and Slack success text use the selected GitHub provider.
    expect(readSavedMrLinks(dbPath)).toEqual([
      {
        provider: "github",
        url: "https://github.example/incidents/pull/7",
      },
    ])
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "https://github.example/incidents/pull/7",
    )
    store.close()
  })

  it("marks mr creation failed after push while retaining branch recovery metadata", async () => {
    // Given: push succeeds but the selected provider rejects MR/PR creation after publication.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    mrProvider.failure = new Error("provider unavailable")
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the branch remains available for retry and no misleading MR success is posted.
    const slackOutput = JSON.stringify(slack.messages.at(-1))
    expect(repo.pushRequests).toHaveLength(1)
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain(
      "workflow.mr_failed_after_push",
    )
    expect(store.getIncidentByIssueId("SENTRY-10")?.workflowState).toBe("mr_failed_after_push")
    expect(slackOutput).toContain("MR creation failed after push")
    expect(slackOutput).toContain("incident/SENTRY-10")
    expect(slackOutput).not.toContain("https://gitlab.example/incidents/merge_requests/7")
    store.close()
  })

  it("passes stored Sentry event context to the approved fix runner", async () => {
    // Given: analysis has fetched and stored detailed Sentry context for the incident.
    const fetchedIssueIds: string[] = []
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async (incident) => {
          fetchedIssueIds.push(incident.issueId)
          return detailedSentryContext
        },
      },
    })
    await workflow.handleDetectedIncident(detectedIncident)
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: both approved runner calls receive the same detailed event context.
    expect(fetchedIssueIds).toEqual(["SENTRY-10"])
    expect(runner.calls.map((call) => call.incidentContext.events?.[0])).toEqual([
      expect.objectContaining({ eventID: "event-10", culprit: "src/payment/checkout.ts" }),
      expect.objectContaining({ eventID: "event-10", culprit: "src/payment/checkout.ts" }),
    ])
    store.close()
  })

  it("fails closed before runner execution when Sentry context fetch fails", async () => {
    // Given: an approved analysis workflow whose Sentry context fetch fails with secret text.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { slack, store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async () => {
          throw new Error("Sentry failed with sntrys_secret_example")
        },
      },
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: no runner executes, workflow fails safely, and user-visible text omits secrets.
    expect(runner.calls).toHaveLength(0)
    expect(store.getIncidentByIssueId("SENTRY-10")?.workflowState).toBe("failed")
    expect(JSON.stringify(slack.messages.at(-1))).toContain("Sentry issue context fetch failed")
    expect(JSON.stringify(slack.messages.at(-1))).not.toContain("sntrys_secret_example")
    store.close()
  })

  it("stops ignore and close flows without runner execution", async () => {
    // Given: a detected incident.
    const runner = new RecordingRunner([])
    const { store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack ignores and then closes duplicate poll state.
    await workflow.handleSlackAction(slackAction("ignored", SlackActionIds.ignore))
    await workflow.handleDetectedIncident({
      ...detectedIncident,
      lastSeenAt: "2026-06-26T00:02:00.000Z",
    })
    await workflow.handleSlackAction(slackAction("closed", SlackActionIds.close))

    // Then: no runner job starts.
    expect(runner.calls).toHaveLength(0)
    expect(store.getIncidentByIssueId("SENTRY-10")?.workflowState).toBe("closed")
    store.close()
  })

  it("deduplicates duplicate Slack actions and poll/action races by Sentry issue identity", async () => {
    // Given: the action arrives before a polling upsert and is submitted twice.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { slack, store, workflow } = createWorkflow(runner)

    // When: duplicate analyze actions race with a later Sentry poll for the same issue.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))
    await workflow.handleDetectedIncident(detectedIncident)

    // Then: one incident/job/runner execution exists and both actions get safe Slack responses.
    expect(runner.calls).toHaveLength(1)
    expect(store.getIncidentByIssueId("SENTRY-10")?.incidentId).toMatch(/^incident_/u)
    expect(
      slack.messages.filter((message) => message.text.includes("already handled")),
    ).toHaveLength(1)
    store.close()
  })
})
