import { readFileSync } from "node:fs"
import { parseWorkerEnv, type WorkerEnv } from "./env.js"
import { ConfigValidationError } from "./errors.js"
import { parseWorkerConfigYaml, type WorkerConfig } from "./policy.js"

export type WorkerSettings = {
  readonly config: WorkerConfig
  readonly env: WorkerEnv
}

export type WorkerSettingsFiles = {
  readonly configPath: string
  readonly envFilePath?: string
}

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u

export const parseEnvFile = (source: string): Readonly<Record<string, string>> => {
  const entries: Record<string, string> = {}
  const lines = source.split(/\r?\n/u)

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmed.indexOf("=")
    if (separatorIndex < 1) {
      throw new ConfigValidationError(`Invalid env file line ${index + 1}: expected KEY=value`)
    }

    const key = trimmed.slice(0, separatorIndex)
    const value = trimmed.slice(separatorIndex + 1)
    if (!envKeyPattern.test(key)) {
      throw new ConfigValidationError(`Invalid env file key on line ${index + 1}: ${key}`)
    }
    entries[key] = value
  }

  return entries
}

const readTextFile = (filePath: string): string => {
  try {
    return readFileSync(filePath, "utf8")
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigValidationError(`Unable to read ${filePath}: ${error.message}`)
    }
    throw error
  }
}

export const loadWorkerSettings = (files: WorkerSettingsFiles): WorkerSettings => {
  const envFromFile =
    files.envFilePath === undefined ? {} : parseEnvFile(readTextFile(files.envFilePath))
  const env = parseWorkerEnv({ ...process.env, ...envFromFile })
  const config = parseWorkerConfigYaml(readTextFile(files.configPath), env)

  return { config, env }
}
