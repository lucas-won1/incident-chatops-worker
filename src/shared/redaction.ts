const tokenPatterns = [
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /sntrys_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9_]+/g,
] as const

const minimumExactSecretLength = 8

const exactSecretValues = (secretValues: readonly string[]): readonly string[] =>
  [...new Set(secretValues.filter((secret) => secret.length >= minimumExactSecretLength))].sort(
    (left, right) => right.length - left.length,
  )

export const redactSensitiveText = (
  value: string,
  secretValues: readonly string[] = [],
): string => {
  const patternRedacted = tokenPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  )
  return exactSecretValues(secretValues).reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    patternRedacted,
  )
}

const uniqueRedactedKey = (key: string, target: Readonly<Record<string, unknown>>): string => {
  if (!(key in target)) {
    return key
  }
  let suffix = 2
  while (`${key}#${suffix}` in target) {
    suffix += 1
  }
  return `${key}#${suffix}`
}

export const redactSensitiveJsonValue = (
  value: unknown,
  secretValues: readonly string[] = [],
): unknown => {
  if (typeof value === "string") {
    return redactSensitiveText(value, secretValues)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJsonValue(item, secretValues))
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      const redactedKey = uniqueRedactedKey(redactSensitiveText(key, secretValues), redacted)
      redacted[redactedKey] = redactSensitiveJsonValue(nested, secretValues)
    }
    return redacted
  }
  return value
}

export const redactAndTruncate = (
  value: string,
  maxLength: number,
  secretValues: readonly string[] = [],
): string => {
  const redacted = redactSensitiveText(value, secretValues)
  if (redacted.length <= maxLength) {
    return redacted
  }

  return `${redacted.slice(0, maxLength - 15)}...[TRUNCATED]`
}
