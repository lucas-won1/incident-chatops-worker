import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import { createTempDir, writeFixtureFiles } from "./command-fixtures.js"

describe("production CLI commands", () => {
  it("does not ship the GitLab MR smoke server command", async () => {
    // Given: a removed development smoke helper that used to start a local HTTP server.
    const args = ["dev", "gitlab-mr-smoke"]

    // When: the production CLI dispatcher receives that command.
    const result = await runCliAsync(args)

    // Then: no shipped runtime command surface remains for the server-backed smoke helper.
    expect(result.exitCode).toBe(64)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("Unknown dev command: gitlab-mr-smoke\n")
  })

  it("doctor validates fake token reachability without dumping secrets", async () => {
    // Given: valid fake mode settings with placeholder tokens.
    const { configPath, envPath } = writeFixtureFiles(createTempDir())

    // When: doctor checks the setup.
    const result = await runCliAsync(["doctor", "--config", configPath, "--env-file", envPath])

    // Then: reachability is explicit and tokens remain redacted.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Slack bot token: present (reachability skipped in fake mode)")
    expect(result.stdout).toContain("Slack app token: present (reachability skipped in fake mode)")
    expect(result.stdout).toContain("Sentry token: present (reachability skipped in fake mode)")
    expect(result.stdout).not.toContain("xapp-redacted-example")
    expect(result.stdout).not.toContain("sntrys_redacted_example")
  })

  it("doctor reports production reachability as checked rather than not attempted", async () => {
    // Given: production-mode settings and an injected offline reachability checker.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })

    // When: doctor validates live-mode setup without using the network.
    const result = await runCliAsync(["doctor", "--config", configPath, "--env-file", envPath], {
      reachability: () => ({
        gitlab: { kind: "warning", message: "offline probe unavailable" },
        sentry: { kind: "ok", message: "authenticated probe ok" },
        slackApp: { kind: "ok", message: "apps.connections.open ok" },
        slackBot: { kind: "ok", message: "auth.test ok" },
      }),
    })

    // Then: output is honest, redacted, and never calls skipped checks success.
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Slack bot token: present (reachability ok: auth.test ok)")
    expect(result.stdout).toContain(
      "Slack app token: present (reachability ok: apps.connections.open ok)",
    )
    expect(result.stdout).toContain(
      "Sentry token: present (reachability ok: authenticated probe ok)",
    )
    expect(result.stdout).toContain(
      "GitLab token: present (reachability warning: offline probe unavailable)",
    )
    expect(result.stdout).not.toContain("reachability not attempted")
    expect(result.stdout).not.toContain("xoxb-redacted-example")
  })

  it("doctor reports Slack app-token reachability failures separately from bot-token success", async () => {
    // Given: production-mode settings with a successful bot probe and failed app-token probe.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), { FAKE_MODE: "0" })

    // When: doctor validates injected reachability statuses.
    const result = await runCliAsync(["doctor", "--config", configPath, "--env-file", envPath], {
      reachability: () => ({
        gitlab: { kind: "ok", message: "user probe HTTP 200" },
        sentry: { kind: "ok", message: "organizations probe HTTP 200" },
        slackApp: { kind: "warning", message: "apps.connections.open HTTP 401" },
        slackBot: { kind: "ok", message: "auth.test ok" },
      }),
    })

    // Then: the app-token issue is nonzero and explicit.
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Slack bot token: present (reachability ok: auth.test ok)")
    expect(result.stdout).toContain(
      "Slack app token: present (reachability warning: apps.connections.open HTTP 401)",
    )
  })

  it("doctor fails missing Slack tokens without leaking other env values", async () => {
    // Given: the Slack app and bot tokens are missing but other secrets are present.
    const { configPath, envPath } = writeFixtureFiles(createTempDir(), {
      SLACK_APP_TOKEN: "",
      SLACK_BOT_TOKEN: "",
    })

    // When: doctor validates the env boundary.
    const result = await runCliAsync(["doctor", "--config", configPath, "--env-file", envPath])

    // Then: the missing token names are reported without dumping unrelated secrets.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("SLACK_APP_TOKEN")
    expect(result.stdout).toContain("SLACK_BOT_TOKEN")
    expect(result.stdout).not.toContain("sntrys_redacted_example")
    expect(result.stdout).not.toContain("glpat-redacted-example")
    expect(result.stderr).toBe("")
  })
})
