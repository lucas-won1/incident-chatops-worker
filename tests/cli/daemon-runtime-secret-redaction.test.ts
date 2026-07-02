import { readFileSync } from "node:fs"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  envFileSecrets,
  expectedChildEnvCapture,
  runRedactionScenario,
} from "./daemon-runtime-redaction-support.js"

vi.mock("ky", () => ({
  default: {
    post: vi.fn(async () => ({
      json: async () => ({ ok: true, ts: "1712345678.000200" }),
      status: 200,
    })),
  },
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("production daemon env-file secret redaction", () => {
  it("redacts env-file-only service tokens from Codex output without passing them to the child env", async () => {
    // Given: production settings contain service tokens that are not present in process.env.
    const result = await runRedactionScenario({
      issueId: "SENTRY-PROD-ENV",
      provider: "gitlab",
    })
    // When: production runtime handles an approved analysis action through the real Codex runner.
    expect(result.summaryMarkdown).toContain("[REDACTED]")
    expect(result.summaryMarkdown).not.toContain(envFileSecrets.gitlab)
    // Then: service tokens are absent from the child env capture but redacted from persisted output.
    expect(JSON.parse(readFileSync(result.capturePath, "utf8"))).toEqual(expectedChildEnvCapture)
  })

  it("redacts selected GitHub service token from Codex output without passing it to the child env", async () => {
    // Given: production GitHub settings contain a GitHub token that is not present in process.env.
    const result = await runRedactionScenario({
      issueId: "SENTRY-PROD-GITHUB",
      provider: "github",
    })
    // When: production runtime handles an approved analysis action through the real Codex runner.
    expect(result.summaryMarkdown).toContain("[REDACTED]")
    expect(result.summaryMarkdown).not.toContain(envFileSecrets.github)
    // Then: GitHub token is absent from the child env capture but redacted from persisted output.
    expect(JSON.parse(readFileSync(result.capturePath, "utf8"))).toEqual(expectedChildEnvCapture)
  })
})
