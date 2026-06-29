import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

describe("state DB public configuration surface", () => {
  it("keeps STATE_DB_PATH optional in the env example", () => {
    // Given: the public env example used by Quick Start setup.
    const envExample = readFileSync(".env.example", "utf8")
    const activeStatePathLines = envExample
      .split(/\r?\n/u)
      .filter((line) => line.trim().startsWith("STATE_DB_PATH="))

    // When / Then: the example must not set the override by default.
    expect(activeStatePathLines).toEqual([])
    expect(envExample).toMatch(/#\s*STATE_DB_PATH=.*state\.sqlite/u)
  })

  it("documents the single-daemon-per-state-DB operating model", () => {
    // Given: the operations guide state DB section.
    const operations = readFileSync("docs/operations.md", "utf8")

    // When / Then: operators are warned not to share one DB across concurrent daemons.
    expect(operations).toMatch(/single[- ]daemon[- ]per[- ]state[- ]DB/i)
    expect(operations).toMatch(/STATE_DB_PATH/)
  })
})
