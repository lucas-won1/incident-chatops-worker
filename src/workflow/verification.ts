import type { RunnerResult } from "../runner/types.js"
import { assertNever } from "../shared/assert-never.js"
import type { VerificationStatus } from "../state/types.js"
import { WorkflowVerificationFailedError } from "./errors.js"
import type { WorkflowJobContext, WorkflowStateStore } from "./types.js"

export type WorkflowVerificationSummary = {
  readonly status: VerificationStatus
  readonly summaryMarkdown: string
}

const explicitPassPattern = /^(?:pass|passed|verification passed|all checks passed)\b/iu

export const workflowVerificationSummary = (result: RunnerResult): WorkflowVerificationSummary => {
  const summaryMarkdown = result.verificationResults?.trim() ?? ""
  if (summaryMarkdown.length === 0) {
    return { status: "missing", summaryMarkdown: "verification result missing" }
  }
  return {
    status: explicitPassPattern.test(summaryMarkdown) ? "passed" : "failed",
    summaryMarkdown,
  }
}

export const ensureWorkflowVerificationPassed = (result: RunnerResult): void => {
  const summary = workflowVerificationSummary(result)
  switch (summary.status) {
    case "missing":
      throw new WorkflowVerificationFailedError("verification result missing")
    case "failed":
      throw new WorkflowVerificationFailedError("verification failed")
    case "passed":
      return
    default:
      assertNever(summary.status)
  }
}

export const saveWorkflowVerificationSummary = (input: {
  readonly context: WorkflowJobContext
  readonly createdAt: string
  readonly result: RunnerResult
  readonly state: WorkflowStateStore
}): WorkflowVerificationSummary => {
  const summary = workflowVerificationSummary(input.result)
  input.state.saveVerificationSummary({
    createdAt: input.createdAt,
    incidentId: input.context.incident.incidentId,
    jobId: input.context.job.jobId,
    status: summary.status,
    summaryMarkdown: summary.summaryMarkdown,
  })
  return summary
}
