import { ConfigValidationError } from "../config/index.js"
import { createSentryPollingSchedule } from "../sentry/index.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { openDatabase } from "../state/sqlite-database.js"
import { requiredNumber, selectOne } from "../state/sqlite-rows.js"
import { openSqliteStateStore, StateStoreOpenError } from "../state/sqlite-store.js"
import { type CliRuntimeOptions, runDaemonCommand } from "./daemon.js"
import { runDoctorCommand } from "./doctor.js"
import { runLogsCommand } from "./logs.js"
import { runOnceCommand } from "./run-once.js"
import { configFailure, loadCommandSettings } from "./settings.js"

const countTable = (dbPath: string, sql: string): number => {
  const db = openDatabase(dbPath, false)
  try {
    const row = selectOne(db, sql)
    if (row === undefined) {
      return 0
    }
    return requiredNumber(row, "count")
  } finally {
    db.close()
  }
}

export const runStatusCommand = (args: readonly string[]): CliResult => {
  try {
    const loaded = loadCommandSettings(args)
    const dbPath = loaded.settings.env.stateDbPath
    const schemaStore = openSqliteStateStore({
      accessMode: "read",
      path: dbPath,
      createIfMissing: false,
    })
    let schemaVersion: number
    try {
      schemaVersion = schemaStore.getSchemaVersion()
    } finally {
      schemaStore.close()
    }
    const incidents = countTable(dbPath, "SELECT COUNT(*) AS count FROM incidents")
    const activeJobs = countTable(
      dbPath,
      "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued', 'running')",
    )
    const terminalJobs = countTable(
      dbPath,
      "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('completed', 'failed', 'canceled')",
    )
    const schedule = createSentryPollingSchedule(loaded.settings.env)
    return ok(`SQLite: ok schema=${schemaVersion}
connections: ${loaded.fakeMode ? "fake" : "configured"}
polling: interval ${schedule.intervalSeconds}s
incidents=${incidents}
jobs active=${activeJobs} terminal=${terminalJobs}
`)
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return configFailure(error)
    }
    if (error instanceof StateStoreOpenError) {
      return fail(66, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}

export {
  type CliRuntimeOptions,
  runDaemonCommand,
  runDoctorCommand,
  runLogsCommand,
  runOnceCommand,
}
