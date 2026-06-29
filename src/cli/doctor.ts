import ky from "ky"
import { z } from "zod"

import type { WorkerSettings } from "../config/index.js"
import { ConfigValidationError } from "../config/index.js"
import { type CliResult, ok } from "../shared/cli-result.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { doctorFailure, loadCommandSettings } from "./settings.js"

export type ReachabilityStatus =
  | {
      readonly kind: "ok"
      readonly message: string
    }
  | {
      readonly kind: "warning"
      readonly message: string
    }

export type ReachabilityReport = {
  readonly gitProvider: ReachabilityStatus
  readonly sentry: ReachabilityStatus
  readonly slackApp: ReachabilityStatus
  readonly slackBot: ReachabilityStatus
}

export type ReachabilityChecker = (
  settings: WorkerSettings,
) => Promise<ReachabilityReport> | ReachabilityReport

const timeoutMs = 5000
const slackAuthTestSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
})
const slackSocketModeOpenSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
  url: z.string().optional(),
})

const safeMessage = (message: string, settings: WorkerSettings): string =>
  redactSensitiveText(message, [
    settings.env.githubToken,
    settings.env.gitlabToken,
    settings.env.sentryAuthToken,
    settings.env.slackAppToken,
    settings.env.slackBotToken,
  ])

const statusText = (status: ReachabilityStatus, settings: WorkerSettings): string =>
  `reachability ${status.kind}: ${safeMessage(status.message, settings)}`

const assertNeverProvider = (provider: never): never => {
  throw new ConfigValidationError(`Unsupported merge request provider: ${provider}`)
}

const gitProviderTokenLabel = (settings: WorkerSettings): string => {
  switch (settings.config.mr.provider) {
    case "gitlab":
      return "GitLab token"
    case "github":
      return "GitHub token"
    default:
      return assertNeverProvider(settings.config.mr.provider)
  }
}

const gitProviderReachabilityConfig = (
  settings: WorkerSettings,
): {
  readonly service: "GitHub" | "GitLab"
  readonly tokenHeader: Readonly<Record<string, string>>
  readonly url: string
} => {
  switch (settings.config.mr.provider) {
    case "gitlab":
      return {
        service: "GitLab",
        tokenHeader: { "private-token": settings.env.gitlabToken },
        url: `${(settings.config.mr.gitlab?.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/$/u, "")}/user`,
      }
    case "github":
      return {
        service: "GitHub",
        tokenHeader: { authorization: `Bearer ${settings.env.githubToken}` },
        url: `${(settings.config.mr.github?.baseUrl ?? "https://api.github.com").replace(/\/$/u, "")}/user`,
      }
    default:
      return assertNeverProvider(settings.config.mr.provider)
  }
}

const authenticatedGet = async (
  url: string,
  tokenHeader: Readonly<Record<string, string>>,
): Promise<number> => {
  const response = await ky.get(url, {
    headers: tokenHeader,
    retry: { limit: 0 },
    throwHttpErrors: false,
    timeout: timeoutMs,
  })
  return response.status
}

const checkSlackBotReachability = async (settings: WorkerSettings): Promise<ReachabilityStatus> => {
  const response = await ky.get("https://slack.com/api/auth.test", {
    headers: {
      authorization: `Bearer ${settings.env.slackBotToken}`,
    },
    retry: { limit: 0 },
    throwHttpErrors: false,
    timeout: timeoutMs,
  })
  if (response.status !== 200) {
    return { kind: "warning", message: `auth.test HTTP ${response.status}` }
  }
  const body = slackAuthTestSchema.parse(await response.json())
  return body.ok
    ? { kind: "ok", message: "auth.test ok" }
    : { kind: "warning", message: `auth.test rejected token: ${body.error ?? "unknown"}` }
}

const checkSlackAppReachability = async (settings: WorkerSettings): Promise<ReachabilityStatus> => {
  const response = await ky.post("https://slack.com/api/apps.connections.open", {
    headers: {
      authorization: `Bearer ${settings.env.slackAppToken}`,
    },
    retry: { limit: 0 },
    throwHttpErrors: false,
    timeout: timeoutMs,
  })
  if (response.status !== 200) {
    return { kind: "warning", message: `apps.connections.open HTTP ${response.status}` }
  }
  const body = slackSocketModeOpenSchema.parse(await response.json())
  return body.ok
    ? { kind: "ok", message: "apps.connections.open ok" }
    : {
        kind: "warning",
        message: `apps.connections.open rejected token: ${body.error ?? "unknown"}`,
      }
}

