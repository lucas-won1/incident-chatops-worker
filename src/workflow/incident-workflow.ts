import type { SlackActionIntent } from "../slack/action-payload.js"
import { buildInitialIncidentMessage } from "../slack/block-kit.js"
import { StateStoreConstraintError } from "../state/errors.js"
import type { IncidentRecord, JobClaimRecord, JobKind } from "../state/types.js"
import { transitionIncidentWorkflowState } from "./audit-transition.js"
import { WorkflowPolicyError } from "./errors.js"
import { WorkflowJobExecutor } from "./job-executor.js"
import { buildWorkflowStatusMessage } from "./messages.js"
import type {
  IncidentWorkflowOptions,
  WorkflowActionResult,
  WorkflowDetectedIncident,
  WorkflowJobContext,
} from "./types.js"

const nowIso = (): string => new Date().toISOString()

const actorKey = (intent: SlackActionIntent): string => `slack:${intent.actor.slackUserId}`

const actionKey = (intent: SlackActionIntent): string =>
  `${intent.actionId}:${intent.issueId}:${intent.thread.threadTs}:${intent.actor.slackUserId}`

const needsRootThreadTs = (threadTs: string): boolean =>
  threadTs.trim() === "" || threadTs === "pending"

const branchIssuePart = (issueId: string): string => issueId.replace(/[^A-Za-z0-9._-]/gu, "-")

const isTerminalJob = (job: JobClaimRecord): boolean =>
  job.state === "completed" || job.state === "failed" || job.state === "canceled"

const duplicateJobStatusText = (job: JobClaimRecord): string => {
  if (isTerminalJob(job)) {
    return `이미 처리된 작업입니다. job=${job.jobId}`
  }
  return `이미 진행 중인 작업입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요. job=${job.jobId}`
}

const requestedStateByJobKind = {
  analysis: "analysis_requested",
  fix: "fix_requested",
} as const satisfies Record<JobKind, string>

const jobStartStatusText = (jobKind: JobKind): string => {
  switch (jobKind) {
    case "analysis":
      return "분석을 시작했습니다. Sentry 컨텍스트를 읽고 원인을 조사하는 중입니다."
    case "fix":
      return "수정 작업을 시작했습니다. 로컬 worktree를 준비하고 변경 사항을 검증하는 중입니다."
  }
}

export class IncidentWorkflow {
  readonly #options: IncidentWorkflowOptions
  readonly #executor: WorkflowJobExecutor
  readonly #detectedIncidentQueue = new Map<string, Promise<void>>()

  public constructor(options: IncidentWorkflowOptions) {
    this.#options = options
    this.#executor = new WorkflowJobExecutor(options)
  }

