import type { RunnerResult } from "../runner/types.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { buildAnalysisCompleteMessage } from "../slack/block-kit.js"
import type { JobClaimRecord } from "../state/types.js"
import { transitionIncidentWorkflowState } from "./audit-transition.js"
import { WorkflowVerificationFailedError } from "./errors.js"
import {
  buildFixSuccessStatusText,
  buildMergeRequestInput,
  buildRunnerRequest,
} from "./job-executor-payloads.js"
import { buildWorkflowStatusMessage, safeErrorText } from "./messages.js"
import { resolveRunnerIncidentContext } from "./runner-context.js"
import type {
  IncidentWorkflowOptions,
  WorkflowJobContext,
  WorkflowWorktreeSession,
} from "./types.js"
import { ensureWorkflowVerificationPassed, workflowVerificationSummary } from "./verification.js"

const nowIso = (): string => new Date().toISOString()

export class WorkflowJobExecutor {
  readonly #options: IncidentWorkflowOptions

  public constructor(options: IncidentWorkflowOptions) {
    this.#options = options
  }

  public async runAnalysis(context: WorkflowJobContext): Promise<void> {
    this.#setState(context, "analysis_running")
    const incidentContext = await resolveRunnerIncidentContext({
      context,
      options: this.#options,
    })
    const session = await this.#openWorktree(context)
    try {
      const result = await this.#options.runner.run(
        buildRunnerRequest({
          allowedCommands: this.#options.allowedRunnerCommands,
          incidentContext,
          mode: "analysis_only",
          session,
        }),
      )
      this.#options.state.saveAnalysisSummary({
        incidentId: context.incident.incidentId,
        jobId: context.job.jobId,
        summaryMarkdown: result.analysis,
        createdAt: nowIso(),
      })
      this.#setState(context, "analysis_completed")
      await this.#options.slack.postMessage(
        buildAnalysisCompleteMessage({
          issueId: context.incident.issueId,
          repoId: context.incident.repoId,
          channelId: context.incident.channelId,
          threadTs: context.incident.threadTs,
          summaryMarkdown: result.analysis,
        }),
      )
      this.#completeJob(context.job, "completed")
    } finally {
      await this.cleanup(context, session)
    }
  }

  public async runFix(context: WorkflowJobContext): Promise<void> {
    this.#setState(context, "fix_running")
    const incidentContext = await resolveRunnerIncidentContext({
      context,
      options: this.#options,
    })
    const session = await this.#openWorktree(context)
    try {
      const result = await this.#options.runner.run(
        buildRunnerRequest({
          allowedCommands: this.#options.allowedRunnerCommands,
          incidentContext,
          mode: "fix_and_mr",
          session,
        }),
      )
      this.#saveVerificationSummary(context, result)
      ensureWorkflowVerificationPassed(result)
      await this.#options.repo.pushBranch({
        branchName: session.branchName,
        remote: this.#options.remoteName,
        repoPath: session.repoPath,
      })
      try {
        const analysis = this.#options.state.getLatestAnalysisSummary(context.incident.incidentId)
        const mrInput = buildMergeRequestInput({
          analysisSummary: analysis?.summaryMarkdown,
          branchName: session.branchName,
          context,
          defaultTargetBranch: this.#options.defaultTargetBranch,
          mrDefaults: this.#options.mrDefaults,
          result,
        })
        const mr = await this.#options.mrProvider.createMergeRequest(mrInput)
        this.#options.state.saveMrLink({
          incidentId: context.incident.incidentId,
          jobId: context.job.jobId,
          provider: this.#options.mrProvider.provider,
          url: mr.url,
          createdAt: nowIso(),
        })
        this.#setState(context, "mr_created")
        await this.#postFixSuccess(context, result, mr.url)
        this.#completeJob(context.job, "completed")
      } catch (error) {
        if (error instanceof Error) {
          await this.#handleMrFailedAfterPush(context, session.branchName, error)
          return
        }
        throw error
      }
    } finally {
      await this.cleanup(context, session)
    }
  }

  public async handleJobFailure(context: WorkflowJobContext, error: Error): Promise<void> {
    const state =
      error instanceof WorkflowVerificationFailedError ? "verification_failed" : "failed"
    this.#setState(context, state, safeErrorText("workflow failed", error))
    this.#completeJob(context.job, "failed")
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(
        context.incident.channelId,
        context.incident.threadTs,
        safeErrorText("Workflow failed", error),
      ),
    )
  }

  public async cleanup(
    context: WorkflowJobContext,
    session: WorkflowWorktreeSession,
  ): Promise<void> {
    try {
      await session.close()
    } catch (error) {
      if (error instanceof Error) {
        this.audit(
          context.actor,
          "cleanup_failed",
          undefined,
          undefined,
          `cleanup_failed worktree=${session.worktreePath} error=${redactSensitiveText(error.message)}`,
          context.job.jobId,
        )
        return
      }
      throw error
    }
  }

  public audit(
    actor: string,
    action: string,
    stateFrom: string | undefined,
    stateTo: string | undefined,
    details: string,
    jobId?: string,
  ): void {
    this.#options.state.appendAuditEntry({
      actor,
      action,
      occurredAt: nowIso(),
      configHash: "workflow",
      ...(jobId === undefined ? {} : { jobId }),
      ...(stateFrom === undefined ? {} : { stateFrom }),
      ...(stateTo === undefined ? {} : { stateTo }),
      details,
    })
  }

  #saveVerificationSummary(context: WorkflowJobContext, result: RunnerResult): void {
    const summary = workflowVerificationSummary(result)
    this.#options.state.saveVerificationSummary({
      createdAt: nowIso(),
      incidentId: context.incident.incidentId,
      jobId: context.job.jobId,
      status: summary.status,
      summaryMarkdown: summary.summaryMarkdown,
    })
  }

  async #postFixSuccess(
    context: WorkflowJobContext,
    result: RunnerResult,
    mrUrl: string,
  ): Promise<void> {
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(
        context.incident.channelId,
        context.incident.threadTs,
        buildFixSuccessStatusText(context, result, mrUrl),
      ),
    )
  }

  async #handleMrFailedAfterPush(
    context: WorkflowJobContext,
    branchName: string,
    error: Error,
  ): Promise<void> {
    this.#setState(
      context,
      "mr_failed_after_push",
      `mr_failed_after_push branch=${branchName} remote=${this.#options.remoteName} error=${redactSensitiveText(error.message)}`,
    )
    this.#completeJob(context.job, "failed")
    await this.#options.slack.postMessage(
      buildWorkflowStatusMessage(
        context.incident.channelId,
        context.incident.threadTs,
        `MR creation failed after push. Branch retained for retry: ${branchName}. ${safeErrorText(
          "Reason",
          error,
        )}`,
      ),
    )
  }

  async #openWorktree(context: WorkflowJobContext): Promise<WorkflowWorktreeSession> {
    return this.#options.repo.openWorktree({
      branchName: context.branchName,
      jobId: context.job.jobId,
      repoPath: context.repoPath,
    })
  }

  #setState(context: WorkflowJobContext, state: string, details?: string): void {
    transitionIncidentWorkflowState({
      state: this.#options.state,
      incident: context.incident,
      actor: context.actor,
      action: `workflow.${state}`,
      stateTo: state,
      details: details ?? `workflow_state_transition issue=${context.incident.issueId} to=${state}`,
      jobId: context.job.jobId,
    })
  }

  #completeJob(job: JobClaimRecord, state: "completed" | "failed" | "canceled"): void {
    this.#options.state.completeJob({
      jobId: job.jobId,
      state,
      finishedAt: nowIso(),
    })
  }
}
