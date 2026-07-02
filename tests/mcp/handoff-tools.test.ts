import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  createIncidentHandoffToolHandlers,
  incidentHandoffToolDefinitions,
} from "../../src/mcp/handoff-tools.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-mcp-handoff-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

const seedHandoff = (dbPath: string): ReturnType<typeof openSqliteStateStore> => {
  const store = openSqliteStateStore({ path: dbPath })
  const incident = store.upsertIncident({
    issueId: "SENTRY-123",
    repoId: "repo-api",
    channelId: "C123",
    threadTs: "1712345678.000100",
    title: "Checkout crash",
    firstSeenAt: "2026-06-26T00:00:00.000Z",
    lastSeenAt: "2026-06-26T00:01:00.000Z",
  })
  const job = store.claimJobForSlackAction({
    incidentId: incident.incidentId,
    actionIdempotencyKey: "slack-action-1",
    jobKind: "fix",
    actor: "slack:U123",
    now: "2026-06-26T00:05:00.000Z",
  })
  store.saveIncidentHandoff({
    analysisSummary: "Root cause: checkout crash.",
    changesSummary: "Patched null guard.",
    createdAt: "2026-06-26T00:08:00.000Z",
    followUpPrompt: "Open the MR branch and review checkout null guard.",
    headSha: "abc123def4567890abc123def4567890abc123de",
    incidentId: incident.incidentId,
    issueId: "SENTRY-123",
    jobId: job.jobId,
    mrReadiness: "Ready for review.",
    mrUrl: "https://gitlab.example/incidents/merge_requests/7",
    provider: "gitlab",
    repoId: "repo-api",
    repoPath: "/allowed/repo-api",
    sourceBranch: "incident/SENTRY-123",
    targetBranch: "main",
    verificationSummary: "passed",
  })
  return store
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("incident handoff MCP tools", () => {
  it("returns structured handoff content by issue id", async () => {
    // Given: a read-only store with a persisted handoff.
    const dbPath = createTempDbPath()
    const writable = seedHandoff(dbPath)
    writable.close()
    const store = openSqliteStateStore({ path: dbPath, accessMode: "read", createIfMissing: false })
    const handlers = createIncidentHandoffToolHandlers(store)

    // When: Codex asks for a single incident handoff.
    const result = await handlers.incident_get_handoff({ issueId: "SENTRY-123" })

    // Then: both MCP text content and structuredContent carry the handoff.
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Handoff SENTRY-123: https://gitlab.example/incidents/merge_requests/7 on incident/SENTRY-123.",
      },
    ])
    expect(result.structuredContent).toMatchObject({
      issueId: "SENTRY-123",
      mrUrl: "https://gitlab.example/incidents/merge_requests/7",
      sourceBranch: "incident/SENTRY-123",
      targetBranch: "main",
      followUpPrompt: "Open the MR branch and review checkout null guard.",
    })
    store.close()
  })

  it("lists latest handoffs with schemas and read-only annotations", async () => {
    // Given: a seeded read-only handoff store.
    const dbPath = createTempDbPath()
    const writable = seedHandoff(dbPath)
    writable.close()
    const store = openSqliteStateStore({ path: dbPath, accessMode: "read", createIfMissing: false })
    const handlers = createIncidentHandoffToolHandlers(store)

    // When: Codex lists handoffs and inspects tool definitions.
    const result = await handlers.incident_list_handoffs({ limit: 5 })

    // Then: list output is structured and every tool is marked read-only/idempotent.
    expect(result.structuredContent).toMatchObject({
      handoffs: [
        {
          issueId: "SENTRY-123",
          mrUrl: "https://gitlab.example/incidents/merge_requests/7",
          sourceBranch: "incident/SENTRY-123",
        },
      ],
    })
    for (const definition of Object.values(incidentHandoffToolDefinitions)) {
      expect(definition.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
      expect(definition.outputSchema).toBeDefined()
    }
    store.close()
  })

  it("returns only the follow-up prompt and a typed not-found result", async () => {
    // Given: a read-only store with one known handoff.
    const dbPath = createTempDbPath()
    const writable = seedHandoff(dbPath)
    writable.close()
    const store = openSqliteStateStore({ path: dbPath, accessMode: "read", createIfMissing: false })
    const handlers = createIncidentHandoffToolHandlers(store)

    // When: Codex asks for the prompt and an unknown issue.
    const prompt = await handlers.incident_get_followup_prompt({ issueId: "SENTRY-123" })
    const missing = await handlers.incident_get_handoff({ issueId: "SENTRY-missing" })

    // Then: prompt lookup is concise and missing handoffs are structured.
    expect(prompt.structuredContent).toEqual({
      issueId: "SENTRY-123",
      found: true,
      followUpPrompt: "Open the MR branch and review checkout null guard.",
    })
    expect(missing.structuredContent).toEqual({
      issueId: "SENTRY-missing",
      found: false,
    })
    expect(missing.content).toEqual([
      {
        type: "text",
        text: "No handoff found for SENTRY-missing.",
      },
    ])
    store.close()
  })
})
