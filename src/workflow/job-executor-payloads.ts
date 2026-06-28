import type { CreateMergeRequestInput } from "../mr/types.js"
import type { RunnerIncidentContext, RunnerRequest, RunnerResult } from "../runner/types.js"
import { redactAndTruncate } from "../shared/redaction.js"
import type {
  IncidentWorkflowOptions,
  WorkflowJobContext,
  WorkflowWorktreeSession,
} from "./types.js"

type MergeRequestPayloadInput = {
  readonly analysisSummary: string | undefined
  readonly branchName: string
  readonly context: WorkflowJobContext
  readonly defaultTargetBranch: string
  readonly mrDefaults: IncidentWorkflowOptions["mrDefaults"] | undefined
  readonly result: RunnerResult
}

type RunnerRequestPayloadInput = {
  readonly allowedCommands: readonly string[] | undefined
  readonly incidentContext: RunnerIncidentContext
  readonly mode: RunnerRequest["mode"]
  readonly session: WorkflowWorktreeSession
}

export const buildRunnerRequest = (input: RunnerRequestPayloadInput): RunnerRequest => ({
  ...(input.allowedCommands === undefined ? {} : { allowedCommands: input.allowedCommands }),
  incidentContext: input.incidentContext,
  mode: input.mode,
  repositoryConstraints:
    "Use configured repo/worktree only. Do not push or create MR unless fix mode is approved.",
  worktreePath: input.session.worktreePath,
})

export const buildMergeRequestInput = (
  input: MergeRequestPayloadInput,
): CreateMergeRequestInput => ({
  bodyTemplate: [
    `Incident: ${input.context.incident.issueId}`,
    `Analysis: ${input.analysisSummary ?? input.result.analysis}`,
    `Verification: ${input.result.verificationResults ?? "not reported"}`,
  ].join("\n"),
  draft: input.mrDefaults?.draft ?? false,
  labels: input.mrDefaults?.labels ?? ["incident-chatops"],
  sourceBranch: input.branchName,
  targetBranch: input.defaultTargetBranch,
  titleTemplate: `Fix ${input.context.incident.issueId}: ${redactAndTruncate(
    input.context.incident.title,
    80,
  )}`,
})

export const buildFixSuccessStatusText = (
  context: WorkflowJobContext,
  result: RunnerResult,
  mrUrl: string,
): string =>
  `Verification passed.\nBranch pushed: ${context.branchName}\nMR: ${mrUrl}\n${result.changesSummary ?? ""}`
