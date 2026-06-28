import type { RepoId, SentryIssueId, SlackActorRef, SlackThreadRef } from "./ids.js"

export type AnalyzeApprovalDecision = {
  readonly kind: "analyze_requested"
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
  readonly actor: SlackActorRef
}

export type FixApprovalDecision = {
  readonly kind: "fix_requested"
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
  readonly actor: SlackActorRef
}

export type IgnoreApprovalDecision = {
  readonly kind: "ignored"
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
  readonly actor: SlackActorRef
}

export type CloseApprovalDecision = {
  readonly kind: "closed"
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
  readonly actor: SlackActorRef
}

export type ApprovalDecision =
  | AnalyzeApprovalDecision
  | FixApprovalDecision
  | IgnoreApprovalDecision
  | CloseApprovalDecision
