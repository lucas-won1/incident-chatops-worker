import type { GitLabMergeRequestApiErrorKind } from "./types.js"

export class GitLabMergeRequestApiError extends Error {
  public readonly kind: GitLabMergeRequestApiErrorKind
  public readonly name = "GitLabMergeRequestApiError"
  public readonly statusCode: number

  public constructor(kind: GitLabMergeRequestApiErrorKind, statusCode: number) {
    super(messageForApiError(kind, statusCode))
    this.kind = kind
    this.statusCode = statusCode
  }
}

export class GitLabMergeRequestParseError extends Error {
  public readonly name = "GitLabMergeRequestParseError"
  public readonly statusCode: number

  public constructor(statusCode: number) {
    super(`Malformed GitLab merge request response with HTTP ${statusCode}`)
    this.statusCode = statusCode
  }
}

const messageForApiError = (kind: GitLabMergeRequestApiErrorKind, statusCode: number): string => {
  switch (kind) {
    case "authentication":
      return `GitLab merge request authentication failed with HTTP ${statusCode}`
    case "conflict":
      return `GitLab merge request conflict with HTTP ${statusCode}`
    case "not_found":
      return `GitLab merge request project not found with HTTP ${statusCode}`
    case "server":
      return `GitLab merge request server error with HTTP ${statusCode}`
    case "unexpected":
      return `GitLab merge request request failed with HTTP ${statusCode}`
  }
}

export const gitLabErrorKindForStatus = (statusCode: number): GitLabMergeRequestApiErrorKind => {
  switch (statusCode) {
    case 401:
    case 403:
      return "authentication"
    case 404:
      return "not_found"
    case 409:
      return "conflict"
    default:
      return statusCode >= 500 ? "server" : "unexpected"
  }
}
