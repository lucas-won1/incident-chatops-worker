import ky from "ky"
import { ZodError, z } from "zod"

import {
  GitLabMergeRequestApiError,
  GitLabMergeRequestParseError,
  gitLabErrorKindForStatus,
} from "./errors.js"
import type {
  CreateMergeRequestInput,
  CreateMergeRequestResult,
  MergeRequestAuditEvent,
  MergeRequestProvider,
} from "./types.js"

const gitLabMergeRequestResponseSchema = z.object({
  web_url: z.url(),
})

export type GitLabMergeRequestProviderOptions = {
  readonly audit?: (event: MergeRequestAuditEvent) => void
  readonly baseUrl: string
  readonly project: string
  readonly timeoutMs?: number
  readonly token: string
}

const trimTrailingSlash = (value: string): string => value.replace(/\/$/u, "")

const renderMergeRequestTemplate = (
  template: string,
  input: Pick<CreateMergeRequestInput, "sourceBranch" | "targetBranch">,
): string =>
  template
    .replaceAll("{sourceBranch}", input.sourceBranch)
    .replaceAll("{targetBranch}", input.targetBranch)

const gitLabDraftTitlePattern = /^(?:draft:|\[draft\]|\(draft\))/iu

const mergeRequestTitle = (input: CreateMergeRequestInput): string => {
  const title = renderMergeRequestTemplate(input.titleTemplate, input)
  if (!input.draft || gitLabDraftTitlePattern.test(title)) {
    return title
  }
  return `Draft: ${title}`
}

export const createGitLabMergeRequestProvider = (
  options: GitLabMergeRequestProviderOptions,
): MergeRequestProvider => {
  const client = ky.create({
    headers: {
      "PRIVATE-TOKEN": options.token,
    },
    prefix: trimTrailingSlash(options.baseUrl),
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
    timeout: options.timeoutMs ?? 10000,
  })

  return {
    provider: "gitlab",
    createMergeRequest: async (
      input: CreateMergeRequestInput,
    ): Promise<CreateMergeRequestResult> => {
      options.audit?.({
        action: "merge_request.create.requested",
        draft: input.draft,
        labels: input.labels,
        project: options.project,
        provider: "gitlab",
        repository: options.project,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
      })

      const response = await client.post(
        `projects/${encodeURIComponent(options.project)}/merge_requests`,
        {
          json: {
            description: renderMergeRequestTemplate(input.bodyTemplate, input),
            labels: input.labels.join(","),
            source_branch: input.sourceBranch,
            target_branch: input.targetBranch,
            title: mergeRequestTitle(input),
          },
        },
      )

      if (!response.ok) {
        const kind = gitLabErrorKindForStatus(response.status)
        options.audit?.({
          action: "merge_request.create.failed",
          kind,
          project: options.project,
          provider: "gitlab",
          repository: options.project,
          statusCode: response.status,
        })
        throw new GitLabMergeRequestApiError(kind, response.status)
      }

      try {
        const body = await response.json()
        const parsed = gitLabMergeRequestResponseSchema.parse(body)
        options.audit?.({
          action: "merge_request.create.succeeded",
          project: options.project,
          provider: "gitlab",
          repository: options.project,
          statusCode: response.status,
          url: parsed.web_url,
        })
        return { url: parsed.web_url }
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          options.audit?.({
            action: "merge_request.create.failed",
            kind: "parse",
            project: options.project,
            provider: "gitlab",
            repository: options.project,
            statusCode: response.status,
          })
          throw new GitLabMergeRequestParseError(response.status)
        }
        throw error
      }
    },
  }
}
