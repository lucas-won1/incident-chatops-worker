import type { MergeRequestProviderId } from "../mr/types.js"
import type { RunnerResult } from "../runner/types.js"
import { redactSensitiveText } from "../shared/redaction.js"
import type { IncidentHandoffInput } from "../state/types.js"
import type { WorkflowJobContext, WorkflowStateStore } from "./types.js"

export type SaveWorkflowHandoffInput = {
  readonly analysisSummary: string
  readonly context: WorkflowJobContext
  readonly createdAt: string
  readonly headSha: string
  readonly mrUrl: string
  readonly provider: MergeRequestProviderId
  readonly result: RunnerResult
  readonly secretValues: readonly string[] | undefined
  readonly sourceBranch: string
  readonly state: WorkflowStateStore
  readonly targetBranch: string
}

export const saveWorkflowHandoff = (input: SaveWorkflowHandoffInput): void => {
  const redact = (value: string): string => redactSensitiveText(value, input.secretValues ?? [])
  input.state.saveIncidentHandoff({
    analysisSummary: redact(input.analysisSummary),
    changesSummary: redact(input.result.changesSummary ?? "Not reported"),
    createdAt: input.createdAt,
    followUpPrompt: redact(
      `Continue incident ${input.context.incident.issueId} from ${input.mrUrl} on ${input.sourceBranch} -> ${input.targetBranch} at ${input.headSha}. Use the stored summaries, not raw Sentry payloads.`,
    ),
    headSha: input.headSha,
    incidentId: input.context.incident.incidentId,
    issueId: input.context.incident.issueId,
    jobId: input.context.job.jobId,
    mrReadiness: redact(input.result.mrReadiness ?? "Not reported"),
    mrUrl: redact(input.mrUrl),
    provider: input.provider,
    repoId: input.context.incident.repoId,
    repoPath: input.context.repoPath,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    verificationSummary: redact(input.result.verificationResults ?? "Not reported"),
  } satisfies IncidentHandoffInput)
}
