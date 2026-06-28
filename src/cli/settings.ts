import { readFileSync } from "node:fs"

import type { WorkerSettings } from "../config/files.js"
import { ConfigValidationError, loadWorkerSettings, parseEnvFile } from "../config/index.js"
import { findOptionValue } from "../shared/cli-args.js"
import { type CliResult, fail } from "../shared/cli-result.js"

export type LoadedCommandSettings = {
  readonly fakeMode: boolean
  readonly settings: WorkerSettings
}

const readEnvFileForMode = (envFilePath: string | undefined): Readonly<Record<string, string>> => {
  if (envFilePath === undefined) {
    return {}
  }
  try {
    return parseEnvFile(readFileSync(envFilePath, "utf8"))
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error
    }
    if (error instanceof Error) {
      throw new ConfigValidationError(`Unable to read ${envFilePath}: ${error.message}`)
    }
    throw error
  }
}

export const loadCommandSettings = (args: readonly string[]): LoadedCommandSettings => {
  const configPath = findOptionValue(args, "--config")
  if (configPath === undefined) {
    throw new ConfigValidationError("Missing required option: --config")
  }
  const envFilePath = findOptionValue(args, "--env-file")
  const envFromFile = readEnvFileForMode(envFilePath)
  const settings =
    envFilePath === undefined
      ? loadWorkerSettings({ configPath })
      : loadWorkerSettings({ configPath, envFilePath })
  const { FAKE_MODE: fileFakeMode } = envFromFile
  const { FAKE_MODE: processFakeMode } = process.env
  const fakeMode = fileFakeMode === "1" || processFakeMode === "1"
  return { fakeMode, settings }
}

export const configFailure = (error: ConfigValidationError): CliResult =>
  fail(78, `Config invalid: ${error.message}\n`)

export const doctorFailure = (error: Error): CliResult => ({
  exitCode: 78,
  stdout: `Config invalid: ${error.message}\n`,
  stderr: "",
})
