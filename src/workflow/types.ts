import type { CreateMergeRequestInput, MergeRequestProvider } from "../mr/types.js"
import type { PushGitBranchRequest } from "../repo/local-git.js"
import type {
  RunnerAdapter,
  RunnerIncidentContext,
  RunnerRequest,
  RunnerResult,
} from "../runner/types.js"
import type { SlackActionIntent } from "../slack/action-payload.js"
import type { SlackRenderedMessage } from "../slack/block-kit.js"
import type {
  AnalysisSummaryInput,
  AnalysisSummaryRecord,
  AuditEntryInput,
  CompleteJobInput,
  IncidentInput,
  IncidentRecord,
  IncidentUpsertResult,
  JobClaimInput,
  JobClaimRecord,
  MrLinkInput,
  SentryIssueSnapshotInput,
  SentryIssueSnapshotRecord,
  VerificationSummaryInput,
  VerificationSummaryRecord,
} from "../state/types.js"

export type WorkflowDetectedIncident = IncidentInput & {
  readonly repoPath: string
  readonly culprit?: string
  readonly permalink?: string
}

export type WorkflowStateStore = {
  readonly upsertIncident: (input: IncidentInput) => IncidentUpsertResult
  readonly getIncidentByIssueId: (issueId: string) => IncidentRecord | undefined
  readonly updateIncidentThreadTs: (input: {
    readonly incidentId: string
    readonly threadTs: string
    readonly updatedAt: string
  }) => void
  readonly updateIncidentWorkflowState: (input: {
    readonly incidentId: string
    readonly workflowState: string
    readonly updatedAt: string
  }) => void
  readonly claimJobForSlackAction: (input: JobClaimInput) => JobClaimRecord
  readonly completeJob: (input: CompleteJobInput) => void
  readonly saveAnalysisSummary: (input: AnalysisSummaryInput) => AnalysisSummaryRecord
  readonly getLatestAnalysisSummary: (incidentId: string) => AnalysisSummaryRecord | undefined
  readonly saveSentryIssueSnapshot?: (input: SentryIssueSnapshotInput) => SentryIssueSnapshotRecord
  readonly getLatestSentryIssueSnapshot?: (
    incidentId: string,
  ) => SentryIssueSnapshotRecord | undefined
  readonly saveVerificationSummary: (input: VerificationSummaryInput) => VerificationSummaryRecord
  readonly getLatestVerificationSummary: (
    incidentId: string,
  ) => VerificationSummaryRecord | undefined
  readonly saveMrLink: (input: MrLinkInput) => void
  readonly appendAuditEntry: (input: AuditEntryInput) => unknown
}

export type WorkflowSentryContextProvider = {
  readonly fetchIssueContext: (incident: IncidentRecord) => Promise<RunnerIncidentContext>
}

export type WorkflowSlackPostResult = {
  readonly ts?: string
}

export type WorkflowSlackPublisher = {
  readonly postMessage: (message: SlackRenderedMessage) => Promise<WorkflowSlackPostResult>
}

export type WorkflowWorktreeSession = {
  readonly branchName: string
  readonly repoPath: string
  readonly worktreePath: string
  readonly close: () => Promise<void>
}

export type WorkflowRepoAdapter = {
  readonly openWorktree: (request: {
    readonly branchName: string
    readonly jobId: string
    readonly repoPath: string
  }) => Promise<WorkflowWorktreeSession>
  readonly pushBranch: (request: PushGitBranchRequest) => Promise<void>
}

export type IncidentWorkflowOptions = {
  readonly allowedRunnerCommands?: readonly string[]
  readonly branchPrefix: string
  readonly defaultTargetBranch: string
  readonly mrProvider: MergeRequestProvider
  readonly mrDefaults?: {
    readonly draft: boolean
    readonly labels: readonly string[]
  }
  readonly remoteName: string
  readonly repo: WorkflowRepoAdapter
  readonly repoPaths: Readonly<Record<string, string>>
  readonly runner: RunnerAdapter<RunnerRequest>
  readonly sentryContext?: WorkflowSentryContextProvider
  readonly sentryContextSecretValues?: readonly string[]
  readonly slack: WorkflowSlackPublisher
  readonly state: WorkflowStateStore
}

export type WorkflowActionResult =
  | {
      readonly kind: "handled"
      readonly jobId?: string
    }
  | {
      readonly kind: "duplicate"
      readonly jobId?: string
    }
  | {
      readonly kind: "closed"
    }

export type WorkflowJobContext = {
  readonly actor: string
  readonly branchName: string
  readonly incident: IncidentRecord
  readonly intent: SlackActionIntent
  readonly job: JobClaimRecord
  readonly repoPath: string
}

export type WorkflowFixSuccess = {
  readonly branchName: string
  readonly mrInput: CreateMergeRequestInput
  readonly mrUrl: string
  readonly result: RunnerResult
}
