import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

describe("README Quick Start", () => {
  it("documents the daemon command without stale Todo wording", async () => {
    // Given: the public README Quick Start.
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8")

    // When: users read the daemon startup step.
    const quickStart = readme.slice(
      readme.indexOf("## Quick Start"),
      readme.indexOf("## Slack Setup"),
    )

    // Then: the daemon command is current and no Todo-era wording remains.
    expect(quickStart).toContain(
      "node dist/cli.js daemon --env-file .env --config incident-worker.config.yaml",
    )
    expect(quickStart).not.toContain("Todo 11 daemon wiring")
  })
})
