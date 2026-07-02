import { redactAndTruncate, redactSensitiveText } from "../shared/redaction.js"
import { buildAnalysisCompleteMessage } from "../slack/block-kit.js"
import type { JobClaimRecord } from "../state/types.js"
import { transitionIncidentWorkflowState } from "./audit-transition.js"
import { handleWorkflowJobFailure } from "./job-executor-failure.js"
import { runWorkflowFix } from "./job-executor-fix.js"
import { buildSourceRunnerRequest } from "./job-executor-payloads.js"
import { cleanupWorkflowSession, ensureCleanWorkflowSource } from "./job-executor-worktree.js"
import { resolveRunnerIncidentContext } from "./runner-context.js"
import type {
  IncidentWorkflowOptions,
  WorkflowJobContext,
  WorkflowWorktreeSession,
} from "./types.js"

const nowIso = (): string => new Date().toISOString()
const statusLineMaxLength = 600

export class WorkflowJobExecutor {
  readonly #options: IncidentWorkflowOptions
  public constructor(options: IncidentWorkflowOptions) {
    this.#options = options
  }

  public async runAnalysis(context: WorkflowJobContext): Promise<void> {
    this.#setState(context, "analysis_running")
    this.#reportJob(context, "job running mode=analysis_only")
    const incidentContext = await resolveRunnerIncidentContext({
      context,
      options: this.#options,
    })
    this.#reportJob(context, "incident context ready")
    await ensureCleanWorkflowSource({
      context,
      repo: this.#options.repo,
      reportJob: (jobContext, event) => this.#reportJob(jobContext, event),
    })
    const allowedCommands = this.#options.allowedRunnerCommands
    this.#reportJob(context, "runner starting mode=analysis_only")
    const result = await this.#options.runner.run(
      buildSourceRunnerRequest({
        allowedCommands,
        incidentContext,
        mode: "analysis_only",
        workspacePath: context.repoPath,
      }),
    )
    this.#reportJob(context, `runner completed mode=analysis_only command=${result.command}`)
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
    this.#reportJob(context, "job completed mode=analysis_only")
  }

  public async runFix(context: WorkflowJobContext): Promise<void> {
    await runWorkflowFix({
      callbacks: {
        auditCleanupSkipped: (auditInput) => {
          this.audit(
            auditInput.context.actor,
            "cleanup_skipped",
            undefined,
            undefined,
            `cleanup_skipped worktree=${auditInput.session.worktreePath} branch=${auditInput.session.branchName} mr=${auditInput.mrUrl} reason=remote_mr_without_durable_handoff error=${redactSensitiveText(
              auditInput.failureReason,
              this.#options.sentryContextSecretValues ?? [],
            )}`,
            auditInput.context.job.jobId,
          )
        },
        cleanup: (jobContext, session) => this.cleanup(jobContext, session),
        completeJob: (job, state) => this.#completeJob(job, state),
        reportJob: (jobContext, event) => this.#reportJob(jobContext, event),
        setState: (jobContext, state, details) => this.#setState(jobContext, state, details),
      },
      context,
      nowIso,
      options: this.#options,
    })
  }

  public async handleJobFailure(context: WorkflowJobContext, error: Error): Promise<void> {
    await handleWorkflowJobFailure({
      completeJob: (job, state) => this.#completeJob(job, state),
      context,
      error,
      reportJob: (jobContext, event) => this.#reportJob(jobContext, event),
      setState: (jobContext, state, details) => this.#setState(jobContext, state, details),
      slack: this.#options.slack,
    })
  }

  public async cleanup(
    context: WorkflowJobContext,
    session: WorkflowWorktreeSession,
  ): Promise<void> {
    await cleanupWorkflowSession({
      audit: (actor, action, stateFrom, stateTo, details, jobId) =>
        this.audit(actor, action, stateFrom, stateTo, details, jobId),
      context,
      reportJob: (jobContext, event) => this.#reportJob(jobContext, event),
      secretValues: this.#options.sentryContextSecretValues,
      session,
    })
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

  #reportJob(context: WorkflowJobContext, event: string): void {
    this.#report(
      `workflow ${event} issue=${context.incident.issueId} job=${context.job.jobId} branch=${context.branchName}`,
    )
  }

  #report(line: string): void {
    this.#options.statusReporter?.(
      redactAndTruncate(line, statusLineMaxLength, this.#options.sentryContextSecretValues ?? []),
    )
  }
}
