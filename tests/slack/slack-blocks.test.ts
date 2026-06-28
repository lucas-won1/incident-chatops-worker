import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { SlackActionIds, SlackActionPayloadError } from "../../src/slack/action-payload.js"
import {
  buildAnalysisCompleteMessage,
  buildInitialIncidentMessage,
  handleSlackBlockAction,
} from "../../src/slack/index.js"

const actionLabelsFromBlocks = (blocks: readonly unknown[]): readonly string[] =>
  blocks
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "elements" in block &&
      Array.isArray(block.elements)
        ? block.elements
        : [],
    )
    .map((element) =>
      typeof element === "object" &&
      element !== null &&
      "text" in element &&
      typeof element.text === "object" &&
      element.text !== null &&
      "text" in element.text
        ? element.text.text
        : undefined,
    )
    .filter((label): label is string => typeof label === "string")

const actionIdsFromBlocks = (blocks: readonly unknown[]): readonly string[] =>
  blocks
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "elements" in block &&
      Array.isArray(block.elements)
        ? block.elements
        : [],
    )
    .map((element) =>
      typeof element === "object" &&
      element !== null &&
      "action_id" in element &&
      typeof element.action_id === "string"
        ? element.action_id
        : undefined,
    )
    .filter((actionId): actionId is string => typeof actionId === "string")

const readJsonFixture = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

describe("Slack Block Kit contracts", () => {
  it("renders initial incident buttons with exact Korean labels and safe incident text", () => {
    // Given: an incident detected from an untrusted Sentry payload.
    const message = buildInitialIncidentMessage({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      title: "Checkout failed xoxb-secret-token",
      culprit: "api.checkout sntrys_abc123",
      permalink: "https://sentry.example.invalid/issues/123",
    })

    // When: the Slack message is rendered.
    const labels = actionLabelsFromBlocks(message.blocks)
    const actionIds = actionIdsFromBlocks(message.blocks)
    const serialized = JSON.stringify(message)

    // Then: all initial actions are present and secrets are redacted before Slack output.
    expect(message.channel).toBe("C123")
    expect(message.threadTs).toBe("1712345678.000100")
    expect(message.text).toContain("Checkout failed")
    expect(labels).toEqual(["분석하기", "수정해서 MR", "무시"])
    expect(actionIds).toEqual([
      SlackActionIds.analyze,
      SlackActionIds.fixAndMr,
      SlackActionIds.ignore,
    ])
    expect(serialized).toContain("[REDACTED]")
    expect(serialized).not.toContain("xoxb-secret-token")
    expect(serialized).not.toContain("sntrys_abc123")
  })

  it("renders analysis summary before fix and close buttons in the incident thread", () => {
    // Given: a completed analysis summary containing untrusted text.
    const message = buildAnalysisCompleteMessage({
      issueId: "SENTRY-123",
      repoId: "repo-api",
      channelId: "C123",
      threadTs: "1712345678.000100",
      summaryMarkdown: "원인: checkout null id\n권장: guard 추가\nleaked glpat-secret",
    })

    // When: the Slack update is rendered.
    const labels = actionLabelsFromBlocks(message.blocks)
    const serialized = JSON.stringify(message)
    const summaryIndex = serialized.indexOf("원인: checkout null id")
    const fixIndex = serialized.indexOf("수정하기")
    const closeIndex = serialized.indexOf("닫기")

    // Then: the summary leads the message and the follow-up actions are exact.
    expect(message.channel).toBe("C123")
    expect(message.threadTs).toBe("1712345678.000100")
    expect(labels).toEqual(["수정하기", "닫기"])
    expect(actionIdsFromBlocks(message.blocks)).toEqual([
      SlackActionIds.fixAfterAnalysis,
      SlackActionIds.close,
    ])
    expect(summaryIndex).toBeGreaterThanOrEqual(0)
    expect(summaryIndex).toBeLessThan(fixIndex)
    expect(summaryIndex).toBeLessThan(closeIndex)
    expect(serialized).toContain("[REDACTED]")
    expect(serialized).not.toContain("glpat-secret")
  })

  it("acks block actions before dispatching parsed domain intents", async () => {
    // Given: a valid Slack block action payload and injectable action dispatcher.
    const calls: string[] = []
    const payload = readJsonFixture("tests/fixtures/slack-action-analyze.json")

    // When: the adapter handles the action.
    const intent = await handleSlackBlockAction({
      payload,
      ack: () => {
        calls.push("ack")
      },
      dispatch: (parsedIntent) => {
        calls.push(`dispatch:${parsedIntent.kind}`)
      },
    })

    // Then: the Slack acknowledgement is immediate and the domain intent is dispatched.
    expect(intent.kind).toBe("analyze_requested")
    expect(calls).toEqual(["ack", "dispatch:analyze_requested"])
  })

  it("rejects malformed Slack action values without dumping the untrusted payload", async () => {
    // Given: a block_actions fixture whose button is missing value.
    const payload = readJsonFixture("tests/fixtures/slack-action-missing-value.json")

    // When: the adapter parses the payload after acking Slack.
    const parse = (): Promise<unknown> =>
      handleSlackBlockAction({
        payload,
        ack: () => undefined,
        dispatch: () => undefined,
      })

    // Then: the validation error is typed and concise.
    await expect(parse).rejects.toThrow(SlackActionPayloadError)
    await expect(parse).rejects.toThrow("Invalid Slack action payload")
    await expect(parse).rejects.not.toThrow("do not reveal this payload text")
  })
})
