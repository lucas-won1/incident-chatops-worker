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

export interface MergeRequestProvider {
  createMergeRequest(input: CreateMergeRequestInput): Promise<CreateMergeRequestResult>
}

export type MergeRequestAuditEvent =
  | {
      readonly action: "merge_request.create.requested"
      readonly draft: boolean
      readonly labels: readonly string[]
      readonly project: string
      readonly sourceBranch: string
      readonly targetBranch: string
    }
  | {
      readonly action: "merge_request.create.succeeded"
      readonly project: string
      readonly statusCode: number
      readonly url: string
    }
  | {
      readonly action: "merge_request.create.failed"
      readonly kind: GitLabMergeRequestApiErrorKind | "parse"
      readonly project: string
      readonly statusCode: number | undefined
    }

export type GitLabMergeRequestApiErrorKind =
  | "authentication"
  | "conflict"
  | "not_found"
  | "server"
  | "unexpected"
