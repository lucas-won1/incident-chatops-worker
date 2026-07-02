export type CreateMergeRequestInput = {
  readonly bodyTemplate: string
  readonly draft: boolean
  readonly labels: readonly string[]
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly titleTemplate: string
}

export type CreateMergeRequestResult = {
  readonly url: string
}

export type MergeRequestProviderId = "gitlab" | "github"

export interface MergeRequestProvider {
  readonly provider: MergeRequestProviderId
  createMergeRequest(input: CreateMergeRequestInput): Promise<CreateMergeRequestResult>
}

type MergeRequestAuditBase = {
  readonly project?: string
  readonly provider: MergeRequestProviderId
  readonly repository: string
}

export type MergeRequestApiErrorKind = GitLabMergeRequestApiErrorKind

export type MergeRequestAuditStage = "create" | "labels"

export type MergeRequestAuditEvent =
  | (MergeRequestAuditBase & {
      readonly action: "merge_request.create.requested"
      readonly draft: boolean
      readonly labels: readonly string[]
      readonly sourceBranch: string
      readonly targetBranch: string
    })
  | (MergeRequestAuditBase & {
      readonly action: "merge_request.create.succeeded"
      readonly stage?: MergeRequestAuditStage
      readonly statusCode: number
      readonly url: string
    })
  | (MergeRequestAuditBase & {
      readonly action: "merge_request.create.failed"
      readonly kind: MergeRequestApiErrorKind | "parse"
      readonly stage?: MergeRequestAuditStage
      readonly statusCode: number | undefined
    })
  | (MergeRequestAuditBase & {
      readonly action: "merge_request.labels.succeeded"
      readonly stage: "labels"
      readonly statusCode: number
    })
  | (MergeRequestAuditBase & {
      readonly action: "merge_request.labels.failed"
      readonly kind: MergeRequestApiErrorKind | "transport"
      readonly stage: "labels"
      readonly statusCode: number | undefined
    })

export type GitLabMergeRequestApiErrorKind =
  | "authentication"
  | "conflict"
  | "not_found"
  | "server"
  | "unexpected"
