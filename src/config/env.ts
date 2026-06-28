import { ZodError, z } from "zod"

import { ConfigValidationError } from "./errors.js"

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/, "must be a positive integer string")

const secretFromEnv = z.string().min(1, "must be set in env")

const workerEnvSchema = z.object({
  GITLAB_TOKEN: secretFromEnv,
  SENTRY_AUTH_TOKEN: secretFromEnv,
  SENTRY_BASE_URL: z.url().default("https://sentry.io/api/0"),
  SENTRY_POLL_INTERVAL_SECONDS: positiveIntegerString.default("300"),
  SENTRY_POLL_MIN_INTERVAL_SECONDS: positiveIntegerString.default("60"),
  SLACK_APP_TOKEN: secretFromEnv,
  SLACK_BOT_TOKEN: secretFromEnv,
  STATE_DB_PATH: z.string().min(1).default(".omo/state.sqlite"),
})

export type WorkerEnv = {
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

export const parseWorkerEnv = (input: Readonly<Record<string, string | undefined>>): WorkerEnv => {
  try {
    const parsed = workerEnvSchema.parse(input)
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
      gitlabToken: parsed.GITLAB_TOKEN,
      sentryAuthToken: parsed.SENTRY_AUTH_TOKEN,
      sentryBaseUrl: parsed.SENTRY_BASE_URL,
      sentryPollIntervalSeconds,
      sentryPollMinIntervalSeconds,
      slackAppToken: parsed.SLACK_APP_TOKEN,
      slackBotToken: parsed.SLACK_BOT_TOKEN,
      stateDbPath: parsed.STATE_DB_PATH,
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
