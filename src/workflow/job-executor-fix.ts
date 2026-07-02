import type { JobClaimRecord } from "../state/types.js"
import {
  createWorkflowMergeRequest,
  handleWorkflowMrFailedAfterPush,
  postWorkflowFixSuccess,
  WorkflowMergeRequestPublishedError,
} from "./job-executor-mr.js"
import { buildRunnerRequest } from "./job-executor-payloads.js"
import { openWorkflowWorktree, prepareWorkflowWorktree } from "./job-executor-worktree.js"
import { resolveRunnerIncidentContext } from "./runner-context.js"
import type {
  IncidentWorkflowOptions,
  WorkflowJobContext,
  WorkflowWorktreeSession,
} from "./types.js"
import {
  ensureWorkflowVerificationPassed,
  saveWorkflowVerificationSummary,
} from "./verification.js"

type PublishedCleanupSkip = {
  readonly failureReason: string
  readonly mrUrl: string
}

type CleanupSkippedAuditInput = {
  readonly context: WorkflowJobContext
  readonly failureReason: string
  readonly mrUrl: string
  readonly session: WorkflowWorktreeSession
}

type WorkflowFixCallbacks = {
  readonly auditCleanupSkipped: (input: CleanupSkippedAuditInput) => void
  readonly cleanup: (context: WorkflowJobContext, session: WorkflowWorktreeSession) => Promise<void>
  readonly completeJob: (job: JobClaimRecord, state: "completed" | "failed" | "canceled") => void
  readonly reportJob: (context: WorkflowJobContext, event: string) => void
  readonly setState: (context: WorkflowJobContext, state: string, details?: string) => void
}

type RunWorkflowFixInput = {
  readonly callbacks: WorkflowFixCallbacks
  readonly context: WorkflowJobContext
  readonly nowIso: () => string
  readonly options: IncidentWorkflowOptions
}

export const runWorkflowFix = async (input: RunWorkflowFixInput): Promise<void> => {
  const { callbacks, context, options } = input
  callbacks.setState(context, "fix_running")
  callbacks.reportJob(context, "job running mode=fix_and_mr")
  const incidentContext = await resolveRunnerIncidentContext({ context, options })
  callbacks.reportJob(context, "incident context ready")
  const session = await openWorkflowWorktree({
    context,
    repo: options.repo,
    reportJob: callbacks.reportJob,
  })
  let cleanupRequired = true
  let publishedCleanupSkip: PublishedCleanupSkip | undefined
  try {
    await prepareWorkflowWorktree({
      context,
      preparer: options.worktreePreparer,
      reportJob: callbacks.reportJob,
      session,
    })
    callbacks.reportJob(context, "runner starting mode=fix_and_mr")
    const result = await options.runner.run(
      buildRunnerRequest({
        allowedCommands: options.allowedRunnerCommands,
        incidentContext,
        mode: "fix_and_mr",
        session,
      }),
    )
    callbacks.reportJob(context, `runner completed mode=fix_and_mr command=${result.command}`)
    const verification = saveWorkflowVerificationSummary({
      context,
      createdAt: input.nowIso(),
      result,
      state: options.state,
    })
    callbacks.reportJob(
      context,
      `verification status=${verification.status} summary=${verification.summaryMarkdown}`,
    )
    ensureWorkflowVerificationPassed(result)
    callbacks.reportJob(context, "verification passed")
    callbacks.reportJob(context, `push starting remote=${options.remoteName}`)
    await options.repo.pushBranch({
      branchName: session.branchName,
      remote: options.remoteName,
      repoPath: session.repoPath,
    })
    callbacks.reportJob(context, `push completed remote=${options.remoteName}`)
    try {
      const analysis = options.state.getLatestAnalysisSummary(context.incident.incidentId)
      const mr = await createWorkflowMergeRequest({
        analysisSummary: analysis?.summaryMarkdown,
        context,
        defaultTargetBranch: options.defaultTargetBranch,
        mrDefaults: options.mrDefaults,
        options,
        reportJob: callbacks.reportJob,
        result,
        session,
        state: options.state,
      })
      callbacks.setState(context, "mr_created")
      await postWorkflowFixSuccess({
        context,
        mrUrl: mr.mrUrl,
        result,
        slack: options.slack,
      })
      callbacks.completeJob(context.job, "completed")
      callbacks.reportJob(context, `mr created provider=${options.mrProvider.provider}`)
    } catch (error) {
      if (error instanceof Error) {
        if (error instanceof WorkflowMergeRequestPublishedError) {
          cleanupRequired = false
          publishedCleanupSkip = {
            failureReason: error.cause.message,
            mrUrl: error.mrUrl,
          }
          await handleWorkflowMrFailedAfterPush({
            branchName: error.branchName,
            completeJob: callbacks.completeJob,
            context,
            error: error.cause,
            mrUrl: error.mrUrl,
            remoteName: options.remoteName,
            secretValues: options.sentryContextSecretValues,
            setState: callbacks.setState,
            slack: options.slack,
            worktreeRetainedReason: "remote MR/PR may exist without durable handoff",
          })
          return
        }
        await handleWorkflowMrFailedAfterPush({
          branchName: session.branchName,
          completeJob: callbacks.completeJob,
          context,
          error,
          remoteName: options.remoteName,
          secretValues: options.sentryContextSecretValues,
          setState: callbacks.setState,
          slack: options.slack,
        })
        return
      }
      throw error
    }
  } finally {
    if (cleanupRequired) {
      await callbacks.cleanup(context, session)
    } else {
      const cleanupSkip = publishedCleanupSkip ?? {
        failureReason: "unknown post-publication failure",
        mrUrl: "unknown",
      }
      callbacks.reportJob(
        context,
        `cleanup skipped worktree=${session.worktreePath} branch=${session.branchName} mr=${cleanupSkip.mrUrl}`,
      )
      callbacks.auditCleanupSkipped({
        context,
        failureReason: cleanupSkip.failureReason,
        mrUrl: cleanupSkip.mrUrl,
        session,
      })
    }
  }
}
