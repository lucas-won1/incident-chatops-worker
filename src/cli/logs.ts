import { ConfigValidationError } from "../config/index.js"
import { findOptionValue } from "../shared/cli-args.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { openSqliteStateStore, StateStoreOpenError } from "../state/sqlite-store.js"
import { configFailure, loadCommandSettings } from "./settings.js"

const renderAuditText = (details: string): string => redactSensitiveText(details)

export const runLogsCommand = (args: readonly string[]): CliResult => {
  try {
    const dbPath =
      findOptionValue(args, "--db") ?? loadCommandSettings(args).settings.env.stateDbPath
    const store = openSqliteStateStore({ accessMode: "read", path: dbPath, createIfMissing: false })
    try {
      const entries = store.listAuditEntries()
      if (entries.length === 0) {
        return ok("No audit entries\n")
      }

      return ok(
        entries
          .map(
            (entry) =>
              `${entry.occurredAt} actor=${renderAuditText(entry.actor)} action=${renderAuditText(entry.action)} job=${renderAuditText(entry.jobId ?? "")} ${renderAuditText(entry.stateFrom ?? "")}->${renderAuditText(entry.stateTo ?? "")} ${renderAuditText(entry.details)}`,
          )
          .join("\n")
          .concat("\n"),
      )
    } finally {
      store.close()
    }
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
