import type { RepoId, SentryIssueId } from "./ids.js"

export type AnalysisOnlyRunnerMode = {
  readonly kind: "analysis_only"
}

export type FixAndMrRunnerMode = {
  readonly kind: "fix_and_mr"
}

export type RunnerMode = AnalysisOnlyRunnerMode | FixAndMrRunnerMode

export type AnalysisOnlyJobRequest = {
  readonly kind: "analysis_job_requested"
  readonly mode: AnalysisOnlyRunnerMode
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
}

export type FixAndMrJobRequest = {
  readonly kind: "fix_job_requested"
  readonly mode: FixAndMrRunnerMode
  readonly issueId: SentryIssueId
  readonly repoId: RepoId
  readonly branchPrefix: string
}

export type RunnerJobRequest = AnalysisOnlyJobRequest | FixAndMrJobRequest
