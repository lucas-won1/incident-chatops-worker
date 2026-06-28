import { z } from "zod"
import {
  type RepoId,
  repoId,
  type SentryIssueId,
  type SlackActorRef,
  type SlackChannelRef,
  type SlackThreadRef,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
  slackUserId,
} from "../domain/ids.js"
import { assertNever } from "../shared/assert-never.js"

export const SlackActionIds = {
  analyze: "incident.analyze",
  fixAndMr: "incident.fix_mr",
  fixAfterAnalysis: "incident.fix_after_analysis",
  ignore: "incident.ignore",
  close: "incident.close",
} as const

export type SlackActionId = (typeof SlackActionIds)[keyof typeof SlackActionIds]

type SlackActionValue = {
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
}

export type SlackActionIntent =
  | {
      readonly kind: "analyze_requested"
      readonly actionId: typeof SlackActionIds.analyze
      readonly issueId: SentryIssueId
      readonly repoId: RepoId
      readonly channel: SlackChannelRef
      readonly thread: SlackThreadRef
      readonly actor: SlackActorRef
    }
  | {
      readonly kind: "fix_requested"
      readonly actionId: typeof SlackActionIds.fixAndMr | typeof SlackActionIds.fixAfterAnalysis
      readonly issueId: SentryIssueId
      readonly repoId: RepoId
      readonly channel: SlackChannelRef
      readonly thread: SlackThreadRef
      readonly actor: SlackActorRef
    }
  | {
      readonly kind: "ignored"
      readonly actionId: typeof SlackActionIds.ignore
      readonly issueId: SentryIssueId
      readonly repoId: RepoId
      readonly channel: SlackChannelRef
      readonly thread: SlackThreadRef
      readonly actor: SlackActorRef
    }
  | {
      readonly kind: "closed"
      readonly actionId: typeof SlackActionIds.close
      readonly issueId: SentryIssueId
      readonly repoId: RepoId
      readonly channel: SlackChannelRef
      readonly thread: SlackThreadRef
      readonly actor: SlackActorRef
    }

export class SlackActionPayloadError extends Error {
  public readonly code:
    | "invalid_payload"
    | "invalid_action_value"
    | "missing_action"
    | "unknown_action_id"

  public constructor(code: SlackActionPayloadError["code"], message: string) {
    super(message)
    this.name = "SlackActionPayloadError"
    this.code = code
  }
}

const slackBlockActionPayloadSchema = z
  .object({
    type: z.literal("block_actions"),
    user: z.object({ id: z.string().min(1) }).passthrough(),
    channel: z.object({ id: z.string().min(1) }).passthrough(),
    message: z.object({ ts: z.string().min(1) }).passthrough(),
    actions: z
      .array(
        z
          .object({
            action_id: z.string().min(1),
            value: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()

const actionValueSchema = z
  .object({
    issueId: z.string().min(1),
    repoId: z.string().min(1),
  })
  .strict()

const parseSlackActionId = (value: string): SlackActionId => {
  switch (value) {
    case SlackActionIds.analyze:
      return SlackActionIds.analyze
    case SlackActionIds.fixAndMr:
      return SlackActionIds.fixAndMr
    case SlackActionIds.fixAfterAnalysis:
      return SlackActionIds.fixAfterAnalysis
    case SlackActionIds.ignore:
      return SlackActionIds.ignore
    case SlackActionIds.close:
      return SlackActionIds.close
    default:
      throw new SlackActionPayloadError("unknown_action_id", `Unknown Slack action_id: ${value}`)
  }
}

const parseActionValue = (value: string): SlackActionValue => {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SlackActionPayloadError("invalid_action_value", "Invalid Slack action value JSON")
    }
    throw error
  }

  const parsed = actionValueSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new SlackActionPayloadError("invalid_action_value", "Invalid Slack action value")
  }

  return {
    issueId: sentryIssueId(parsed.data.issueId),
    repoId: repoId(parsed.data.repoId),
  }
}

export const parseSlackActionPayload = (payload: unknown): SlackActionIntent => {
  const parsed = slackBlockActionPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new SlackActionPayloadError("invalid_payload", "Invalid Slack action payload")
  }

  const firstAction = parsed.data.actions[0]
  if (firstAction === undefined) {
    throw new SlackActionPayloadError("missing_action", "Slack action payload has no actions")
  }

  const actionId = parseSlackActionId(firstAction.action_id)
  const actionValue = parseActionValue(firstAction.value)
  const channel = { id: slackChannelId(parsed.data.channel.id) }
  const thread = {
    channelId: channel.id,
    threadTs: slackThreadTs(parsed.data.message.ts),
  }
  const actor = { slackUserId: slackUserId(parsed.data.user.id) }
  const base = {
    issueId: actionValue.issueId,
    repoId: actionValue.repoId,
    channel,
    thread,
    actor,
  }

  switch (actionId) {
    case SlackActionIds.analyze:
      return { kind: "analyze_requested", actionId, ...base }
    case SlackActionIds.fixAndMr:
      return { kind: "fix_requested", actionId, ...base }
    case SlackActionIds.fixAfterAnalysis:
      return { kind: "fix_requested", actionId, ...base }
    case SlackActionIds.ignore:
      return { kind: "ignored", actionId, ...base }
    case SlackActionIds.close:
      return { kind: "closed", actionId, ...base }
    default:
      return assertNever(actionId)
  }
}
