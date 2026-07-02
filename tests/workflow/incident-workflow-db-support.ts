import { openDatabase } from "../../src/state/sqlite-database.js"

type SavedMrLink = {
  readonly provider: string
  readonly url: string
}

type SavedIncidentHandoff = {
  readonly analysisSummary: string
  readonly changesSummary: string
  readonly createdAt: string
  readonly followUpPrompt: string
  readonly headSha: string
  readonly issueId: string
  readonly jobId: string
  readonly mrReadiness: string
  readonly mrUrl: string
  readonly provider: string
  readonly repoId: string
  readonly repoPath: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly verificationSummary: string
}

export const readSavedMrLinks = (dbPath: string): readonly SavedMrLink[] => {
  const db = openDatabase(dbPath, false)
  try {
    const rows = db.exec("SELECT provider, url FROM mr_links ORDER BY created_at ASC")
    return (
      rows[0]?.values.map((row) => ({
        provider: String(row[0]),
        url: String(row[1]),
      })) ?? []
    )
  } finally {
    db.close()
  }
}

export const readSavedIncidentHandoffs = (dbPath: string): readonly SavedIncidentHandoff[] => {
  const db = openDatabase(dbPath, false)
  try {
    const rows = db.exec(
      `SELECT
        sentry_issue_id, repo_id, repo_path, job_id, provider, mr_url,
        source_branch, target_branch, head_sha, analysis_summary,
        changes_summary, verification_summary, mr_readiness, created_at,
        follow_up_prompt
      FROM incident_handoffs
      ORDER BY created_at ASC`,
    )
    return (
      rows[0]?.values.map((row) => ({
        analysisSummary: String(row[9]),
        changesSummary: String(row[10]),
        createdAt: String(row[13]),
        followUpPrompt: String(row[14]),
        headSha: String(row[8]),
        issueId: String(row[0]),
        jobId: String(row[3]),
        mrReadiness: String(row[12]),
        mrUrl: String(row[5]),
        provider: String(row[4]),
        repoId: String(row[1]),
        repoPath: String(row[2]),
        sourceBranch: String(row[6]),
        targetBranch: String(row[7]),
        verificationSummary: String(row[11]),
      })) ?? []
    )
  } finally {
    db.close()
  }
}
