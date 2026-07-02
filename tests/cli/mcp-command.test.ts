import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { resolveMcpStateDbPath } from "../../src/cli/mcp.js"
import { runCliAsync } from "../../src/cli.js"

const tempDirs: string[] = []

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-mcp-cli-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("MCP CLI command", () => {
  it("resolves the state DB path from env-file without parsing service token env", () => {
    // Given: an env file that contains only the MCP state database path.
    const dir = createTempDir()
    const dbPath = join(dir, "state.sqlite")
    const envPath = join(dir, "mcp.env")
    writeFileSync(envPath, `STATE_DB_PATH=${dbPath}\n`)

    // When: the MCP command resolves its database path.
    const resolved = resolveMcpStateDbPath(["--env-file", envPath], {}, "linux")

    // Then: no Slack, Sentry, or provider token values are required.
    expect(resolved).toBe(dbPath)
  })

  it("fails on a missing read-only DB before token validation", async () => {
    // Given: no service-token environment and an explicit missing database path.
    const dbPath = join(createTempDir(), "missing.sqlite")

    // When: the MCP command starts against the missing database.
    const result = await runCliAsync(["mcp", "--db", dbPath])

    // Then: the failure is about the state DB, not Slack/Sentry/provider tokens.
    expect(result.exitCode).toBe(66)
    expect(result.stderr).toContain("SQLite database does not exist")
    expect(result.stderr).not.toContain("SLACK")
    expect(result.stderr).not.toContain("SENTRY")
    expect(result.stderr).not.toContain("GIT")
  })
})
