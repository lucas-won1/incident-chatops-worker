import { z } from "zod"

import {
  absoluteSafePath,
  claudePermissionModeSchema,
  claudeToolPolicySchema,
  commandSchema,
  extraEnvAllowlistSchema,
  nonEmptyString,
  safeId,
} from "./runner-policy-validation.js"

const runnerDefinitionSchema = z.object({
  args: z.array(nonEmptyString).default([]),
  command: commandSchema,
  id: z.string().regex(safeId),
  type: z.literal("generic"),
})

export type RunnerProvider = "codex" | "claude-code" | "generic"

export type RunnerDefinition = {
  readonly args: readonly string[]
  readonly command: string
  readonly id: string
  readonly type: "generic"
}

export type ProjectEnvironmentConfig = {
  readonly args: readonly string[]
  readonly command: string
}

export type CodexRunnerConfig = {
  readonly bin?: string | undefined
  readonly extraEnvAllowlist: readonly string[]
  readonly home?: string | undefined
  readonly model?: string | undefined
  readonly outputRoot?: string | undefined
  readonly profile?: string | undefined
  readonly workspaceWriteNetworkAccess: boolean
}

export type ClaudeCodeRunnerConfig = {
  readonly allowedTools: readonly string[]
  readonly bin?: string | undefined
  readonly configDir?: string | undefined
  readonly disallowedTools: readonly string[]
  readonly extraEnvAllowlist: readonly string[]
  readonly model?: string | undefined
  readonly permissionMode?: string | undefined
  readonly settingsPath?: string | undefined
}

export type GenericRunnerConfig = {
  readonly analysisCommandId?: string
  readonly commandAllowlist: readonly string[]
  readonly definitions: readonly RunnerDefinition[]
  readonly fixCommandId?: string
}

const runnerProviderSchema = z.union([
  z.literal("codex"),
  z.literal("claude-code"),
  z.literal("generic"),
])

const projectEnvironmentConfigSchema = z.object({
  args: z.array(nonEmptyString).default([]),
  command: commandSchema,
})

const unsupportedCodexModeFieldSchema = z.unknown().superRefine((_value, context) => {
  context.addIssue({
    code: "custom",
    message:
      "runners.codex.mode is no longer supported; remove it because Codex runner execution is CLI-only",
  })
})

const codexRunnerConfigSchema = z
  .object({
    bin: commandSchema.optional(),
    extraEnvAllowlist: extraEnvAllowlistSchema,
    home: absoluteSafePath.optional(),
    mode: unsupportedCodexModeFieldSchema.optional(),
    model: nonEmptyString.optional(),
    outputRoot: absoluteSafePath.optional(),
    profile: nonEmptyString.optional(),
    workspaceWriteNetworkAccess: z.boolean().default(false),
  })
  .transform(
    (value): CodexRunnerConfig => ({
      ...(value.bin === undefined ? {} : { bin: value.bin }),
      extraEnvAllowlist: value.extraEnvAllowlist,
      ...(value.home === undefined ? {} : { home: value.home }),
      ...(value.model === undefined ? {} : { model: value.model }),
      ...(value.outputRoot === undefined ? {} : { outputRoot: value.outputRoot }),
      ...(value.profile === undefined ? {} : { profile: value.profile }),
      workspaceWriteNetworkAccess: value.workspaceWriteNetworkAccess,
    }),
  )

const claudeCodeRunnerConfigSchema = z.object({
  allowedTools: claudeToolPolicySchema,
  bin: commandSchema.optional(),
  configDir: absoluteSafePath.optional(),
  disallowedTools: claudeToolPolicySchema,
  extraEnvAllowlist: extraEnvAllowlistSchema,
  model: nonEmptyString.optional(),
  permissionMode: claudePermissionModeSchema.optional(),
  settingsPath: absoluteSafePath.optional(),
})

const genericRunnerConfigInputSchema = z.object({
  analysisCommandId: z.string().regex(safeId).optional(),
  commandAllowlist: z
    .array(commandSchema)
    .min(1, "generic command allowlist must not be empty")
    .optional(),
  definitions: z
    .array(runnerDefinitionSchema)
    .min(1, "runner definitions must not be empty")
    .optional(),
  fixCommandId: z.string().regex(safeId).optional(),
})

const hasRunnerDefinitionId = (
  definitions: readonly RunnerDefinition[],
  runnerId: string,
): boolean => definitions.some((definition) => definition.id === runnerId)

