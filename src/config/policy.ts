import path from "node:path"

import { parse as parseYaml } from "yaml"
import { ZodError, z } from "zod"
import type { WorkerEnv } from "./env.js"
import { ConfigValidationError } from "./errors.js"
import {
  type GitHubConfig,
  type GitLabConfig,
  type GitProvider,
  gitHubConfigSchema,
  gitLabConfigSchema,
  gitProviderSchema,
  normalizeGitHubConfig,
  normalizeGitLabConfig,
} from "./provider.js"

const secretKeyPattern = /(?:token|secret|password|credential|api[_-]?key|auth)/iu
const secretValuePattern =
  /(?:xox[abprs]-|xapp-|glpat-|github_pat_|gh[opusr]_|sntrys_|sentry[a-z0-9_-]*_)/iu
const safeId = /^[A-Za-z][A-Za-z0-9_-]*$/u
const safeCommand = /^[A-Za-z0-9._/-]+$/u
const safeBranchPrefix = /^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const findYamlSecret = (value: unknown, pathParts: readonly string[] = []): string | undefined => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findYamlSecret(item, [...pathParts, String(index)])
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }

  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...pathParts, key]
      if (secretKeyPattern.test(key)) {
        return nextPath.join(".")
      }
      const result = findYamlSecret(item, nextPath)
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }

  if (typeof value === "string" && secretValuePattern.test(value)) {
    return pathParts.join(".")
  }

  return undefined
}

const nonEmptyString = z.string().min(1)

const absoluteSafePath = z.string().superRefine((value, context) => {
  if (!path.isAbsolute(value)) {
    context.addIssue({ code: "custom", message: "must be an absolute path" })
  }
  if (value.includes("..") || value.includes("\0")) {
    context.addIssue({ code: "custom", message: "must not contain traversal or NUL bytes" })
  }
})

const branchPrefixSchema = z.string().superRefine((value, context) => {
  if (!safeBranchPrefix.test(value) || value.includes("..") || value.includes("//")) {
    context.addIssue({ code: "custom", message: "branch prefix is unsafe" })
  }
})

const commandSchema = z.string().superRefine((value, context) => {
  if (!safeCommand.test(value) || value.includes("..")) {
    context.addIssue({ code: "custom", message: "command contains unsafe characters" })
  }
})

const runnerDefinitionSchema = z.object({
  args: z.array(nonEmptyString).default([]),
  command: commandSchema,
  id: z.string().regex(safeId),
  type: z.literal("generic"),
})

const policySchema = z
  .object({
    branch: z.object({
      prefix: branchPrefixSchema,
    }),
    mr: z
      .object({
        defaultTargetBranch: nonEmptyString,
        github: gitHubConfigSchema.optional(),
        gitlab: gitLabConfigSchema.optional(),
        provider: gitProviderSchema.default("gitlab"),
      })
      .superRefine((value, context) => {
        switch (value.provider) {
          case "gitlab":
            if (value.gitlab === undefined) {
              context.addIssue({
                code: "custom",
                message: "GitLab routing is required when mr.provider is gitlab",
                path: ["gitlab"],
              })
            }
            return
          case "github":
            if (value.github === undefined) {
              context.addIssue({
                code: "custom",
                message: "GitHub routing is required when mr.provider is github",
                path: ["github"],
              })
            }
            return
        }
      }),
    repos: z.object({
      allowlist: z.array(absoluteSafePath).min(1, "repo allowlist must not be empty"),
    }),
    runners: z.object({
      definitions: z.array(runnerDefinitionSchema).min(1, "runner definitions must not be empty"),
      genericCommandAllowlist: z
        .array(commandSchema)
        .min(1, "generic command allowlist must not be empty"),
    }),
    sentry: z.object({
      projects: z
        .array(
          z.object({
            organizationSlug: nonEmptyString,
            projectSlug: nonEmptyString,
            slackChannel: z.string().regex(/^#[A-Za-z0-9_-]+$/u),
          }),
        )
        .min(1, "Sentry project mappings must not be empty"),
    }),
    slack: z.object({
      channels: z.object({
        default: z.string().regex(/^#[A-Za-z0-9_-]+$/u),
        routing: z.record(z.string(), z.string().regex(/^#[A-Za-z0-9_-]+$/u)).default({}),
      }),
    }),
    worktree: z.object({
      root: absoluteSafePath,
    }),
  })
  .superRefine((value, context) => {
    for (const runner of value.runners.definitions) {
      if (!value.runners.genericCommandAllowlist.includes(runner.command)) {
        context.addIssue({
          code: "custom",
          message: `runner command ${runner.command} is outside generic command allowlist`,
          path: ["runners", "definitions", runner.id, "command"],
        })
      }
    }
  })

export type SentryProjectMapping = {
  readonly organizationSlug: string
  readonly projectSlug: string
  readonly slackChannel: string
}

export type RunnerDefinition = {
  readonly args: readonly string[]
  readonly command: string
  readonly id: string
  readonly type: "generic"
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
    readonly definitions: readonly RunnerDefinition[]
    readonly genericCommandAllowlist: readonly string[]
  }
  readonly sentryProjects: readonly SentryProjectMapping[]
  readonly slack: {
    readonly channels: {
      readonly default: string
      readonly routing: Readonly<Record<string, string>>
    }
  }
  readonly worktreeRoot: string
}

const policyIssue = (issue: {
  readonly path: readonly PropertyKey[]
  readonly message: string
}): string => {
  const key = issue.path.join(".")
  return key.length > 0 ? `${key}: ${issue.message}` : issue.message
}

export const parseWorkerConfigYaml = (source: string, _env: WorkerEnv): WorkerConfig => {
  let rawYaml: unknown
  try {
    rawYaml = parseYaml(source)
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigValidationError(`Invalid YAML config: ${error.message}`)
    }
    throw error
  }

  const secretPath = findYamlSecret(rawYaml)
  if (secretPath !== undefined) {
    throw new ConfigValidationError(`YAML config must not contain secrets at ${secretPath}`)
  }

  try {
    const parsed = policySchema.parse(rawYaml)
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
        definitions: parsed.runners.definitions,
        genericCommandAllowlist: parsed.runners.genericCommandAllowlist,
      },
      sentryProjects: parsed.sentry.projects,
      slack: parsed.slack,
      worktreeRoot: parsed.worktree.root,
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(policyIssue)
      throw new ConfigValidationError(`Invalid YAML config: ${issues.join("; ")}`, issues)
    }
    throw error
  }
}
