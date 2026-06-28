export type CliResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const ok = (stdout: string): CliResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
})

export const fail = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stdout: "",
  stderr,
})
