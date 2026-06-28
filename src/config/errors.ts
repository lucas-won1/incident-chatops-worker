export class ConfigValidationError extends Error {
  public readonly issues: readonly string[]

  public constructor(message: string, issues: readonly string[] = [message]) {
    super(message)
    this.name = "ConfigValidationError"
    this.issues = issues
  }
}
