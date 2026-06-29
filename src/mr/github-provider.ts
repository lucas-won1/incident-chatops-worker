import ky from "ky"
import { ZodError, z } from "zod"

import { gitLabErrorKindForStatus } from "./errors.js"
import type {
  CreateMergeRequestInput,
  CreateMergeRequestResult,
  MergeRequestApiErrorKind,
  MergeRequestAuditEvent,
  MergeRequestProvider,
} from "./types.js"

const gitHubPullRequestResponseSchema = z.object({
  html_url: z.url(),
  number: z.number().int().positive(),
})

export class GitHubPullRequestApiError extends Error {
  public readonly kind: MergeRequestApiErrorKind
  public readonly name = "GitHubPullRequestApiError"
  public readonly statusCode: number

  public constructor(
    kind: MergeRequestApiErrorKind,
    statusCode: number,
    stage: "create" | "labels",
  ) {
    super(`GitHub pull request ${stage} failed with HTTP ${statusCode}`)
    this.kind = kind
    this.statusCode = statusCode
  }
}

export class GitHubPullRequestParseError extends Error {
  public readonly name = "GitHubPullRequestParseError"
  public readonly statusCode: number

  public constructor(statusCode: number) {
    super(`Malformed GitHub pull request response with HTTP ${statusCode}`)
    this.statusCode = statusCode
  }
}

export type GitHubPullRequestProviderOptions = {
  readonly audit?: (event: MergeRequestAuditEvent) => void
  readonly baseUrl: string
  readonly owner: string
  readonly repo: string
  readonly timeoutMs?: number
  readonly token: string
}

const trimTrailingSlash = (value: string): string => value.replace(/\/$/u, "")

const renderPullRequestTemplate = (
  template: string,
  input: Pick<CreateMergeRequestInput, "sourceBranch" | "targetBranch">,
): string =>
  template
    .replaceAll("{sourceBranch}", input.sourceBranch)
    .replaceAll("{targetBranch}", input.targetBranch)

const repositoryPath = (
  options: Pick<GitHubPullRequestProviderOptions, "owner" | "repo">,
): string => `${options.owner}/${options.repo}`

export const createGitHubPullRequestProvider = (
  options: GitHubPullRequestProviderOptions,
): MergeRequestProvider => {
  const repository = repositoryPath(options)
  const client = ky.create({
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    prefix: trimTrailingSlash(options.baseUrl),
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
    timeout: options.timeoutMs ?? 10000,
  })

  return {
    provider: "github",
    createMergeRequest: async (
      input: CreateMergeRequestInput,
    ): Promise<CreateMergeRequestResult> => {
      options.audit?.({
        action: "merge_request.create.requested",
        draft: input.draft,
        labels: input.labels,
        provider: "github",
        repository,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
      })

      const createResponse = await client.post(`repos/${options.owner}/${options.repo}/pulls`, {
        json: {
          base: input.targetBranch,
          body: renderPullRequestTemplate(input.bodyTemplate, input),
          draft: input.draft,
          head: input.sourceBranch,
          title: renderPullRequestTemplate(input.titleTemplate, input),
        },
      })

      if (createResponse.status !== 201) {
        const kind = gitLabErrorKindForStatus(createResponse.status)
        options.audit?.({
          action: "merge_request.create.failed",
          kind,
          provider: "github",
          repository,
          stage: "create",
          statusCode: createResponse.status,
        })
        throw new GitHubPullRequestApiError(kind, createResponse.status, "create")
      }

      try {
        const body = await createResponse.json()
        const parsed = gitHubPullRequestResponseSchema.parse(body)
        options.audit?.({
          action: "merge_request.create.succeeded",
          provider: "github",
          repository,
          stage: "create",
          statusCode: createResponse.status,
          url: parsed.html_url,
        })

        if (input.labels.length > 0) {
          const labelsResponse = await client.post(
            `repos/${options.owner}/${options.repo}/issues/${parsed.number}/labels`,
            {
              json: {
                labels: input.labels,
              },
            },
          )
          if (!labelsResponse.ok) {
            const kind = gitLabErrorKindForStatus(labelsResponse.status)
            options.audit?.({
              action: "merge_request.labels.failed",
              kind,
              provider: "github",
              repository,
              stage: "labels",
              statusCode: labelsResponse.status,
            })
            throw new GitHubPullRequestApiError(kind, labelsResponse.status, "labels")
          }
          options.audit?.({
            action: "merge_request.labels.succeeded",
            provider: "github",
            repository,
            stage: "labels",
            statusCode: labelsResponse.status,
          })
        }

        return { url: parsed.html_url }
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          options.audit?.({
            action: "merge_request.create.failed",
            kind: "parse",
            provider: "github",
            repository,
            stage: "create",
            statusCode: createResponse.status,
          })
          throw new GitHubPullRequestParseError(createResponse.status)
        }
        throw error
      }
    },
  }
}
