import path from "node:path"

import { ZodError, z } from "zod"

import { ConfigValidationError } from "./errors.js"

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/, "must be a positive integer string")

const secretFromEnv = z.string().min(1, "must be set in env")
const optionalSecretFromEnv = secretFromEnv.optional()
const optionalTokenEnvKeys = ["GITHUB_TOKEN", "GITLAB_TOKEN"] as const

const workerEnvSchema = z.object({
  GITHUB_TOKEN: optionalSecretFromEnv,
  GITLAB_TOKEN: optionalSecretFromEnv,
  SENTRY_AUTH_TOKEN: secretFromEnv,
  SENTRY_BASE_URL: z.url().default("https://sentry.io/api/0"),
  SENTRY_POLL_INTERVAL_SECONDS: positiveIntegerString.default("300"),
  SENTRY_POLL_MIN_INTERVAL_SECONDS: positiveIntegerString.default("60"),
  SLACK_APP_TOKEN: secretFromEnv,
  SLACK_BOT_TOKEN: secretFromEnv,
  STATE_DB_PATH: z.string().min(1).optional(),
})

export type WorkerEnvParseOptions = {
  readonly platform?: NodeJS.Platform
}

export type WorkerEnv = {
  readonly githubToken: string
  readonly gitlabToken: string
  readonly sentryAuthToken: string
  readonly sentryBaseUrl: string
  readonly sentryPollIntervalSeconds: number
  readonly sentryPollMinIntervalSeconds: number
  readonly slackAppToken: string
  readonly slackBotToken: string
  readonly stateDbPath: string
}

const envIssue = (issue: {
  readonly path: readonly PropertyKey[]
  readonly message: string
}): string => {
  const key = issue.path.join(".")
  return key.length > 0 ? `${key}: ${issue.message}` : issue.message
}

const envValue = (
  input: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const value = input[key]
  return value === undefined || value.length === 0 ? undefined : value
}

const normalizeOptionalTokenEnv = (
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const normalized: Record<string, string | undefined> = { ...input }
  for (const key of optionalTokenEnvKeys) {
    if (normalized[key] === "") {
      delete normalized[key]
    }
  }
  return normalized
}

const missingStateBaseError = (name: string): ConfigValidationError =>
  new ConfigValidationError(
    `STATE_DB_PATH is not set and ${name} is required to choose an automatic state DB path`,
  )

const automaticStateDbPath = (
  input: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string => {
  switch (platform) {
    case "darwin": {
      const home = envValue(input, "HOME")
      if (home === undefined) {
        throw missingStateBaseError("HOME")
      }
      return path.join(
        home,
        "Library",
        "Application Support",
        "incident-chatops-worker",
        "state.sqlite",
      )
    }
    case "linux": {
      const xdgStateHome = envValue(input, "XDG_STATE_HOME")
      if (xdgStateHome !== undefined) {
        return path.posix.join(xdgStateHome, "incident-chatops-worker", "state.sqlite")
      }
      const home = envValue(input, "HOME")
      if (home === undefined) {
        throw missingStateBaseError("HOME")
      }
      return path.posix.join(home, ".local", "state", "incident-chatops-worker", "state.sqlite")
    }
    case "win32": {
      const localAppData = envValue(input, "LOCALAPPDATA")
      if (localAppData === undefined) {
        throw missingStateBaseError("LOCALAPPDATA")
      }
      return path.win32.join(localAppData, "incident-chatops-worker", "state.sqlite")
    }
    default:
      throw new ConfigValidationError(
        `STATE_DB_PATH is not set and automatic state DB path is unsupported on ${platform}`,
      )
  }
}

const resolveStateDbPath = (
  explicitPath: string | undefined,
  input: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string => explicitPath ?? automaticStateDbPath(input, platform)

export const parseWorkerEnv = (
  input: Readonly<Record<string, string | undefined>>,
  options: WorkerEnvParseOptions = {},
): WorkerEnv => {
  try {
    const parsed = workerEnvSchema.parse(normalizeOptionalTokenEnv(input))
    const sentryPollIntervalSeconds = Number.parseInt(parsed.SENTRY_POLL_INTERVAL_SECONDS, 10)
    const sentryPollMinIntervalSeconds = Number.parseInt(
      parsed.SENTRY_POLL_MIN_INTERVAL_SECONDS,
      10,
    )

    if (sentryPollIntervalSeconds < sentryPollMinIntervalSeconds) {
      throw new ConfigValidationError(
        "SENTRY_POLL_INTERVAL_SECONDS must be greater than or equal to SENTRY_POLL_MIN_INTERVAL_SECONDS",
      )
    }

    return {
      githubToken: parsed.GITHUB_TOKEN ?? "",
      gitlabToken: parsed.GITLAB_TOKEN ?? "",
      sentryAuthToken: parsed.SENTRY_AUTH_TOKEN,
      sentryBaseUrl: parsed.SENTRY_BASE_URL,
      sentryPollIntervalSeconds,
      sentryPollMinIntervalSeconds,
      slackAppToken: parsed.SLACK_APP_TOKEN,
      slackBotToken: parsed.SLACK_BOT_TOKEN,
      stateDbPath: resolveStateDbPath(
        parsed.STATE_DB_PATH,
        input,
        options.platform ?? process.platform,
      ),
    }
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error
    }
    if (error instanceof ZodError) {
      const issues = error.issues.map(envIssue)
      throw new ConfigValidationError(`Invalid environment: ${issues.join("; ")}`, issues)
    }
    throw error
  }
}
