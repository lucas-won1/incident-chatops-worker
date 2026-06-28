import { ZodError } from "zod"

import { SentryExternalApiError, sentryParseError } from "./errors.js"
import { createSentryHttpClient } from "./http-client.js"
import { type SentryIssueEvent, sentryIssueEventsSchema } from "./schemas.js"

export type FetchIssueContextOptions = {
  readonly authToken: string
  readonly baseUrl: string
  readonly issueId: string
  readonly organizationSlug: string
}

export type SentryIssueContext = {
  readonly issueId: string
  readonly trustBoundary: "untrusted_external_sentry"
  readonly events: readonly SentryIssueEvent[]
}

export const fetchIssueContext = async (
  options: FetchIssueContextOptions,
): Promise<SentryIssueContext> => {
  const client = createSentryHttpClient({
    authToken: options.authToken,
    baseUrl: options.baseUrl,
  })
  const response = await client.get(
    `organizations/${options.organizationSlug}/issues/${options.issueId}/events/`,
  )
  if (!response.ok) {
    throw new SentryExternalApiError(
      `Sentry issue events request failed with HTTP ${response.status}`,
      response.status,
    )
  }

  try {
    const body = await response.json()
    return {
      events: sentryIssueEventsSchema.parse(body),
      issueId: options.issueId,
      trustBoundary: "untrusted_external_sentry",
    }
  } catch (error) {
    if (error instanceof ZodError) {
      throw sentryParseError("issue events", error)
    }
    if (error instanceof SyntaxError) {
      throw new SentryExternalApiError(
        "Malformed Sentry issue events response JSON",
        response.status,
      )
    }
    throw error
  }
}
