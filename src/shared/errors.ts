export class UnknownCommandError extends Error {
  public readonly command: string

  public constructor(command: string) {
    super(`Unknown command: ${command}`)
    this.name = "UnknownCommandError"
    this.command = command
  }
}
