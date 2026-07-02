import { describe, expect, it } from "vitest"

import { SlackActionIds } from "../../src/slack/action-payload.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { readSavedIncidentHandoffs, readSavedMrLinks } from "./incident-workflow-db-support.js"
import {
  RecordingMergeRequestProvider,
  RecordingRunner,
  runnerResult,
} from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

describe("incident workflow handoff and merge request persistence", () => {
  it("runs approved fix through verification, push, mr creation, handoff persistence, and result posting", async () => {
    // Given: an analyzed incident and a passing fix result.
    const runner = new RecordingRunner([
      runnerResult({ mode: "analysis_only" }),
      runnerResult({
        mode: "fix_and_mr",
        mrReadiness: "Ready for review.",
        verificationResults: "passed",
      }),
    ])
    const { dbPath, mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)
    await workflow.handleSlackAction(slackAction("analyze_requested", SlackActionIds.analyze))
    let handoffExistedBeforeCleanup = false
    repo.onClose = () => {
      handoffExistedBeforeCleanup = true
      expect(store.getIncidentHandoffByIssueId("SENTRY-10")).toMatchObject({
        analysisSummary: "Root cause: checkout crash in payment handler.",
        changesSummary: "Patched null guard.",
        headSha: repo.headSha,
        issueId: "SENTRY-10",
        mrReadiness: "Ready for review.",
        mrUrl: "https://gitlab.example/incidents/merge_requests/7",
        provider: "gitlab",
        repoId: "repo-api",
        repoPath: "/allowed/repo-api",
        sourceBranch: "incident/SENTRY-10",
        targetBranch: "main",
        verificationSummary: "passed",
      })
    }

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAfterAnalysis))

    // Then: verification precedes push/MR and Slack receives the persisted GitLab MR link.
    expect(runner.calls.map((call) => call.mode)).toEqual(["analysis_only", "fix_and_mr"])
    expect(JSON.stringify(slack.messages)).toContain("수정 작업을 시작했습니다")
    expect(repo.pushRequests).toHaveLength(1)
    const session = repo.sessions[0]
    if (session === undefined) {
      throw new Error("expected opened worktree session")
    }
    expect(handoffExistedBeforeCleanup).toBe(true)
    expect(session.closeCalls).toBe(1)
    expect(repo.currentHeadRequests).toEqual([{ repoPath: session.worktreePath }])
    expect(mrProvider.calls).toHaveLength(1)
    expect(JSON.stringify(slack.messages.at(-1)?.blocks)).toContain(
      "https://gitlab.example/incidents/merge_requests/7",
    )
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("## 요약\n\n")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("## 변경 사항\n\n")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("## 검증\n\n")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("## 위험 및 롤백\n\n")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("- Incident: `SENTRY-10`")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("- Patched null guard.")
    expect(mrProvider.calls[0]?.bodyTemplate).toContain("- passed")
    expect(readSavedMrLinks(dbPath)).toEqual([
      {
        provider: "gitlab",
        url: "https://gitlab.example/incidents/merge_requests/7",
      },
    ])
    expect(readSavedIncidentHandoffs(dbPath)).toEqual([
      expect.objectContaining({
        analysisSummary: "Root cause: checkout crash in payment handler.",
        changesSummary: "Patched null guard.",
        headSha: repo.headSha,
        issueId: "SENTRY-10",
        mrReadiness: "Ready for review.",
        mrUrl: "https://gitlab.example/incidents/merge_requests/7",
        provider: "gitlab",
        repoId: "repo-api",
        repoPath: "/allowed/repo-api",
        sourceBranch: "incident/SENTRY-10",
        targetBranch: "main",
        verificationSummary: "passed",
      }),
    ])
    store.close()
    const reopened = openSqliteStateStore({ path: dbPath })
    const readable = reopened.getIncidentHandoffByIssueId("SENTRY-10")
    reopened.close()
    expect(readable).toMatchObject({
      analysisSummary: "Root cause: checkout crash in payment handler.",
      changesSummary: "Patched null guard.",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      followUpPrompt: expect.stringContaining("Continue incident SENTRY-10"),
      headSha: repo.headSha,
      issueId: "SENTRY-10",
      mrReadiness: "Ready for review.",
      mrUrl: "https://gitlab.example/incidents/merge_requests/7",
      provider: "gitlab",
      repoId: "repo-api",
      repoPath: "/allowed/repo-api",
      sourceBranch: "incident/SENTRY-10",
      targetBranch: "main",
      verificationSummary: "passed",
    })
  })

  it("redacts configured secret values before serializing workflow handoff summaries", async () => {
    // Given: a successful fix result includes secret-like text from untrusted runner output.
    const secretValue = "runner-secret-value"
    const runner = new RecordingRunner([
      runnerResult({
        analysis: `Root cause leaked ${secretValue}.`,
        changesSummary: "Patched with xoxb-live-token.",
        mode: "fix_and_mr",
        mrReadiness: `Ready but ${secretValue} appeared.`,
        verificationResults: "passed with sntrys_live_token",
      }),
    ])
    const { store, workflow } = createWorkflow(runner, {
      sentryContextSecretValues: [secretValue],
    })
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves the fix and the handoff is persisted.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the serialized handoff contains redaction markers and omits raw secrets.
    const handoff = store.getIncidentHandoffByIssueId("SENTRY-10")
    const serialized = JSON.stringify(handoff)
    expect(handoff).toMatchObject({
      analysisSummary: "Root cause leaked [REDACTED].",
      changesSummary: "Patched with [REDACTED].",
      mrReadiness: "Ready but [REDACTED] appeared.",
      verificationSummary: "passed with [REDACTED]",
    })
    expect(serialized).toContain("[REDACTED]")
    expect(serialized).not.toContain(secretValue)
    expect(serialized).not.toContain("xoxb-live-token")
    expect(serialized).not.toContain("sntrys_live_token")
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
    expect(slackOutput).toContain("브랜치 push 이후 MR 생성에 실패했습니다")
    expect(slackOutput).toContain("incident/SENTRY-10")
    expect(slackOutput).not.toContain("https://gitlab.example/incidents/merge_requests/7")
    store.close()
  })

  it("retains the worktree when current head fails after provider returns an MR URL", async () => {
    // Given: provider publication succeeds but reading the local head fails before handoff save.
    const secretValue = "plain retained durability secret"
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { dbPath, mrProvider, repo, slack, store, workflow } = createWorkflow(runner, {
      sentryContextSecretValues: [secretValue],
    })
    repo.currentHeadFailure = new Error(`rev-parse HEAD failed ${secretValue}`)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the workflow fails without deleting the only recoverable worker context.
    const session = repo.sessions.at(-1)
    const slackOutput = JSON.stringify(slack.messages.at(-1))
    const mrFailedAudit = store
      .listAuditEntries()
      .find((entry) => entry.action === "workflow.mr_failed_after_push")
    expect(mrProvider.calls).toHaveLength(1)
    expect(readSavedMrLinks(dbPath)).toEqual([])
    expect(readSavedIncidentHandoffs(dbPath)).toEqual([])
    expect(store.getIncidentByIssueId("SENTRY-10")?.workflowState).toBe("mr_failed_after_push")
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain(
      "workflow.mr_failed_after_push",
    )
    expect(slackOutput).toContain("cleanup skipped")
    expect(slackOutput).toContain("incident/SENTRY-10")
    expect(slackOutput).toContain("https://gitlab.example/incidents/merge_requests/7")
    expect(slackOutput).toContain("rev-parse HEAD failed")
    expect(slackOutput).not.toContain(secretValue)
    expect(mrFailedAudit?.details).toContain("incident/SENTRY-10")
    expect(mrFailedAudit?.details).toContain("https://gitlab.example/incidents/merge_requests/7")
    expect(mrFailedAudit?.details).not.toContain(secretValue)
    expect(session?.closeCalls).toBe(0)
    store.close()
  })

  it("retains the worktree when handoff save fails after MR link persistence", async () => {
    // Given: provider publication and MR link persistence succeed but handoff save fails.
    const runner = new RecordingRunner([runnerResult({ mode: "fix_and_mr" })])
    const { dbPath, mrProvider, repo, slack, store, workflow } = createWorkflow(runner)
    store.saveIncidentHandoff = () => {
      throw new Error("handoff insert failed")
    }
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: the persisted MR link is recoverable and cleanup is skipped because handoff is absent.
    const session = repo.sessions.at(-1)
    const slackOutput = JSON.stringify(slack.messages.at(-1))
    expect(mrProvider.calls).toHaveLength(1)
    expect(readSavedMrLinks(dbPath)).toEqual([
      {
        provider: "gitlab",
        url: "https://gitlab.example/incidents/merge_requests/7",
      },
    ])
    expect(readSavedIncidentHandoffs(dbPath)).toEqual([])
    expect(store.listAuditEntries().map((entry) => entry.action)).toContain(
      "workflow.mr_failed_after_push",
    )
    expect(slackOutput).toContain("cleanup skipped")
    expect(slackOutput).toContain("handoff insert failed")
    expect(slackOutput).toContain("https://gitlab.example/incidents/merge_requests/7")
    expect(session?.closeCalls).toBe(0)
    store.close()
  })
})
