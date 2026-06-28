import type { RepoId, SentryIssueId, SlackThreadRef } from "./ids.js"

type IncidentWorkflowBase = {
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly thread: SlackThreadRef
}

export type DetectedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "detected"
}

export type IgnoredWorkflowState = IncidentWorkflowBase & {
  readonly kind: "ignored"
}

export type AnalysisRequestedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "analysis_requested"
}

export type AnalysisRunningWorkflowState = IncidentWorkflowBase & {
  readonly kind: "analysis_running"
}

export type AnalysisCompletedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "analysis_completed"
}

export type FixRequestedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "fix_requested"
}

export type FixRunningWorkflowState = IncidentWorkflowBase & {
  readonly kind: "fix_running"
}

export type MrCreatedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "mr_created"
}

export type FailedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "failed"
  readonly reason: "analysis_failed" | "verification_failed" | "mr_failed_after_push"
}

export type ClosedWorkflowState = IncidentWorkflowBase & {
  readonly kind: "closed"
}

export type WorkflowState =
  | DetectedWorkflowState
  | IgnoredWorkflowState
  | AnalysisRequestedWorkflowState
  | AnalysisRunningWorkflowState
  | AnalysisCompletedWorkflowState
  | FixRequestedWorkflowState
  | FixRunningWorkflowState
  | MrCreatedWorkflowState
  | FailedWorkflowState
  | ClosedWorkflowState

export type WorkflowStateKind = WorkflowState["kind"]

export class InvalidWorkflowTransitionError extends Error {
  public readonly from: WorkflowStateKind
  public readonly to: WorkflowStateKind

  public constructor(from: WorkflowStateKind, to: WorkflowStateKind) {
    super(`Invalid workflow transition: ${from} -> ${to}`)
    this.name = "InvalidWorkflowTransitionError"
    this.from = from
    this.to = to
  }
}

export const requestAnalysis = (state: WorkflowState): AnalysisRequestedWorkflowState => {
  switch (state.kind) {
    case "detected":
      return { ...state, kind: "analysis_requested" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "analysis_requested")
  }
}

export const ignoreIncident = (state: WorkflowState): IgnoredWorkflowState => {
  switch (state.kind) {
    case "detected":
      return { ...state, kind: "ignored" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "ignored")
  }
}

export const startAnalysis = (state: WorkflowState): AnalysisRunningWorkflowState => {
  switch (state.kind) {
    case "analysis_requested":
      return { ...state, kind: "analysis_running" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "analysis_running")
  }
}

export const completeAnalysis = (state: WorkflowState): AnalysisCompletedWorkflowState => {
  switch (state.kind) {
    case "analysis_running":
      return { ...state, kind: "analysis_completed" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "analysis_completed")
  }
}

export const requestFix = (state: WorkflowState): FixRequestedWorkflowState => {
  switch (state.kind) {
    case "analysis_completed":
      return { ...state, kind: "fix_requested" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "fix_requested")
  }
}

export const startFix = (state: WorkflowState): FixRunningWorkflowState => {
  switch (state.kind) {
    case "fix_requested":
      return { ...state, kind: "fix_running" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "fix_running")
  }
}

export const markMrCreated = (state: WorkflowState): MrCreatedWorkflowState => {
  switch (state.kind) {
    case "fix_running":
      return { ...state, kind: "mr_created" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "mr_created")
  }
}

export const markFixFailed = (
  state: WorkflowState,
  reason: FailedWorkflowState["reason"],
): FailedWorkflowState => {
  switch (state.kind) {
    case "fix_running":
      return { ...state, kind: "failed", reason }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "failed")
  }
}

export const markFixClosed = (state: WorkflowState): ClosedWorkflowState => {
  switch (state.kind) {
    case "fix_running":
      return { ...state, kind: "closed" }
    default:
      throw new InvalidWorkflowTransitionError(state.kind, "closed")
  }
}
