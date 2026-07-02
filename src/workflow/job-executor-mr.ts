import type { RunnerResult } from "../runner/types.js"
import { redactSensitiveText } from "../shared/redaction.js"
import type { JobClaimRecord } from "../state/types.js"
import { saveWorkflowHandoff } from "./incident-handoff.js"
import { buildFixSuccessStatusText, buildMergeRequestInput } from "./job-executor-payloads.js"
import { buildWorkflowStatusMessage, safeErrorText } from "./messages.js"
import type {
  IncidentWorkflowOptions,
  WorkflowJobContext,
  WorkflowSlackPublisher,
  WorkflowStateStore,
  WorkflowWorktreeSession,
} from "./types.js"

type SetWorkflowState = (context: WorkflowJobContext, state: string, details?: string) => void

type CompleteWorkflowJob = (job: JobClaimRecord, state: "completed" | "failed" | "canceled") => void

export class WorkflowMergeRequestPublishedError extends Error {
  public readonly branchName: string
  public readonly cause: Error
  public readonly mrUrl: string
  public readonly name = "WorkflowMergeRequestPublishedError"

  public constructor(input: {
    readonly branchName: string
    readonly cause: Error
    readonly mrUrl: string
  }) {
    super(`MR/PR published at ${input.mrUrl} but durable handoff failed: ${input.cause.message}`)
    this.branchName = input.branchName
    this.cause = input.cause
    this.mrUrl = input.mrUrl
  }
}

export const createWorkflowMergeRequest = async (input: {
  readonly analysisSummary: string | undefined
  readonly context: WorkflowJobContext
  readonly defaultTargetBranch: string
  readonly mrDefaults: IncidentWorkflowOptions["mrDefaults"]
  readonly options: Pick<
    IncidentWorkflowOptions,
    "mrProvider" | "repo" | "sentryContextSecretValues"
  >
  readonly reportJob: (context: WorkflowJobContext, event: string) => void
  readonly result: RunnerResult
  readonly session: WorkflowWorktreeSession
  readonly state: WorkflowStateStore
}): Promise<{ readonly mrUrl: string }> => {
  const mrInput = buildMergeRequestInput({
    analysisSummary: input.analysisSummary,
    branchName: input.session.branchName,
    context: input.context,
    defaultTargetBranch: input.defaultTargetBranch,
    mrDefaults: input.mrDefaults,
    result: input.result,
  })
  input.reportJob(input.context, `mr creating provider=${input.options.mrProvider.provider}`)
  const mr = await input.options.mrProvider.createMergeRequest(mrInput)
  try {
    const headSha = await input.options.repo.currentHead({ repoPath: input.session.worktreePath })
    const createdAt = new Date().toISOString()
    input.state.saveMrLink({
      incidentId: input.context.incident.incidentId,
      jobId: input.context.job.jobId,
      provider: input.options.mrProvider.provider,
      url: mr.url,
      createdAt,
    })
    saveWorkflowHandoff({
      analysisSummary: input.analysisSummary ?? input.result.analysis,
      context: input.context,
      createdAt,
      headSha,
      mrUrl: mr.url,
      provider: input.options.mrProvider.provider,
      result: input.result,
      secretValues: input.options.sentryContextSecretValues,
      sourceBranch: mrInput.sourceBranch,
      state: input.state,
      targetBranch: mrInput.targetBranch,
    })
  } catch (error) {
    if (error instanceof Error) {
      throw new WorkflowMergeRequestPublishedError({
        branchName: mrInput.sourceBranch,
        cause: error,
        mrUrl: mr.url,
      })
    }
    throw error
  }
  return { mrUrl: mr.url }
}

export const postWorkflowFixSuccess = async (input: {
  readonly context: WorkflowJobContext
  readonly mrUrl: string
  readonly result: RunnerResult
  readonly slack: WorkflowSlackPublisher
}): Promise<void> => {
  await input.slack.postMessage(
    buildWorkflowStatusMessage(
      input.context.incident.channelId,
      input.context.incident.threadTs,
      buildFixSuccessStatusText(input.context, input.result, input.mrUrl),
    ),
  )
}

export const handleWorkflowMrFailedAfterPush = async (input: {
  readonly branchName: string
  readonly completeJob: CompleteWorkflowJob
  readonly context: WorkflowJobContext
  readonly error: Error
  readonly mrUrl?: string
  readonly remoteName: string
  readonly secretValues: readonly string[] | undefined
  readonly worktreeRetainedReason?: string
  readonly setState: SetWorkflowState
  readonly slack: WorkflowSlackPublisher
}): Promise<void> => {
  const mrDetail = input.mrUrl === undefined ? "" : ` mr=${input.mrUrl}`
  input.setState(
    input.context,
    "mr_failed_after_push",
    `mr_failed_after_push branch=${input.branchName} remote=${input.remoteName}${mrDetail} error=${redactSensitiveText(
      input.error.message,
      input.secretValues ?? [],
    )}`,
  )
  input.completeJob(input.context.job, "failed")
  await input.slack.postMessage(
    buildWorkflowStatusMessage(
      input.context.incident.channelId,
      input.context.incident.threadTs,
      `브랜치 push 이후 MR 생성에 실패했습니다. 재시도를 위해 브랜치는 유지했습니다: ${input.branchName}.${input.mrUrl === undefined ? "" : ` MR/PR: ${input.mrUrl}.`}${input.worktreeRetainedReason === undefined ? "" : ` cleanup skipped: ${input.worktreeRetainedReason}.`} ${safeErrorText(
        "이유",
        input.error,
        input.secretValues ?? [],
      )}`,
    ),
  )
}
