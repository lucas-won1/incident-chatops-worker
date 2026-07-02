import { describe, expect, it } from "vitest"

import { parseWorkerEnv } from "../../src/config/index.js"

const validEnv = {
  GITLAB_TOKEN: "glpat-redacted-example",
  HOME: "/Users/won",
  SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
  SLACK_APP_TOKEN: "xapp-redacted-example",
  SLACK_BOT_TOKEN: "xoxb-redacted-example",
}

type StatePathScenario = {
  readonly name: string
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string>>
  readonly expected: string
}

const statePathScenarios = [
  {
    name: "macOS",
    platform: "darwin",
    env: { HOME: "/Users/demo" },
    expected: "/Users/demo/Library/Application Support/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Linux XDG",
    platform: "linux",
    env: { HOME: "/home/demo", XDG_STATE_HOME: "/tmp/xdg-state" },
    expected: "/tmp/xdg-state/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Linux home fallback",
    platform: "linux",
    env: { HOME: "/home/demo" },
    expected: "/home/demo/.local/state/incident-chatops-worker/state.sqlite",
  },
  {
    name: "Windows",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
    expected: "C:\\Users\\demo\\AppData\\Local\\incident-chatops-worker\\state.sqlite",
  },
] satisfies readonly StatePathScenario[]

describe("worker env parsing", () => {
  it("defaults the Sentry poll interval to 300 seconds when env omits it", () => {
    // Given: required secrets are present and polling env is omitted.
    const env = validEnv

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env)

    // Then: the conservative default cadence is used.
    expect(parsed.sentryPollIntervalSeconds).toBe(300)
    expect(parsed.sentryPollMinIntervalSeconds).toBe(60)
  })

  it.each(statePathScenarios)(
    "uses the automatic $name state database path when env omits STATE_DB_PATH",
    ({ env, expected, platform }) => {
      // Given: required secrets are present and the OS state base is available.
      const input = { ...validEnv, ...env }

      // When: env crosses the config boundary without an explicit DB override.
      const parsed = parseWorkerEnv(input, { platform })

      // Then: the durable OS-specific state path is selected.
      expect(parsed.stateDbPath).toBe(expected)
    },
  )

  it("uses explicit STATE_DB_PATH override instead of the automatic state database path", () => {
    // Given: env includes both a HOME base and an explicit DB path.
    const env = {
      ...validEnv,
      HOME: "/Users/demo",
      STATE_DB_PATH: "/tmp/incident-worker/override.sqlite",
    }

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env, { platform: "darwin" })

    // Then: the explicit override wins.
    expect(parsed.stateDbPath).toBe("/tmp/incident-worker/override.sqlite")
  })

  it("rejects missing OS state base env when STATE_DB_PATH is omitted", () => {
    // Given: env omits both STATE_DB_PATH and the required macOS HOME base.
    const env = {
      GITLAB_TOKEN: "glpat-redacted-example",
      SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
      SLACK_APP_TOKEN: "xapp-redacted-example",
      SLACK_BOT_TOKEN: "xoxb-redacted-example",
    }

    // When / Then: validation fails instead of falling back to the working directory.
    expect(() => parseWorkerEnv(env, { platform: "darwin" })).toThrow(/HOME/)
  })

  it("uses the env poll interval override when it is not below the minimum", () => {
    // Given: required secrets and an explicit safe polling cadence.
    const env = {
      ...validEnv,
      SENTRY_POLL_INTERVAL_SECONDS: "600",
      SENTRY_POLL_MIN_INTERVAL_SECONDS: "60",
    }

    // When: env crosses the config boundary.
    const parsed = parseWorkerEnv(env)

    // Then: the override is preserved exactly.
    expect(parsed.sentryPollIntervalSeconds).toBe(600)
  })

  it("rejects an env poll interval below the configured minimum", () => {
    // Given: polling is configured faster than the minimum.
    const env = {
      ...validEnv,
      SENTRY_POLL_INTERVAL_SECONDS: "30",
      SENTRY_POLL_MIN_INTERVAL_SECONDS: "60",
    }

    // When / Then: validation rejects the unsafe cadence by env name.
    expect(() => parseWorkerEnv(env)).toThrow(/SENTRY_POLL_INTERVAL_SECONDS/)
  })
})
