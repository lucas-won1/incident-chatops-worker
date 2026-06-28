import type { IncidentRecord } from "../state/types.js"
import type { WorkflowStateStore } from "./types.js"

const nowIso = (): string => new Date().toISOString()

type WorkflowTransitionAuditInput = {
  readonly state: WorkflowStateStore
  readonly incident: IncidentRecord
  readonly actor: string
  readonly action: string
  readonly stateTo: string
  readonly details: string
  readonly jobId?: string
}

const currentWorkflowState = (input: WorkflowTransitionAuditInput): string =>
  input.state.getIncidentByIssueId(input.incident.issueId)?.workflowState ??
  input.incident.workflowState

export const transitionIncidentWorkflowState = (
  input: WorkflowTransitionAuditInput,
): IncidentRecord => {
  const occurredAt = nowIso()
  const stateFrom = currentWorkflowState(input)
  input.state.updateIncidentWorkflowState({
    incidentId: input.incident.incidentId,
    workflowState: input.stateTo,
    updatedAt: occurredAt,
  })
  input.state.appendAuditEntry({
    actor: input.actor,
    action: input.action,
    occurredAt,
    configHash: "workflow",
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    stateFrom,
    stateTo: input.stateTo,
    details: input.details,
  })
  return (
    input.state.getIncidentByIssueId(input.incident.issueId) ?? {
      ...input.incident,
      workflowState: input.stateTo,
    }
  )
}
