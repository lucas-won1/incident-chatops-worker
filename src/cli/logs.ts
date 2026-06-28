import { findOptionValue } from "../shared/cli-args.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { openSqliteStateStore, StateStoreOpenError } from "../state/sqlite-store.js"

const renderAuditText = (details: string): string => redactSensitiveText(details)

export const runLogsCommand = (args: readonly string[]): CliResult => {
  const dbPath = findOptionValue(args, "--db")
  if (dbPath === undefined) {
    return fail(64, "logs requires --db <path>\n")
  }

  try {
    const store = openSqliteStateStore({ accessMode: "read", path: dbPath, createIfMissing: false })
    const entries = store.listAuditEntries()
    store.close()
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
  } catch (error) {
    if (error instanceof StateStoreOpenError) {
      return fail(66, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}
