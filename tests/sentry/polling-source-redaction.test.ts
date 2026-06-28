import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { pollOnce } from "../../src/sentry/index.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { json, startSentryServer } from "./sentry-test-server.js"

const exactEnvFileSecret = "plain-env-file-secret-f4"
const tempDirs: string[] = []

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-sentry-redaction-"))
  tempDirs.push(dir)
  return dir
}

const issueWithTitle = (title: string) => ({
  culprit: "Checkout.tsx in submitOrder",
  firstSeen: "2026-06-26T00:00:00.000Z",
  id: "1234567890",
  lastSeen: "2026-06-26T00:05:00.000Z",
  permalink: "https://sentry.example/issues/1234567890/",
  project: { slug: "frontend" },
  shortId: "FRONTEND-1",
  status: "unresolved",
  title,
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Sentry polling snapshot redaction", () => {
  it("redacts exact env-file secret values before saving polling issue snapshots", async () => {
    // Given: Sentry returns an issue-list title containing a non-token-shaped env-file secret.
    const server = await startSentryServer((_request, response) => {
      json(response, [issueWithTitle(`Checkout crash ${exactEnvFileSecret}`)])
    })
    const store = openSqliteStateStore({ path: join(createTempDir(), "state.sqlite") })

    try {
      // When: polling saves the issue-list snapshot.
      await pollOnce({
        authToken: "sntrys_redacted_example",
        baseUrl: server.baseUrl,
        projects: [
          { organizationSlug: "demo-org", projectSlug: "frontend", slackChannel: "#incidents" },
        ],
        secretRedactionValues: [exactEnvFileSecret],
        store,
      })

      // Then: the persisted SQLite snapshot masks the exact secret and keeps useful issue fields.
      const incident = store.getIncidentByIssueId("1234567890")
      const snapshot = store.getLatestSentryIssueSnapshot(incident?.incidentId ?? "")?.snapshotJson
      if (snapshot === undefined) {
        throw new Error("expected saved Sentry issue snapshot")
      }
      expect(snapshot).not.toContain(exactEnvFileSecret)
      expect(snapshot).toContain("[REDACTED]")
      expect(snapshot).toContain("Checkout crash")
      expect(snapshot).toContain("1234567890")
    } finally {
      store.close()
      await server.close()
    }
  })
})