const warningFromError = (service: string, error: unknown): ReachabilityStatus => {
  if (error instanceof Error) {
    return { kind: "warning", message: `${service} probe failed: ${error.message}` }
  }
  return { kind: "warning", message: `${service} probe failed` }
}

export const checkTokenReachability: ReachabilityChecker = async (
  settings,
): Promise<ReachabilityReport> => {
  const gitProviderConfig = gitProviderReachabilityConfig(settings)
  const [slackBot, slackApp, sentry, gitProvider] = await Promise.all([
    checkSlackBotReachability(settings).catch((error: unknown) =>
      warningFromError("Slack bot", error),
    ),
    checkSlackAppReachability(settings).catch((error: unknown) =>
      warningFromError("Slack app", error),
    ),
    authenticatedGet(`${settings.env.sentryBaseUrl.replace(/\/$/u, "")}/organizations/`, {
      authorization: `Bearer ${settings.env.sentryAuthToken}`,
    })
      .then((status) =>
        status >= 200 && status < 300
          ? { kind: "ok" as const, message: `organizations probe HTTP ${status}` }
          : { kind: "warning" as const, message: `organizations probe HTTP ${status}` },
      )
      .catch((error: unknown) => warningFromError("Sentry", error)),
    authenticatedGet(gitProviderConfig.url, gitProviderConfig.tokenHeader)
      .then((status) =>
        status === 200
          ? { kind: "ok" as const, message: "user probe HTTP 200" }
          : { kind: "warning" as const, message: `user probe HTTP ${status}` },
      )
      .catch((error: unknown) => warningFromError(gitProviderConfig.service, error)),
  ])
  return { gitProvider, sentry, slackApp, slackBot }
}

const fakeReachability = "reachability skipped in fake mode"

export const runDoctorCommand = async (
  args: readonly string[],
  checker: ReachabilityChecker = checkTokenReachability,
): Promise<CliResult> => {
  try {
    const loaded = loadCommandSettings(args)
    const exampleMode = args.includes("--example-mode")
    const reachability = loaded.fakeMode || exampleMode ? undefined : await checker(loaded.settings)
    const slackBotStatus =
      reachability === undefined
        ? fakeReachability
        : statusText(reachability.slackBot, loaded.settings)
    const slackAppStatus =
      reachability === undefined
        ? fakeReachability
        : statusText(reachability.slackApp, loaded.settings)
    const sentryStatus =
      reachability === undefined
        ? fakeReachability
        : statusText(reachability.sentry, loaded.settings)
    const gitProviderStatus =
      reachability === undefined
        ? fakeReachability
        : statusText(reachability.gitProvider, loaded.settings)
    const gitProviderLabel = gitProviderTokenLabel(loaded.settings)
    const exitCode =
      reachability === undefined ||
      (reachability.slackBot.kind === "ok" &&
        reachability.slackApp.kind === "ok" &&
        reachability.sentry.kind === "ok" &&
        reachability.gitProvider.kind === "ok")
        ? 0
        : 1
    const stdout = `Config valid
Sentry polling interval: ${loaded.settings.env.sentryPollIntervalSeconds}s
Sentry minimum polling interval: ${loaded.settings.env.sentryPollMinIntervalSeconds}s
Repo allowlist entries: ${loaded.settings.config.repos.allowlist.length}
Branch prefix: ${loaded.settings.config.branchPrefix}
Runner definitions: ${loaded.settings.config.runners.definitions.length}
Slack bot token: present (${slackBotStatus})
Slack app token: present (${slackAppStatus})
Sentry token: present (${sentryStatus})
${gitProviderLabel}: present (${gitProviderStatus})
Secrets: loaded from env only (redacted)
${exampleMode ? "Example mode: sample values expected; token reachability checks skipped\n" : ""}`
    return { ...ok(stdout), exitCode }
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return doctorFailure(error)
    }
    if (error instanceof Error) {
      return doctorFailure(error)
    }
    throw error
  }
}
