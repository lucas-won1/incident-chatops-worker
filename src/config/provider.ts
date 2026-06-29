import { z } from "zod"

const providerLabel = z.string().min(1)
const safeGitLabProject = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/u
const safeGitHubName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u
const defaultProviderLabels = ["incident-chatops"] as const

const gitLabProjectSchema = z.string().superRefine((value, context) => {
  if (!safeGitLabProject.test(value) || value.includes("..") || value.includes("//")) {
    context.addIssue({ code: "custom", message: "GitLab project path is unsafe" })
  }
})

const gitHubNameSchema = z.string().superRefine((value, context) => {
  if (!safeGitHubName.test(value) || value.includes("..")) {
    context.addIssue({ code: "custom", message: "GitHub repository name is unsafe" })
  }
})

export const gitProviderSchema = z.union([z.literal("gitlab"), z.literal("github")])

export const gitLabConfigSchema = z.object({
  baseUrl: z.url(),
  defaultLabels: z.array(providerLabel).optional(),
  draft: z.boolean().optional(),
  project: gitLabProjectSchema,
})

export const gitHubConfigSchema = z.object({
  baseUrl: z.url().default("https://api.github.com"),
  defaultLabels: z.array(providerLabel).optional(),
  draft: z.boolean().optional(),
  owner: gitHubNameSchema,
  repo: gitHubNameSchema,
})

export type GitProvider = z.infer<typeof gitProviderSchema>

export type GitLabConfig = {
  readonly baseUrl: string
  readonly defaultLabels: readonly string[]
  readonly draft: boolean
  readonly project: string
}

export type GitHubConfig = {
  readonly baseUrl: string
  readonly defaultLabels: readonly string[]
  readonly draft: boolean
  readonly owner: string
  readonly repo: string
}

export const normalizeGitLabConfig = (
  config: z.infer<typeof gitLabConfigSchema>,
): GitLabConfig => ({
  baseUrl: config.baseUrl,
  defaultLabels: config.defaultLabels ?? defaultProviderLabels,
  draft: config.draft ?? false,
  project: config.project,
})

export const normalizeGitHubConfig = (
  config: z.infer<typeof gitHubConfigSchema>,
): GitHubConfig => ({
  baseUrl: config.baseUrl,
  defaultLabels: config.defaultLabels ?? defaultProviderLabels,
  draft: config.draft ?? false,
  owner: config.owner,
  repo: config.repo,
})
