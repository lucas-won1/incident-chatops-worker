import { type Brand, brandString } from "../shared/brand.js"

export type SentryIssueId = Brand<string, "SentryIssueId">
export type SlackChannelId = Brand<string, "SlackChannelId">
export type SlackThreadTs = Brand<string, "SlackThreadTs">
export type SlackUserId = Brand<string, "SlackUserId">
export type RepoId = Brand<string, "RepoId">
export type JobId = Brand<string, "JobId">

export type SlackChannelRef = {
  readonly id: SlackChannelId
}

export type SlackThreadRef = {
  readonly channelId: SlackChannelId
  readonly threadTs: SlackThreadTs
}

export type SlackActorRef = {
  readonly slackUserId: SlackUserId
}

export const sentryIssueId = (value: string): SentryIssueId => brandString<"SentryIssueId">(value)

export const slackChannelId = (value: string): SlackChannelId =>
  brandString<"SlackChannelId">(value)

export const slackThreadTs = (value: string): SlackThreadTs => brandString<"SlackThreadTs">(value)

export const slackUserId = (value: string): SlackUserId => brandString<"SlackUserId">(value)

export const repoId = (value: string): RepoId => brandString<"RepoId">(value)

export const jobId = (value: string): JobId => brandString<"JobId">(value)
