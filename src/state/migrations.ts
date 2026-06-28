import type { Database } from "sql.js"

import { requiredNumber, selectOne } from "./sqlite-rows.js"

const migrationOne = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  sentry_issue_id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  title TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  kind TEXT NOT NULL CHECK (kind IN ('analysis', 'fix')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'canceled')),
  action_idempotency_key TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_incident
ON jobs(incident_id)
WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS global_concurrency_leases (
  name TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
  acquired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  action_idempotency_key TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_summaries (
  summary_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  job_id TEXT NOT NULL,
  summary_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mr_links (
  mr_link_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  job_id TEXT,
  state_from TEXT,
  state_to TEXT,
  details TEXT NOT NULL
);
` as const

const migrationTwo = `
CREATE TABLE IF NOT EXISTS sentry_issue_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  sentry_issue_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sentry_issue_snapshots_incident_latest
ON sentry_issue_snapshots(incident_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS verification_summaries (
  verification_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'missing')),
  summary_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_summaries_incident_latest
ON verification_summaries(incident_id, created_at DESC);
` as const

export const latestSchemaVersion = 2

const appliedVersion = (db: Database, version: number): boolean =>
  selectOne(db, "SELECT version FROM schema_migrations WHERE version = :version", {
    ":version": version,
  }) !== undefined

export const migrate = (db: Database): void => {
  db.run("BEGIN IMMEDIATE")
  try {
    db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    if (!appliedVersion(db, 1)) {
      db.run(migrationOne)
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))")
    }
    if (!appliedVersion(db, 2)) {
      db.run(migrationTwo)
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'))")
    }
    db.run("COMMIT")
  } catch (error) {
    db.run("ROLLBACK")
    throw error
  }
}

export const getSchemaVersion = (db: Database): number => {
  const row = selectOne(db, "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
  if (row === undefined) {
    return 0
  }

  return requiredNumber(row, "version")
}
