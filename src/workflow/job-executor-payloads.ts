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

type SourceRunnerRequestPayloadInput = {
  readonly allowedCommands: readonly string[] | undefined
  readonly incidentContext: RunnerIncidentContext
  readonly mode: RunnerRequest["mode"]
  readonly workspacePath: string
}

const missingMrSectionText = "보고되지 않음"

const markdownList = (value: string | undefined): string => {
  const lines =
    value
      ?.trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0) ?? []
  if (lines.length === 0) {
    return `- ${missingMrSectionText}`
  }
  return lines.map((line) => `- ${line}`).join("\n")
}

const fallbackMergeRequestBody = (input: MergeRequestPayloadInput): string =>
  [
    "## 요약",
    "",
    `- Incident: \`${input.context.incident.issueId}\``,
    `- Source branch: \`${input.branchName}\``,
    `- Target branch: \`${input.defaultTargetBranch}\``,
    markdownList(input.analysisSummary ?? input.result.analysis),
    "",
    "## 변경 사항",
    "",
    markdownList(input.result.changesSummary),
    "",
    "## 검증",
    "",
    markdownList(input.result.verificationResults),
    "",
    "## 위험 및 롤백",
    "",
    markdownList(input.result.mrReadiness),
  ].join("\n")

const mergeRequestBody = (input: MergeRequestPayloadInput): string =>
  input.result.mergeRequestBody?.trim() === ""
    ? fallbackMergeRequestBody(input)
    : (input.result.mergeRequestBody ?? fallbackMergeRequestBody(input))

export const buildRunnerRequest = (input: RunnerRequestPayloadInput): RunnerRequest => ({
  ...(input.allowedCommands === undefined ? {} : { allowedCommands: input.allowedCommands }),
  incidentContext: input.incidentContext,
  mode: input.mode,
  repositoryConstraints:
    "Use configured repo/workspace only. Do not push or create MR unless fix mode is approved.",
  workspacePath: input.session.worktreePath,
})

export const buildSourceRunnerRequest = (
  input: SourceRunnerRequestPayloadInput,
): RunnerRequest => ({
  ...(input.allowedCommands === undefined ? {} : { allowedCommands: input.allowedCommands }),
  incidentContext: input.incidentContext,
  mode: input.mode,
  repositoryConstraints:
    "Use configured repo/workspace only. Do not push or create MR unless fix mode is approved.",
  workspacePath: input.workspacePath,
})

export const buildMergeRequestInput = (
  input: MergeRequestPayloadInput,
): CreateMergeRequestInput => ({
  bodyTemplate: mergeRequestBody(input),
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
  `검증이 통과했습니다.\n브랜치 push 완료: ${context.branchName}\nMR: ${mrUrl}\n${result.changesSummary ?? ""}`
