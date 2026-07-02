import type { Database } from "sql.js"

import { getLatestAnalysisSummary, saveAnalysisSummary } from "./analysis-repository.js"
import { insertApproval } from "./approval-repository.js"
import { insertAuditEntry, listAuditEntries } from "./audit-repository.js"
import { StateStoreReadOnlyError } from "./errors.js"
import {
  getIncidentHandoffByIssueId,
  listIncidentHandoffs,
  saveIncidentHandoff,
} from "./handoff-repository.js"
import {
  getIncidentByIssueId,
  updateIncidentThreadTs,
  updateIncidentWorkflowState,
  upsertIncident,
} from "./incident-repository.js"
import { abandonActiveJobs, claimJobForSlackAction, completeJob } from "./job-repository.js"
import { migrate, getSchemaVersion as readSchemaVersion } from "./migrations.js"
import { saveMrLink } from "./mr-repository.js"
import {
  getLatestSentryIssueSnapshot,
  saveSentryIssueSnapshot,
} from "./sentry-snapshot-repository.js"
import { openDatabase, persistDatabase, transaction } from "./sqlite-database.js"
import type {
  AnalysisSummaryInput,
  AuditEntryInput,
  CompleteJobInput,
  IncidentHandoffInput,
  IncidentInput,
  JobClaimInput,
  MrLinkInput,
  OpenSqliteStateStoreOptions,
  SentryIssueSnapshotInput,
  VerificationSummaryInput,
} from "./types.js"
import { getLatestVerificationSummary, saveVerificationSummary } from "./verification-repository.js"

export {
  StateStoreConstraintError,
  StateStoreOpenError,
  StateStoreReadOnlyError,
} from "./errors.js"
export type {
  AbandonActiveJobsInput,
  AnalysisSummaryInput,
  AnalysisSummaryRecord,
  AuditEntryInput,
  AuditEntryRecord,
  CompleteJobInput,
  IncidentHandoffInput,
  IncidentHandoffRecord,
  IncidentInput,
  IncidentRecord,
  IncidentUpsertResult,
  JobClaimInput,
  JobClaimRecord,
  JobKind,
  OpenSqliteStateStoreOptions,
  SentryIssueSnapshotInput,
  SentryIssueSnapshotRecord,
  TerminalJobState,
  VerificationStatus,
  VerificationSummaryInput,
  VerificationSummaryRecord,
} from "./types.js"

class SqliteStateStore {
  readonly #db: Database
  readonly #path: string
  readonly #accessMode: "read" | "write"

  public constructor(db: Database, path: string, accessMode: "read" | "write") {
    this.#db = db
    this.#path = path
    this.#accessMode = accessMode
  }

  public close(): void {
    let persistenceError: unknown
    try {
      if (this.#accessMode === "write") {
        persistDatabase(this.#db, this.#path)
      }
    } catch (error) {
      persistenceError = error
    }

    try {
      this.#db.close()
    } catch (error) {
      if (persistenceError === undefined) {
        throw error
      }
    }

    if (persistenceError !== undefined) {
      throw persistenceError
    }
  }

  public assertWritable(operation: string): void {
    if (this.#accessMode === "read") {
      throw new StateStoreReadOnlyError(operation)
    }
  }

  public getSchemaVersion(): number {
    return readSchemaVersion(this.#db)
  }

  public upsertIncident(input: IncidentInput) {
    this.assertWritable("upsertIncident")
    return upsertIncident(this.#db, this.#path, input)
  }

  public getIncidentByIssueId(issueId: string) {
    return getIncidentByIssueId(this.#db, issueId)
  }

  public updateIncidentWorkflowState(
    input: Parameters<typeof updateIncidentWorkflowState>[2],
  ): void {
    this.assertWritable("updateIncidentWorkflowState")
    updateIncidentWorkflowState(this.#db, this.#path, input)
  }

  public updateIncidentThreadTs(input: Parameters<typeof updateIncidentThreadTs>[2]): void {
    this.assertWritable("updateIncidentThreadTs")
    updateIncidentThreadTs(this.#db, this.#path, input)
  }

  public saveAnalysisSummary(input: AnalysisSummaryInput) {
    this.assertWritable("saveAnalysisSummary")
    return saveAnalysisSummary(this.#db, this.#path, input)
  }

  public getLatestAnalysisSummary(incidentId: string) {
    return getLatestAnalysisSummary(this.#db, incidentId)
  }

  public saveSentryIssueSnapshot(input: SentryIssueSnapshotInput) {
    this.assertWritable("saveSentryIssueSnapshot")
    return transaction(this.#db, this.#path, () => saveSentryIssueSnapshot(this.#db, input))
  }

  public getLatestSentryIssueSnapshot(incidentId: string) {
    return getLatestSentryIssueSnapshot(this.#db, incidentId)
  }

  public saveVerificationSummary(input: VerificationSummaryInput) {
    this.assertWritable("saveVerificationSummary")
    return transaction(this.#db, this.#path, () => saveVerificationSummary(this.#db, input))
  }

  public getLatestVerificationSummary(incidentId: string) {
    return getLatestVerificationSummary(this.#db, incidentId)
  }

  public saveMrLink(input: MrLinkInput): void {
    this.assertWritable("saveMrLink")
    saveMrLink(this.#db, this.#path, input)
  }

  public saveIncidentHandoff(input: IncidentHandoffInput) {
    this.assertWritable("saveIncidentHandoff")
    return saveIncidentHandoff(this.#db, this.#path, input)
  }

  public getIncidentHandoffByIssueId(issueId: string) {
    return getIncidentHandoffByIssueId(this.#db, issueId)
  }

  public listIncidentHandoffs(limit: number) {
    return listIncidentHandoffs(this.#db, limit)
  }

  public saveApproval(input: Parameters<typeof insertApproval>[1]): void {
    this.assertWritable("saveApproval")
    transaction(this.#db, this.#path, () => {
      insertApproval(this.#db, input)
    })
  }

  public claimJobForSlackAction(input: JobClaimInput) {
    this.assertWritable("claimJobForSlackAction")
    return claimJobForSlackAction(this.#db, this.#path, input)
  }

  public completeJob(input: CompleteJobInput): void {
    this.assertWritable("completeJob")
    completeJob(this.#db, this.#path, input)
  }

  public abandonActiveJobs(input: Parameters<typeof abandonActiveJobs>[2]) {
    this.assertWritable("abandonActiveJobs")
    return abandonActiveJobs(this.#db, this.#path, input)
  }

  public appendAuditEntry(input: AuditEntryInput) {
    this.assertWritable("appendAuditEntry")
    return transaction(this.#db, this.#path, () => insertAuditEntry(this.#db, input))
  }

  public listAuditEntries() {
    return listAuditEntries(this.#db)
  }
}

export const openSqliteStateStore = (options: OpenSqliteStateStoreOptions): SqliteStateStore => {
  const createIfMissing = options.createIfMissing ?? true
  const accessMode = options.accessMode ?? "write"
  const db = openDatabase(options.path, createIfMissing, accessMode)
  if (accessMode === "write") {
    migrate(db)
    persistDatabase(db, options.path)
  }
  return new SqliteStateStore(db, options.path, accessMode)
}
