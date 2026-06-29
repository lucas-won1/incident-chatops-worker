import type { WorkerSettings } from "../config/index.js"
import { ConfigValidationError } from "../config/index.js"
import {
  createGitHubPullRequestProvider,
  createGitLabMergeRequestProvider,
  type GitHubPullRequestProviderOptions,
  type GitLabMergeRequestProviderOptions,
  type MergeRequestProvider,
} from "../mr/index.js"

export type SelectedMergeRequestProviderOptions =
  | (GitLabMergeRequestProviderOptions & { readonly provider: "gitlab" })
  | (GitHubPullRequestProviderOptions & { readonly provider: "github" })

export type MergeRequestProviderFactory = (
  options: SelectedMergeRequestProviderOptions,
) => MergeRequestProvider

const assertNever = (value: never): never => {
  throw new ConfigValidationError(`Unsupported merge request provider: ${value}`)
}

const selectedProviderToken = (settings: WorkerSettings): string => {
  switch (settings.config.mr.provider) {
    case "gitlab":
      return settings.env.gitlabToken
    case "github":
      return settings.env.githubToken
    default:
      return assertNever(settings.config.mr.provider)
  }
}

export const serviceTokenEnvNames = [
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
] as const

export const daemonSecretValues = (settings: WorkerSettings): readonly string[] => [
  selectedProviderToken(settings),
  settings.env.sentryAuthToken,
  settings.env.slackAppToken,
  settings.env.slackBotToken,
]

export const selectedMergeRequestProviderOptions = (
  settings: WorkerSettings,
): SelectedMergeRequestProviderOptions => {
  switch (settings.config.mr.provider) {
    case "gitlab": {
      const gitlab = settings.config.mr.gitlab
      if (gitlab === undefined) {
        throw new ConfigValidationError("GitLab routing is required when mr.provider is gitlab")
      }
      return {
        baseUrl: gitlab.baseUrl,
        project: gitlab.project,
        provider: "gitlab",
        token: settings.env.gitlabToken,
      }
    }
    case "github": {
      const github = settings.config.mr.github
      if (github === undefined) {
        throw new ConfigValidationError("GitHub routing is required when mr.provider is github")
      }
      return {
        baseUrl: github.baseUrl,
        owner: github.owner,
        provider: "github",
        repo: github.repo,
        token: settings.env.githubToken,
      }
    }
    default:
      return assertNever(settings.config.mr.provider)
  }
}

export const selectedMergeRequestDefaults = (
  settings: WorkerSettings,
): { readonly draft: boolean; readonly labels: readonly string[] } => {
  switch (settings.config.mr.provider) {
    case "gitlab": {
      const gitlab = settings.config.mr.gitlab
      if (gitlab === undefined) {
        throw new ConfigValidationError("GitLab routing is required when mr.provider is gitlab")
      }
      return { draft: gitlab.draft, labels: gitlab.defaultLabels }
    }
    case "github": {
      const github = settings.config.mr.github
      if (github === undefined) {
        throw new ConfigValidationError("GitHub routing is required when mr.provider is github")
      }
      return { draft: github.draft, labels: github.defaultLabels }
    }
    default:
      return assertNever(settings.config.mr.provider)
  }
}

export const createSelectedMergeRequestProvider: MergeRequestProviderFactory = (options) => {
  switch (options.provider) {
    case "gitlab":
      return createGitLabMergeRequestProvider(options)
    case "github":
      return createGitHubPullRequestProvider(options)
    default:
      return assertNever(options)
  }
}
