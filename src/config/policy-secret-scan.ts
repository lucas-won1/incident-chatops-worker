const secretKeyPattern = /(?:token|secret|password|credential|api[_-]?key|auth)/iu
const secretValuePattern =
  /(?:xox[abprs]-|xapp-|glpat-|github_pat_|gh[opusr]_|sntrys_|sentry[a-z0-9_-]*_)/iu

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const findYamlSecret = (
  value: unknown,
  pathParts: readonly string[] = [],
): string | undefined => {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const result = findYamlSecret(item, [...pathParts, String(index)])
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }

  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...pathParts, key]
      if (secretKeyPattern.test(key)) {
        return nextPath.join(".")
      }
      const result = findYamlSecret(item, nextPath)
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }

  if (typeof value === "string" && secretValuePattern.test(value)) {
    return pathParts.join(".")
  }

  return undefined
}
