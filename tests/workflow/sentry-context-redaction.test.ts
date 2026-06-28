import { describe, expect, it } from "vitest"

import { buildPromptEnvelope } from "../../src/runner/prompt.js"
import type { RunnerIncidentContext, RunnerRequest } from "../../src/runner/types.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { RecordingRunner, runnerResult } from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

const rawMarker = "sntrys_f4_context_marker"
const exactEnvFileSecret = "plain-env-file-secret-f4"
const redactedMarker = "[REDACTED]"

const sentryContextWithMarker = {
  events: [
    {
      culprit: "src/payment/checkout.ts",
      eventID: "event-10",
      message: `TypeError: payment failed with ${rawMarker}`,
      nested: {
        request: {
          headers: { authorization: `Bearer ${rawMarker}` },
        },
      },
      tags: [
        ["environment", "production"],
        ["api_key", rawMarker],
      ],
    },
  ],
  issueId: "SENTRY-10",
  title: `Checkout crash ${rawMarker}`,
  trustBoundary: "untrusted_external_sentry",
} satisfies RunnerIncidentContext

const requestText = (request: RunnerRequest): string =>
  `${JSON.stringify(request)}\n${buildPromptEnvelope(request)}`

describe("Sentry context redaction at the runner boundary", () => {
  it("redacts fetched Sentry context before approved analysis reaches runner requests and prompts", async () => {
    // Given: an approved analysis workflow whose fetched Sentry event contains a token marker.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async () => sentryContextWithMarker,
      },
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: the runner request, prompt, and persisted snapshot keep useful fields but mask tokens.
    const request = runner.calls[0]
    const incident = store.getIncidentByIssueId("SENTRY-10")
    const snapshot = store.getLatestSentryIssueSnapshot(incident?.incidentId ?? "")?.snapshotJson
    if (request === undefined || snapshot === undefined) {
      throw new Error("expected runner request and persisted Sentry snapshot")
    }
    const renderedRequest = requestText(request)
    expect(renderedRequest).not.toContain(rawMarker)
    expect(renderedRequest).toContain(redactedMarker)
    expect(renderedRequest).toContain("event-10")
    expect(renderedRequest).toContain("TypeError: payment failed")
    expect(renderedRequest).toContain("src/payment/checkout.ts")
    expect(snapshot).not.toContain(rawMarker)
    expect(snapshot).toContain(redactedMarker)
    store.close()
  })

  it("reuses redacted stored Sentry context for approved fix runner requests and prompts", async () => {
    // Given: analysis has fetched and stored Sentry context that contains a token marker.
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({ mode: "fix_and_mr", verificationResults: "passed" }),
    ])
    const { store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async () => sentryContextWithMarker,
      },
    })
    await workflow.handleDetectedIncident(detectedIncident)
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: the fix runner receives the stored redacted context, not the raw fetched marker.
    const fixRequest = runner.calls[1]
    if (fixRequest === undefined) {
      throw new Error("expected fix runner request")
    }
    const renderedRequest = requestText(fixRequest)
    expect(renderedRequest).not.toContain(rawMarker)
    expect(renderedRequest).toContain(redactedMarker)
    expect(renderedRequest).toContain("event-10")
    expect(renderedRequest).toContain("src/payment/checkout.ts")
    store.close()
  })

  it("redacts exact env-file secret values from fetched Sentry context before runner requests and snapshots", async () => {
    // Given: fetched Sentry context contains a non-token-shaped secret from daemon settings.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async () => ({
          events: [
            {
              culprit: "src/payment/checkout.ts",
              eventID: "event-exact-10",
              extra: { config: `dsn=${exactEnvFileSecret}` },
              message: `Payment failed with ${exactEnvFileSecret}`,
            },
          ],
          issueId: "SENTRY-10",
          title: `Checkout crash ${exactEnvFileSecret}`,
          trustBoundary: "untrusted_external_sentry",
        }),
      },
      sentryContextSecretValues: [exactEnvFileSecret],
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: exact secret values are masked while useful Sentry event fields remain available.
    const request = runner.calls[0]
    const incident = store.getIncidentByIssueId("SENTRY-10")
    const snapshot = store.getLatestSentryIssueSnapshot(incident?.incidentId ?? "")?.snapshotJson
    if (request === undefined || snapshot === undefined) {
      throw new Error("expected runner request and persisted Sentry snapshot")
    }
    const renderedRequest = requestText(request)
    expect(renderedRequest).not.toContain(exactEnvFileSecret)
    expect(renderedRequest).toContain(redactedMarker)
    expect(renderedRequest).toContain("event-exact-10")
    expect(renderedRequest).toContain("Payment failed with")
    expect(renderedRequest).toContain("src/payment/checkout.ts")
    expect(snapshot).not.toContain(exactEnvFileSecret)
    expect(snapshot).toContain(redactedMarker)
    expect(snapshot).toContain("event-exact-10")
    store.close()
  })

  it("redacts exact env-file secret values used as fetched Sentry object keys", async () => {
    // Given: fetched Sentry context contains a non-token-shaped secret as an object key.
    const runner = new RecordingRunner([runnerResult({ mode: "analysis_only" })])
    const { store, workflow } = createWorkflow(runner, {
      sentryContext: {
        fetchIssueContext: async () => ({
          events: [
            {
              [exactEnvFileSecret]: "retained diagnostic value",
              culprit: "src/payment/checkout.ts",
              eventID: "event-exact-key-10",
              message: "Payment failed with keyed diagnostic metadata",
            },
          ],
          issueId: "SENTRY-10",
          title: "Checkout crash keyed diagnostic",
          trustBoundary: "untrusted_external_sentry",
        }),
      },
      sentryContextSecretValues: [exactEnvFileSecret],
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves analysis.
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))

    // Then: key-position secrets are masked in the runner context, prompt, and persisted snapshot.
    const request = runner.calls[0]
    const incident = store.getIncidentByIssueId("SENTRY-10")
    const snapshot = store.getLatestSentryIssueSnapshot(incident?.incidentId ?? "")?.snapshotJson
    if (request === undefined || snapshot === undefined) {
      throw new Error("expected runner request and persisted Sentry snapshot")
    }
    const renderedRequest = requestText(request)
    expect(renderedRequest).not.toContain(exactEnvFileSecret)
    expect(renderedRequest).toContain(redactedMarker)
    expect(renderedRequest).toContain("retained diagnostic value")
    expect(renderedRequest).toContain("event-exact-key-10")
    expect(snapshot).not.toContain(exactEnvFileSecret)
    expect(snapshot).toContain(redactedMarker)
    expect(snapshot).toContain("retained diagnostic value")
    store.close()
  })
})
