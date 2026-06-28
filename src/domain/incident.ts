import {
  type RepoId,
  repoId,
  type SentryIssueId,
  type SlackThreadRef,
  sentryIssueId,
  slackChannelId,
  slackThreadTs,
} from "./ids.js"
import type { AnalysisOnlyJobRequest } from "./runner-mode.js"
import type { DetectedWorkflowState } from "./workflow-state.js"

export type DetectedIncidentInput = {
  readonly issueId: string
  readonly repoId: string
  readonly channelId: string
  readonly threadTs: string
}

export type IncidentRef = {
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
}

export const createDetectedIncident = (input: DetectedIncidentInput): DetectedWorkflowState => {
  const channelId = slackChannelId(input.channelId)
  return {
    kind: "detected",
    issueId: sentryIssueId(input.issueId),
    repoId: repoId(input.repoId),
    thread: {
      channelId,
      threadTs: slackThreadTs(input.threadTs),
    },
  }
}

export const createAnalysisOnlyJobRequest = (incident: IncidentRef): AnalysisOnlyJobRequest => ({
  kind: "analysis_job_requested",
  mode: { kind: "analysis_only" },
  issueId: incident.issueId,
  repoId: incident.repoId,
})
