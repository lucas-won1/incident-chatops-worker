import { readFileSync } from "node:fs"
import path from "node:path"

import { ConfigValidationError } from "../config/errors.js"
import { parseEnvFile } from "../config/files.js"
import { startIncidentHandoffMcpServer } from "../mcp/server.js"
import { findOptionValue } from "../shared/cli-args.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { StateStoreOpenError } from "../state/sqlite-store.js"

type McpEnvironment = Readonly<Record<string, string | undefined>>

const envValue = (input: McpEnvironment, key: string): string | undefined => {
  const value = input[key]
  return value === undefined || value.length === 0 ? undefined : value
}

const missingStateBaseError = (name: string): ConfigValidationError =>
  new ConfigValidationError(
    `STATE_DB_PATH is not set and ${name} is required to choose an automatic state DB path`,
  )

const automaticStateDbPath = (input: McpEnvironment, platform: NodeJS.Platform): string => {
  switch (platform) {
    case "darwin": {
      const home = envValue(input, "HOME")
      if (home === undefined) {
        throw missingStateBaseError("HOME")
      }
      return path.join(
        home,
        "Library",
        "Application Support",
        "incident-chatops-worker",
        "state.sqlite",
      )
    }
    case "linux": {
      const xdgStateHome = envValue(input, "XDG_STATE_HOME")
      if (xdgStateHome !== undefined) {
        return path.posix.join(xdgStateHome, "incident-chatops-worker", "state.sqlite")
      }
      const home = envValue(input, "HOME")
      if (home === undefined) {
        throw missingStateBaseError("HOME")
      }
      return path.posix.join(home, ".local", "state", "incident-chatops-worker", "state.sqlite")
    }
    case "win32": {
      const localAppData = envValue(input, "LOCALAPPDATA")
      if (localAppData === undefined) {
        throw missingStateBaseError("LOCALAPPDATA")
      }
      return path.win32.join(localAppData, "incident-chatops-worker", "state.sqlite")
    }
    default:
      throw new ConfigValidationError(
        `STATE_DB_PATH is not set and automatic state DB path is unsupported on ${platform}`,
      )
  }
}

const readEnvFile = (envFilePath: string | undefined): Readonly<Record<string, string>> => {
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

export const resolveMcpStateDbPath = (
  args: readonly string[],
  env: McpEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const explicitPath = findOptionValue(args, "--db")
  if (explicitPath !== undefined) {
    return explicitPath
  }
  const envFilePath = findOptionValue(args, "--env-file")
  const fileEnv = readEnvFile(envFilePath)
  return (
    envValue(fileEnv, "STATE_DB_PATH") ??
    envValue(env, "STATE_DB_PATH") ??
    automaticStateDbPath(env, platform)
  )
}

export const runMcpCommand = async (args: readonly string[]): Promise<CliResult> => {
  try {
    const dbPath = resolveMcpStateDbPath(args)
    await startIncidentHandoffMcpServer(dbPath)
    return ok("")
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return fail(78, `Config invalid: ${error.message}\n`)
    }
    if (error instanceof StateStoreOpenError) {
      return fail(66, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}
