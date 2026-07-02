import { parse as parseYaml } from "yaml"
import { ZodError } from "zod"
import type { WorkerEnv } from "./env.js"
import { ConfigValidationError } from "./errors.js"
import { policySchema } from "./policy-schema.js"
import { findYamlSecret } from "./policy-secret-scan.js"
import { buildWorkerConfig, type WorkerConfig } from "./worker-config.js"

export type {
  ClaudeCodeRunnerConfig,
  CodexRunnerConfig,
  GenericRunnerConfig,
  ProjectEnvironmentConfig,
  RunnerDefinition,
  RunnerProvider,
} from "./runner-policy.js"
export type {
  SentryProjectMapping,
  WorkerConfig,
  WorktreePrepareCommand,
  WorktreePrepareConfig,
} from "./worker-config.js"

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
    return buildWorkerConfig(parsed)
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(policyIssue)
      throw new ConfigValidationError(`Invalid YAML config: ${issues.join("; ")}`, issues)
    }
    throw error
  }
}
