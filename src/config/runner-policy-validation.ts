import path from "node:path"

import { z } from "zod"

export const safeId = /^[A-Za-z][A-Za-z0-9_-]*$/u

const safeCommand = /^[A-Za-z0-9._/-]+$/u
const safeEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/u
const secretEnvNamePattern = /(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|CREDENTIAL)/iu

export const nonEmptyString = z.string().min(1)

export const absoluteSafePath = z.string().superRefine((value, context) => {
  if (!path.isAbsolute(value)) {
    context.addIssue({ code: "custom", message: "must be an absolute path" })
  }
  if (value.includes("..") || value.includes("\0")) {
    context.addIssue({ code: "custom", message: "must not contain traversal or NUL bytes" })
  }
})

export const commandSchema = z.string().superRefine((value, context) => {
  if (!safeCommand.test(value) || value.includes("..")) {
    context.addIssue({ code: "custom", message: "command contains unsafe characters" })
  }
})

const envAllowlistNameSchema = z
  .string()
  .regex(safeEnvName)
  .superRefine((value, context) => {
    if (secretEnvNamePattern.test(value)) {
      context.addIssue({
        code: "custom",
        message: `runner env allowlist name ${value} looks like a secret`,
      })
    }
  })

export const extraEnvAllowlistSchema = z.array(envAllowlistNameSchema).default([])

const forbiddenClaudePermissionTokens = [
  "bypasspermissions",
  "--dangerously-bypass-",
  "dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
] as const

const containsForbiddenClaudePermissionToken = (value: string): boolean => {
  const lowered = value.toLowerCase()
  return forbiddenClaudePermissionTokens.some((token) => lowered.includes(token))
}

export const claudePermissionModeSchema = nonEmptyString.superRefine((value, context) => {
  if (containsForbiddenClaudePermissionToken(value)) {
    context.addIssue({
      code: "custom",
      message: "Claude Code permissionMode permission bypass is not allowed",
    })
  }
})

const claudeToolNameSchema = nonEmptyString.superRefine((value, context) => {
  if (containsForbiddenClaudePermissionToken(value)) {
    context.addIssue({
      code: "custom",
      message: "Claude Code tool permission bypass is not allowed",
    })
  }
})

export const claudeToolPolicySchema = z.array(claudeToolNameSchema).default([])
