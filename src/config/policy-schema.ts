import { z } from "zod"

import { gitHubConfigSchema, gitLabConfigSchema, gitProviderSchema } from "./provider.js"
import { runnersSchema } from "./runner-policy.js"
import { absoluteSafePath, commandSchema, nonEmptyString } from "./runner-policy-validation.js"

const safeBranchPrefix = /^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u

const branchPrefixSchema = z.string().superRefine((value, context) => {
  if (!safeBranchPrefix.test(value) || value.includes("..") || value.includes("//")) {
    context.addIssue({ code: "custom", message: "branch prefix is unsafe" })
  }
})

const worktreePrepareCommandSchema = z.object({
  args: z.array(nonEmptyString).default([]),
  command: commandSchema,
})

const worktreePrepareSchema = z
  .object({
    commands: z.array(worktreePrepareCommandSchema).default([]),
    timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
  })
  .default({ commands: [], timeoutMs: 600_000 })

export const policySchema = z.object({
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
  runners: runnersSchema,
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
    prepare: worktreePrepareSchema,
    root: absoluteSafePath,
  }),
})

export type ParsedPolicyConfig = z.infer<typeof policySchema>