  public async handleDetectedIncident(incident: WorkflowDetectedIncident): Promise<void> {
    const queued = (this.#detectedIncidentQueue.get(incident.issueId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#handleDetectedIncidentLocked(incident))
    this.#detectedIncidentQueue.set(incident.issueId, queued)
    try {
      await queued
    } finally {
      if (this.#detectedIncidentQueue.get(incident.issueId) === queued) {
        this.#detectedIncidentQueue.delete(incident.issueId)
      }
    }
  }

  async #handleDetectedIncidentLocked(incident: WorkflowDetectedIncident): Promise<void> {
    const result = this.#options.state.upsertIncident(incident)
    let incidentId = result.incidentId
    if (!result.created) {
      const existing = this.#options.state.getIncidentByIssueId(incident.issueId)
      if (existing === undefined || !needsRootThreadTs(existing.threadTs)) {
        return
      }
      incidentId = existing.incidentId
    }
    const postResult = await this.#options.slack.postMessage(buildInitialIncidentMessage(incident))
    if (
      needsRootThreadTs(incident.threadTs) &&
      postResult.ts !== undefined &&
      postResult.ts.trim() !== ""
    ) {
      this.#options.state.updateIncidentThreadTs({
        incidentId,
        threadTs: postResult.ts,
        updatedAt: nowIso(),
      })
    }
    this.#executor.audit(
      "sentry",
      "incident.detected",
      "none",
      "detected",
      `detected ${incident.issueId}`,
    )
  }

  public async handleSlackAction(intent: SlackActionIntent): Promise<WorkflowActionResult> {
    const incident = this.#ensureIncidentForAction(intent)
    switch (intent.kind) {
      case "ignored":
        return this.#closeWithoutRunner(incident, "ignored", intent)
      case "closed":
        return this.#closeWithoutRunner(incident, "closed", intent)
      case "analyze_requested":
        return this.#runApprovedJob(incident, intent, "analysis")
      case "fix_requested":
        return this.#runApprovedJob(incident, intent, "fix")
    }
  }

  #ensureIncidentForAction(intent: SlackActionIntent): IncidentRecord {
    const existing = this.#options.state.getIncidentByIssueId(intent.issueId)
    if (existing !== undefined) {
      return existing
    }
    const timestamp = nowIso()
    this.#options.state.upsertIncident({
      issueId: intent.issueId,
      repoId: intent.repoId,
      channelId: intent.thread.channelId,
      threadTs: intent.thread.threadTs,
      title: `Sentry issue ${intent.issueId}`,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    })
    const created = this.#options.state.getIncidentByIssueId(intent.issueId)
    if (created === undefined) {
      throw new WorkflowPolicyError(`incident upsert failed for ${intent.issueId}`)
    }
    return created
  }

  async #closeWithoutRunner(
    incident: IncidentRecord,
    state: "closed" | "ignored",
    intent: SlackActionIntent,
  ): Promise<WorkflowActionResult> {
    transitionIncidentWorkflowState({
      state: this.#options.state,
      incident,
      actor: actorKey(intent),
      action: `workflow.${state}`,
      stateTo: state,
      details: `issue=${intent.issueId} action=${intent.actionId}`,
    })
    const statusText =
      state === "ignored" ? "이 incident를 무시 처리했습니다." : "이 incident를 닫았습니다."
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(incident.channelId, incident.threadTs, statusText),
    )
    return { kind: "closed" }
  }

  async #runApprovedJob(
    incident: IncidentRecord,
    intent: SlackActionIntent,
    jobKind: JobKind,
  ): Promise<WorkflowActionResult> {
    let job: JobClaimRecord
    try {
      job = this.#options.state.claimJobForSlackAction({
        incidentId: incident.incidentId,
        actionIdempotencyKey: actionKey(intent),
        jobKind,
        actor: actorKey(intent),
        now: nowIso(),
      })
    } catch (error) {
      if (error instanceof StateStoreConstraintError) {
        return this.#handleActiveJobRejection(incident, intent, error)
      }
      throw error
    }
    if (job.claimStatus === "duplicate") {
      await this.#options.slack.postMessage(
        buildWorkflowStatusMessage(
          incident.channelId,
          incident.threadTs,
          duplicateJobStatusText(job),
        ),
      )
      return { kind: "duplicate", jobId: job.jobId }
    }

    const requestedIncident = transitionIncidentWorkflowState({
      state: this.#options.state,
      incident,
      actor: actorKey(intent),
      action: `workflow.${requestedStateByJobKind[jobKind]}`,
      stateTo: requestedStateByJobKind[jobKind],
      details: `approved ${jobKind} action=${intent.actionId} issue=${intent.issueId}`,
      jobId: job.jobId,
    })
    const context = this.#jobContext(requestedIncident, intent, job)
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(
        requestedIncident.channelId,
        requestedIncident.threadTs,
        jobStartStatusText(jobKind),
      ),
    )
    try {
      if (jobKind === "analysis") {
        await this.#executor.runAnalysis(context)
      } else {
        await this.#executor.runFix(context)
      }
      return { kind: "handled", jobId: job.jobId }
    } catch (error) {
      if (error instanceof Error) {
        await this.#executor.handleJobFailure(context, error)
        return { kind: "handled", jobId: job.jobId }
      }
      throw error
    }
  }

  async #handleActiveJobRejection(
    incident: IncidentRecord,
    intent: SlackActionIntent,
    error: StateStoreConstraintError,
  ): Promise<WorkflowActionResult> {
    this.#executor.audit(
      actorKey(intent),
      "job.rejected_active",
      undefined,
      "rejected",
      `active job rejected action=${intent.actionId} issue=${intent.issueId} constraint=${error.constraint}`,
    )
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(
        incident.channelId,
        incident.threadTs,
        "이미 이 incident의 작업이 진행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.",
      ),
    )
    return { kind: "duplicate" }
  }

  #jobContext(
    incident: IncidentRecord,
    intent: SlackActionIntent,
    job: JobClaimRecord,
  ): WorkflowJobContext {
    const repoPath = this.#options.repoPaths[incident.repoId]
    if (repoPath === undefined) {
      throw new WorkflowPolicyError(`repo path missing for ${incident.repoId}`)
    }
    return {
      actor: actorKey(intent),
      branchName: `${this.#options.branchPrefix}${branchIssuePart(incident.issueId)}`,
      incident,
      intent,
      job,
      repoPath,
    }
  }
}
