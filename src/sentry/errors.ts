import type { ZodError } from "zod"

export class SentryExternalApiError extends Error {
  public readonly name = "SentryExternalApiError"
  public readonly statusCode: number | undefined

  public constructor(message: string, statusCode?: number) {
    super(message)
    this.statusCode = statusCode
  }
}

export const sentryParseError = (label: string, error: ZodError): SentryExternalApiError =>
  new SentryExternalApiError(
    `Malformed Sentry ${label} response: ${error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  )
