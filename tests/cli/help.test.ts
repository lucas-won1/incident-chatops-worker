import { describe, expect, it } from "vitest"

import { runCli } from "../../src/cli.js"

describe("CLI help", () => {
  it("prints the command shell when help is requested", () => {
    // Given: a user asking for the incident worker command surface.
    const args = ["--help"]

    // When: the CLI shell handles the request.
    const result = runCli(args)

    // Then: every planned top-level command is discoverable.
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("daemon")
    expect(result.stdout).toContain("doctor")
    expect(result.stdout).toContain("status")
    expect(result.stdout).toContain("run-once")
    expect(result.stdout).toContain("logs")
  })

  it("returns an unknown-command result when the command is not planned", () => {
    // Given: a user enters a command outside the Todo 1 shell.
    const args = ["nope"]

    // When: the CLI parses the command.
    const result = runCli(args)

    // Then: the failure is concise and contains no stack trace.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown command: nope")
    expect(result.stderr).not.toContain("at ")
  })

  it.each([
    ["db helper", ["dev", "db-smoke"]],
    ["git helper", ["dev", "git-smoke"]],
  ] as const)("rejects removed runtime dev %s command", (_label, args) => {
    // Given: a removed runtime helper command is requested through the shipped CLI.
    const result = runCli(args)

    // When / Then: the command is treated as outside the public dev surface.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unknown dev command")
  })
})
