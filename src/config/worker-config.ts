import type { ParsedPolicyConfig } from "./policy-schema.js"
import {
  type GitHubConfig,
  type GitLabConfig,
  type GitProvider,
  normalizeGitHubConfig,
  normalizeGitLabConfig,
} from "./provider.js"
import type {
  ClaudeCodeRunnerConfig,
  CodexRunnerConfig,
  GenericRunnerConfig,
  ProjectEnvironmentConfig,
  RunnerDefinition,
  RunnerProvider,
} from "./runner-policy.js"

export type WorktreePrepareCommand = {
  readonly args: readonly string[]
  readonly command: string
}

export type WorktreePrepareConfig = {
  readonly commands: readonly WorktreePrepareCommand[]
  readonly timeoutMs: number
}

export type SentryProjectMapping = {
  readonly organizationSlug: string
  readonly projectSlug: string
  readonly slackChannel: string
}

export type WorkerConfig = {
  readonly branchPrefix: string
  readonly mr: {
    readonly defaultTargetBranch: string
    readonly github?: GitHubConfig
    readonly gitlab?: GitLabConfig
    readonly provider: GitProvider
  }
  readonly repos: {
    readonly allowlist: readonly string[]
  }
  readonly runners: {
    readonly claudeCode: ClaudeCodeRunnerConfig
    readonly codex: CodexRunnerConfig
    readonly definitions: readonly RunnerDefinition[]
    readonly generic: GenericRunnerConfig
    readonly genericCommandAllowlist: readonly string[]
    readonly projectEnv?: ProjectEnvironmentConfig
    readonly provider: RunnerProvider
  }
  readonly sentryProjects: readonly SentryProjectMapping[]
  readonly slack: {
    readonly channels: {
      readonly default: string
      readonly routing: Readonly<Record<string, string>>
    }
  }
  readonly worktreeRoot: string
  readonly worktreePrepare: WorktreePrepareConfig
}

export const buildWorkerConfig = (parsed: ParsedPolicyConfig): WorkerConfig => {
  const gitlab =
    parsed.mr.gitlab === undefined
      ? {}
      : {
          gitlab: normalizeGitLabConfig(parsed.mr.gitlab),
        }
  const github =
    parsed.mr.github === undefined
      ? {}
      : {
          github: normalizeGitHubConfig(parsed.mr.github),
        }
  const projectEnv =
    parsed.runners.projectEnv === undefined ? {} : { projectEnv: parsed.runners.projectEnv }

  return {
    branchPrefix: parsed.branch.prefix,
    mr: {
      defaultTargetBranch: parsed.mr.defaultTargetBranch,
      ...github,
      ...gitlab,
      provider: parsed.mr.provider,
    },
    repos: {
      allowlist: parsed.repos.allowlist,
    },
    runners: {
      claudeCode: parsed.runners.claudeCode,
      codex: parsed.runners.codex,
      definitions: parsed.runners.definitions,
      generic: parsed.runners.generic,
      genericCommandAllowlist: parsed.runners.genericCommandAllowlist,
      ...projectEnv,
      provider: parsed.runners.provider,
    },
    sentryProjects: parsed.sentry.projects,
    slack: parsed.slack,
    worktreePrepare: parsed.worktree.prepare,
    worktreeRoot: parsed.worktree.root,
  }
}
