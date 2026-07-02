import type { JobClaimRecord } from "../state/types.js"
import { WorkflowVerificationFailedError } from "./errors.js"
import { buildWorkflowStatusMessage, safeErrorText } from "./messages.js"
import type { WorkflowJobContext, WorkflowSlackPublisher } from "./types.js"

type SetWorkflowState = (context: WorkflowJobContext, state: string, details?: string) => void

type CompleteWorkflowJob = (job: JobClaimRecord, state: "completed" | "failed" | "canceled") => void

export const handleWorkflowJobFailure = async (input: {
  readonly completeJob: CompleteWorkflowJob
  readonly context: WorkflowJobContext
  readonly error: Error
  readonly reportJob: (context: WorkflowJobContext, event: string) => void
  readonly setState: SetWorkflowState
  readonly slack: WorkflowSlackPublisher
}): Promise<void> => {
  const state =
    input.error instanceof WorkflowVerificationFailedError ? "verification_failed" : "failed"
  input.reportJob(input.context, `job failed state=${state} error=${input.error.message}`)
  input.setState(input.context, state, safeErrorText("워크플로우 실패", input.error))
  input.completeJob(input.context.job, "failed")
  await input.slack.postMessage(
    buildWorkflowStatusMessage(
      input.context.incident.channelId,
      input.context.incident.threadTs,
      safeErrorText("워크플로우 실패", input.error),
    ),
  )
}