const normalizeGenericRunnerConfig = (input: {
  readonly analysisCommandId?: string | undefined
  readonly commandAllowlist: readonly string[]
  readonly definitions: readonly RunnerDefinition[]
  readonly fixCommandId?: string | undefined
}): GenericRunnerConfig => {
  const analysisCommand =
    input.analysisCommandId === undefined ? {} : { analysisCommandId: input.analysisCommandId }
  const fixCommand = input.fixCommandId === undefined ? {} : { fixCommandId: input.fixCommandId }

  return {
    ...analysisCommand,
    commandAllowlist: input.commandAllowlist,
    definitions: input.definitions,
    ...fixCommand,
  }
}

export const runnersSchema = z
  .object({
    claudeCode: claudeCodeRunnerConfigSchema.default({
      allowedTools: [],
      disallowedTools: [],
      extraEnvAllowlist: [],
    }),
    codex: codexRunnerConfigSchema.default({
      extraEnvAllowlist: [],
      workspaceWriteNetworkAccess: false,
    }),
    definitions: z
      .array(runnerDefinitionSchema)
      .min(1, "runner definitions must not be empty")
      .optional(),
    generic: genericRunnerConfigInputSchema.optional(),
    genericCommandAllowlist: z
      .array(commandSchema)
      .min(1, "generic command allowlist must not be empty")
      .optional(),
    projectEnv: projectEnvironmentConfigSchema.optional(),
    provider: runnerProviderSchema.default("codex"),
  })
  .superRefine((value, context) => {
    const commandAllowlist = value.generic?.commandAllowlist ?? value.genericCommandAllowlist
    const definitions = value.generic?.definitions ?? value.definitions
    const genericPath = value.generic === undefined ? [] : ["generic"]
    const shouldValidateGenericConfig =
      value.provider === "generic" ||
      value.generic !== undefined ||
      value.genericCommandAllowlist !== undefined ||
      value.definitions !== undefined

    if (!shouldValidateGenericConfig) {
      return
    }

    if (commandAllowlist === undefined) {
      context.addIssue({
        code: "custom",
        message: "generic command allowlist must not be empty",
        path: [...genericPath, "commandAllowlist"],
      })
    }

    if (definitions === undefined) {
      context.addIssue({
        code: "custom",
        message: "runner definitions must not be empty",
        path: [...genericPath, "definitions"],
      })
    }

    if (value.provider === "generic" && value.generic?.analysisCommandId === undefined) {
      context.addIssue({
        code: "custom",
        message: "generic provider requires runners.generic.analysisCommandId",
        path: ["generic", "analysisCommandId"],
      })
    }

    if (value.provider === "generic" && value.generic?.fixCommandId === undefined) {
      context.addIssue({
        code: "custom",
        message: "generic provider requires runners.generic.fixCommandId",
        path: ["generic", "fixCommandId"],
      })
    }

    if (commandAllowlist === undefined || definitions === undefined) {
      return
    }

    for (const runner of definitions) {
      if (!commandAllowlist.includes(runner.command)) {
        context.addIssue({
          code: "custom",
          message: `runner command ${runner.command} is outside generic command allowlist`,
          path: [...genericPath, "definitions", runner.id, "command"],
        })
      }
    }

    if (
      value.generic?.analysisCommandId !== undefined &&
      !hasRunnerDefinitionId(definitions, value.generic.analysisCommandId)
    ) {
      context.addIssue({
        code: "custom",
        message: `analysis command ${value.generic.analysisCommandId} is not defined`,
        path: ["generic", "analysisCommandId"],
      })
    }

    if (
      value.generic?.fixCommandId !== undefined &&
      !hasRunnerDefinitionId(definitions, value.generic.fixCommandId)
    ) {
      context.addIssue({
        code: "custom",
        message: `fix command ${value.generic.fixCommandId} is not defined`,
        path: ["generic", "fixCommandId"],
      })
    }
  })
  .transform((value) => {
    const commandAllowlist = value.generic?.commandAllowlist ?? value.genericCommandAllowlist ?? []
    const definitions = value.generic?.definitions ?? value.definitions ?? []
    const generic = normalizeGenericRunnerConfig({
      analysisCommandId: value.generic?.analysisCommandId,
      commandAllowlist,
      definitions,
      fixCommandId: value.generic?.fixCommandId,
    })

    const projectEnv = value.projectEnv === undefined ? {} : { projectEnv: value.projectEnv }
    return {
      claudeCode: value.claudeCode,
      codex: value.codex,
      definitions,
      generic,
      genericCommandAllowlist: commandAllowlist,
      ...projectEnv,
      provider: value.provider,
    }
  })
