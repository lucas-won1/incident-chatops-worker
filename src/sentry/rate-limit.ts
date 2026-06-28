const parsePositiveInteger = (value: string | null): number | undefined => {
  if (value === null || !/^[1-9]\d*$/u.test(value)) {
    return undefined
  }
  return Number.parseInt(value, 10)
}

const parseResetHeader = (value: string | null, nowSeconds: number): number | undefined => {
  const parsed = parsePositiveInteger(value)
  if (parsed === undefined) {
    return undefined
  }
  return parsed > nowSeconds ? parsed - nowSeconds : parsed
}

const parseSentryRateLimitsHeader = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }
  const firstLimit = value.split(",")[0]
  const retryAfter = firstLimit?.split(":")[0]
  return retryAfter === undefined ? undefined : parsePositiveInteger(retryAfter)
}

export const parseSentryBackoffSeconds = (headers: Headers, nowSeconds: number): number => {
  const retryAfter = parsePositiveInteger(headers.get("retry-after"))
  if (retryAfter !== undefined) {
    return retryAfter
  }

  const sentryLimits = parseSentryRateLimitsHeader(headers.get("x-sentry-rate-limits"))
  if (sentryLimits !== undefined) {
    return sentryLimits
  }

  const reset = parseResetHeader(headers.get("x-sentry-rate-limit-reset"), nowSeconds)
  return reset ?? 60
}

export const hasExhaustedSentryRateLimit = (headers: Headers): boolean =>
  headers.get("x-sentry-rate-limit-remaining") === "0"
