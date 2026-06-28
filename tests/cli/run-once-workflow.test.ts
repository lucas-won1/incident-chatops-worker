import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"

import { fakeWorkflowRootThreadTs } from "../../src/cli/fake-workflow-runtime.js"
import { runCliAsync } from "../../src/cli.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

const issueId = "SENTRY-RUN-ONCE-11"

type FakeSentryServer = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
  readonly requests: readonly string[]
}

const sentryIssuePage = () => [
  {
    firstSeen: "2026-06-26T00:00:00.000Z",
    id: issueId,
    lastSeen: "2026-06-26T00:05:00.000Z",
    permalink: "https://sentry.example/issues/SENTRY-RUN-ONCE-11",
    project: { slug: "frontend" },
    status: "unresolved",
    title: "Standalone run-once workflow regression",
  },
]

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve()
        return
      }
      reject(error)
    })
  })

const startFakeSentryServer = async (): Promise<FakeSentryServer> => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(sentryIssuePage()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    await closeServer(server)
    throw new Error("fake Sentry server did not bind a TCP port")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/0`,
    close: () => closeServer(server),
    requests,
  }
}

const readWorkflowSideEffects = (dbPath: string) => {
  const store = openSqliteStateStore({ accessMode: "read", createIfMissing: false, path: dbPath })
  try {
    return {
      auditActions: store.listAuditEntries().map((entry) => entry.action),
      threadTs: store.getIncidentByIssueId(issueId)?.threadTs,
    }
  } finally {
    store.close()
  }
}

const installFakeSlackPostMessage = (): (() => void) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === "https://slack.com/api/chat.postMessage") {
      return new Response(JSON.stringify({ ok: true, ts: fakeWorkflowRootThreadTs }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    }
    return originalFetch(input, init)
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

describe("standalone Sentry run-once workflow routing", () => {
  it("routes detected Sentry issues through IncidentWorkflow initial Slack handling", async () => {
    // Given: standalone run-once points at a local Sentry API and fake-mode Slack.
    const fakeSentry = await startFakeSentryServer()
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), {
      FAKE_MODE: "1",
      SENTRY_BASE_URL: fakeSentry.baseUrl,
    })

    try {
      // When: the actual standalone --source sentry command polls one issue.
      const result = await runCliAsync([
        "run-once",
        "--source",
        "sentry",
        "--config",
        configPath,
        "--env-file",
        envPath,
      ])
      const sideEffects = readWorkflowSideEffects(dbPath)

      // Then: success output is backed by workflow side effects, not storage-only writes.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("source=sentry status=ok new=1")
      expect(fakeSentry.requests).toEqual([
        "/api/0/organizations/demo-org/issues/?query=is%3Aunresolved+project%3Afrontend",
      ])
      expect(sideEffects).toEqual({
        auditActions: expect.arrayContaining(["slack.post_message.fake", "incident.detected"]),
        threadTs: fakeWorkflowRootThreadTs,
      })
    } finally {
      await fakeSentry.close()
    }
  })

  it("routes plain run-once without --source through IncidentWorkflow initial Slack handling", async () => {
    // Given: the public plain run-once command points at local Sentry and Slack fakes.
    const fakeSentry = await startFakeSentryServer()
    const restoreFetch = installFakeSlackPostMessage()
    const { configPath, dbPath, envPath } = writeFixtureFiles(createTempDir(), {
      FAKE_MODE: "0",
      SENTRY_BASE_URL: fakeSentry.baseUrl,
    })

    try {
      // When: the actual plain command polls one issue.
      const result = await runCliAsync(["run-once", "--config", configPath, "--env-file", envPath])
      const sideEffects = readWorkflowSideEffects(dbPath)

      // Then: success output is backed by workflow side effects, not a pending storage-only row.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("source=sentry status=ok new=1")
      expect(fakeSentry.requests).toEqual([
        "/api/0/organizations/demo-org/issues/?query=is%3Aunresolved+project%3Afrontend",
      ])
      expect(sideEffects).toEqual({
        auditActions: expect.arrayContaining(["incident.detected"]),
        threadTs: fakeWorkflowRootThreadTs,
      })
    } finally {
      restoreFetch()
      await fakeSentry.close()
    }
  })
})
