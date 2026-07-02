import { redactSensitiveText } from "../shared/redaction.js"
import { WorkflowDirtySourceError } from "./errors.js"
import type {
  WorkflowJobContext,
  WorkflowRepoAdapter,
  WorkflowWorktreePreparer,
  WorkflowWorktreeSession,
} from "./types.js"

type AuditWorkflowCleanup = (
  actor: string,
  action: string,
  stateFrom: string | undefined,
  stateTo: string | undefined,
  details: string,
  jobId?: string,
) => void

type ReportWorkflowJob = (context: WorkflowJobContext, event: string) => void

export const openWorkflowWorktree = async (input: {
  readonly context: WorkflowJobContext
  readonly repo: WorkflowRepoAdapter
  readonly reportJob: ReportWorkflowJob
}): Promise<WorkflowWorktreeSession> => {
  input.reportJob(input.context, `worktree opening repo=${input.context.repoPath}`)
  try {
    const session = await input.repo.openWorktree({
      branchName: input.context.branchName,
      jobId: input.context.job.jobId,
      repoPath: input.context.repoPath,
    })
    input.reportJob(input.context, `worktree ready path=${session.worktreePath}`)
    return session
  } catch (error) {
    if (error instanceof Error) {
      input.reportJob(input.context, `worktree failed error=${error.message}`)
    }
    throw error
  }
}

export const prepareWorkflowWorktree = async (input: {
  readonly context: WorkflowJobContext
  readonly preparer: WorkflowWorktreePreparer | undefined
  readonly reportJob: ReportWorkflowJob
  readonly session: WorkflowWorktreeSession
}): Promise<void> => {
  if (input.preparer === undefined) {
    return
  }
  input.reportJob(input.context, `worktree prepare starting path=${input.session.worktreePath}`)
  try {
    await input.preparer.prepare({ session: input.session })
    input.reportJob(input.context, `worktree prepare completed path=${input.session.worktreePath}`)
  } catch (error) {
    if (error instanceof Error) {
      input.reportJob(input.context, `worktree prepare failed error=${error.message}`)
    }
    throw error
  }
}

export const ensureCleanWorkflowSource = async (input: {
  readonly context: WorkflowJobContext
  readonly repo: WorkflowRepoAdapter
  readonly reportJob: ReportWorkflowJob
}): Promise<void> => {
  input.reportJob(input.context, `source clean check starting repo=${input.context.repoPath}`)
  const dirtyStatus = await input.repo.dirtyStatus({ repoPath: input.context.repoPath })
  if (dirtyStatus.trim().length > 0) {
    input.reportJob(input.context, `source clean check failed repo=${input.context.repoPath}`)
    throw new WorkflowDirtySourceError(input.context.repoPath)
  }
  input.reportJob(input.context, `source clean check completed repo=${input.context.repoPath}`)
}

export const cleanupWorkflowSession = async (input: {
  readonly audit: AuditWorkflowCleanup
  readonly context: WorkflowJobContext
  readonly reportJob: ReportWorkflowJob
  readonly secretValues: readonly string[] | undefined
  readonly session: WorkflowWorktreeSession
}): Promise<void> => {
  input.reportJob(input.context, `cleanup starting worktree=${input.session.worktreePath}`)
  try {
    await input.session.close()
    input.reportJob(input.context, `cleanup completed worktree=${input.session.worktreePath}`)
  } catch (error) {
    if (error instanceof Error) {
      input.reportJob(
        input.context,
        `cleanup failed worktree=${input.session.worktreePath} error=${error.message}`,
      )
      input.audit(
        input.context.actor,
        "cleanup_failed",
        undefined,
        undefined,
        `cleanup_failed worktree=${input.session.worktreePath} error=${redactSensitiveText(
          error.message,
          input.secretValues ?? [],
        )}`,
        input.context.job.jobId,
      )
      return
    }
    throw error
  }
}
