import { describe, expect, it } from "vitest"

import { buildPromptEnvelope } from "../../src/runner/prompt.js"
import { SlackActionIds } from "../../src/slack/action-payload.js"
import { RecordingRunner, runnerResult } from "./incident-workflow-fakes.js"
import { createWorkflow, detectedIncident, slackAction } from "./incident-workflow-support.js"

const projectTemplateBody = `## 요약

- 프로젝트 MR 템플릿을 반영한 요약입니다.

## 검증

- passed: pnpm test

## 위험 및 롤백

- 위험 낮음. 문제가 있으면 revert합니다.`

describe("workflow merge request body", () => {
  it("uses the runner-authored project-aware MR markdown without rewriting it", async () => {
    // Given: a fix runner returns a complete MR body after reading project-local MR rules.
    const runner = new RecordingRunner([
      runnerResult({
        mergeRequestBody: projectTemplateBody,
        mode: "fix_and_mr",
        verificationResults: "passed: pnpm test",
      }),
    ])
    const { mrProvider, store, workflow } = createWorkflow(runner)
    await workflow.handleDetectedIncident(detectedIncident)

    // When: Slack approves the fix.
    await workflow.handleSlackAction(slackAction("fix_requested", SlackActionIds.fixAndMr))

    // Then: worker preserves the runner-authored Markdown as the provider body.
    expect(mrProvider.calls[0]?.bodyTemplate).toBe(projectTemplateBody)
    store.close()
  })

  it("tells fix runners to inspect project-local MR rules before returning mergeRequestBody", () => {
    // Given: a fix runner request is converted into an agent prompt.
    const request = {
      incidentContext: {
        issueId: "SENTRY-MR-DOCS",
        trustBoundary: "untrusted_external_sentry",
      },
      mode: "fix_and_mr",
      repositoryConstraints: "Use only this workspace.",
      workspacePath: "/tmp/workspace",
    } as const

    // When: the prompt envelope is built.
    const prompt = buildPromptEnvelope(request)

    // Then: project MR instructions and the structured MR body field are part of the contract.
    expect(prompt).toContain("mergeRequestBody")
    expect(prompt).toContain(".gitlab/merge_request_templates")
    expect(prompt).toContain("AGENTS.md")
  })
})
