import { z } from "zod"

import {
  type RepoId,
  repoId,
  type SentryIssueId,
  type SlackChannelId,
  type SlackThreadTs,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
} from "../domain/ids.js"
import { redactAndTruncate, redactSensitiveText } from "../shared/redaction.js"
import { type SlackActionId, SlackActionIds } from "./action-payload.js"

type SlackTextObject = {
  readonly type: "plain_text" | "mrkdwn"
  readonly text: string
  readonly emoji?: boolean
}

type SlackSectionBlock = {
  readonly type: "section"
  readonly text: SlackTextObject
}

type SlackButtonElement = {
  readonly type: "button"
  readonly text: SlackTextObject
  readonly action_id: SlackActionId
  readonly value: string
  readonly style?: "primary" | "danger"
}

type SlackActionsBlock = {
  readonly type: "actions"
  readonly elements: readonly SlackButtonElement[]
}

export type SlackMessageBlock = SlackSectionBlock | SlackActionsBlock

export type SlackRenderedMessage = {
  readonly channel: SlackChannelId
  readonly threadTs: SlackThreadTs
  readonly text: string
  readonly blocks: readonly SlackMessageBlock[]
}

export type InitialIncidentMessageInput = {
  readonly issueId: string
  readonly repoId: string
  readonly channelId: string
  readonly threadTs: string
  readonly title: string
  readonly culprit?: string
  readonly permalink?: string
}

export type AnalysisCompleteMessageInput = {
  readonly issueId: string
  readonly repoId: string
  readonly channelId: string
  readonly threadTs: string
  readonly summaryMarkdown: string
}

const incidentFixtureSchema = z
  .object({
    issueId: z.string().min(1),
    repoId: z.string().min(1),
    channelId: z.string().min(1),
    threadTs: z.string().min(1),
    title: z.string().min(1),
    culprit: z.string().min(1).optional(),
    permalink: z.string().url().optional(),
  })
  .strict()

export class SlackBlockRenderError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = "SlackBlockRenderError"
  }
}

const parseMessageIncident = (input: InitialIncidentMessageInput) => ({
  issueId: sentryIssueId(input.issueId),
  repoId: repoId(input.repoId),
  channel: slackChannelId(input.channelId),
  threadTs: slackThreadTs(input.threadTs),
})

const actionValue = (issueId: SentryIssueId, repo: RepoId): string =>
  JSON.stringify({ issueId, repoId: repo })

const plainText = (text: string): SlackTextObject => ({
  type: "plain_text",
  text,
  emoji: true,
})

const mrkdwnText = (text: string): SlackTextObject => ({
  type: "mrkdwn",
  text,
})

const button = (
  label: string,
  actionId: SlackActionId,
  value: string,
  style?: SlackButtonElement["style"],
): SlackButtonElement => ({
  type: "button",
  text: plainText(label),
  action_id: actionId,
  value,
  ...(style === undefined ? {} : { style }),
})

const safeLine = (label: string, value: string | undefined): string | undefined =>
  value === undefined ? undefined : `*${label}:* ${redactAndTruncate(value, 300)}`

export const parseInitialIncidentFixture = (payload: unknown): InitialIncidentMessageInput => {
  const parsed = incidentFixtureSchema.safeParse(payload)
  if (!parsed.success) {
    throw new SlackBlockRenderError("Invalid incident-detected fixture")
  }
  return {
    issueId: parsed.data.issueId,
    repoId: parsed.data.repoId,
    channelId: parsed.data.channelId,
    threadTs: parsed.data.threadTs,
    title: parsed.data.title,
    ...(parsed.data.culprit === undefined ? {} : { culprit: parsed.data.culprit }),
    ...(parsed.data.permalink === undefined ? {} : { permalink: parsed.data.permalink }),
  }
}

export const buildInitialIncidentMessage = (
  input: InitialIncidentMessageInput,
): SlackRenderedMessage => {
  const incident = parseMessageIncident(input)
  const value = actionValue(incident.issueId, incident.repoId)
  const lines = [
    "*새 Sentry incident가 감지되었습니다*",
    `*Issue:* ${redactAndTruncate(input.title, 300)}`,
    safeLine("Culprit", input.culprit),
    safeLine("Link", input.permalink),
  ].filter((line): line is string => line !== undefined)

  return {
    channel: incident.channel,
    threadTs: incident.threadTs,
    text: `Sentry incident 감지: ${redactAndTruncate(input.title, 180)}`,
    blocks: [
      {
        type: "section",
        text: mrkdwnText(lines.join("\n")),
      },
      {
        type: "actions",
        elements: [
          button("분석하기", SlackActionIds.analyze, value, "primary"),
          button("수정해서 MR", SlackActionIds.fixAndMr, value),
          button("무시", SlackActionIds.ignore, value, "danger"),
        ],
      },
    ],
  }
}

export const buildAnalysisCompleteMessage = (
  input: AnalysisCompleteMessageInput,
): SlackRenderedMessage => {
  const channel = slackChannelId(input.channelId)
  const threadTs = slackThreadTs(input.threadTs)
  const issueId = sentryIssueId(input.issueId)
  const repo = repoId(input.repoId)
  const value = actionValue(issueId, repo)
  const safeSummary = redactAndTruncate(input.summaryMarkdown, 2500)

  return {
    channel,
    threadTs,
    text: `${redactSensitiveText(input.issueId)} 분석 완료`,
    blocks: [
      {
        type: "section",
        text: mrkdwnText(`*분석 완료*\n${safeSummary}`),
      },
      {
        type: "actions",
        elements: [
          button("수정하기", SlackActionIds.fixAfterAnalysis, value, "primary"),
          button("닫기", SlackActionIds.close, value),
        ],
      },
    ],
  }
}
