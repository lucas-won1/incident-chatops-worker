import { describe, expect, it } from "vitest"

import { runnersSchema } from "../../src/config/runner-policy.js"

type ClaudeCodeRunnerPolicyInput = {
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
  readonly extraEnvAllowlist?: readonly string[]
  readonly permissionMode?: string
}

type RunnerPolicyInput = {
  readonly claudeCode?: ClaudeCodeRunnerPolicyInput
  readonly codex?: {
    readonly extraEnvAllowlist?: readonly string[]
    readonly mode?: "cli" | "app-server" | "app"
    readonly workspaceWriteNetworkAccess?: boolean
  }
  readonly projectEnv?: {
    readonly args?: readonly string[]
    readonly command: string
  }
}

const genericDefinitions = [
  { args: ["analysis"], command: "echo", id: "echo-analysis", type: "generic" },
  { args: ["fix"], command: "echo", id: "echo-fix", type: "generic" },
] as const

const runnerPolicyInput = (input: RunnerPolicyInput) => ({
  ...input,
  definitions: [{ args: [], command: "echo", id: "echo-safe", type: "generic" }],
  genericCommandAllowlist: ["echo"],
  provider: "claude-code",
})

describe("runner provider generic config requirements", () => {
  it("accepts a project environment wrapper for the selected runner", () => {
    // Given: YAML-derived runner policy declares a project toolchain wrapper.
    const input = {
      projectEnv: {
        args: ["exec", "--"],
        command: "/Users/won/.local/bin/mise",
      },
      provider: "codex",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: the wrapper is preserved as non-secret execution policy.
    expect(result.success).toBe(true)
    expect(result.data?.projectEnv).toEqual({
      args: ["exec", "--"],
      command: "/Users/won/.local/bin/mise",
    })
  })

  it("accepts Codex provider config without generic definitions or allowlist", () => {
    // Given: production config selects Codex and only provides Codex instance settings.
    const input = {
      codex: { extraEnvAllowlist: ["LANG"] },
      provider: "codex",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: generic command policy is not required for the Codex provider.
    expect(result.success).toBe(true)
    expect(result.data?.generic.definitions).toEqual([])
    expect(result.data?.genericCommandAllowlist).toEqual([])
  })

  it("rejects Codex app-server mode because Codex is CLI-only", () => {
    // Given: production config declares the removed Codex app-server execution mode.
    const input = {
      codex: { mode: "app-server" },
      provider: "codex",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: config fails closed with a migration message naming the removed field.
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "runners.codex.mode is no longer supported; remove it because Codex runner execution is CLI-only",
    )
  })

  it("rejects legacy Codex app mode because Codex modes are removed", () => {
    // Given: production config requests a true Codex App-managed worktree mode.
    const input = {
      codex: { mode: "app" },
      provider: "codex",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: config fails closed instead of silently using app-server semantics.
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "runners.codex.mode is no longer supported; remove it because Codex runner execution is CLI-only",
    )
  })

  it("accepts Claude Code provider config without generic definitions or allowlist", () => {
    // Given: production config selects Claude Code and only provides Claude instance settings.
    const input = {
      claudeCode: { allowedTools: ["Read"], disallowedTools: [], extraEnvAllowlist: ["LANG"] },
      provider: "claude-code",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: generic command policy is not required for the Claude Code provider.
    expect(result.success).toBe(true)
    expect(result.data?.generic.definitions).toEqual([])
    expect(result.data?.genericCommandAllowlist).toEqual([])
  })

  it("rejects Generic provider config without generic definitions or allowlist", () => {
    // Given: production config selects the generic provider without command policy.
    const input = { provider: "generic" }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: generic stays fail-closed because it needs explicit runnable commands.
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "generic command allowlist must not be empty",
    )
  })

  it("rejects partial generic config when a generic block is present", () => {
    // Given: a non-generic provider still includes an incomplete generic block.
    const input = {
      generic: {
        analysisCommandId: "echo-analysis",
        definitions: genericDefinitions,
      },
      provider: "codex",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: partial generic policy is rejected instead of being silently ignored.
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(
      "generic.commandAllowlist",
    )
  })
})

describe("Claude Code runner policy config boundary", () => {
  it.each([
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
  ] as const)("rejects flag-looking permission mode %s", (permissionMode) => {
    // Given: YAML-derived runner config attempts to pass a Claude bypass flag as permissionMode.
    const input = runnerPolicyInput({ claudeCode: { permissionMode } })

    // When: the runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: parsing fails closed before adapter construction.
    expect(result.success).toBe(false)
  })

  it("rejects Claude Code allowedTools containing skip-permissions bypass token", () => {
    // Given: YAML-derived runner config attempts to allow a Claude permission bypass token.
    const input = runnerPolicyInput({
      claudeCode: { allowedTools: ["Read", "--dangerously-skip-permissions"] },
    })

    // When: the runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: parsing fails closed before adapter construction.
    expect(result.success).toBe(false)
  })

  it.each(["--allow-dangerously-skip-permissions", "--dangerously-bypass-hook-trust"] as const)(
    "rejects Claude Code disallowedTools containing bypass token %s",
    (token) => {
      // Given: YAML-derived runner config attempts to pass a Claude bypass token through tools config.
      const input = runnerPolicyInput({ claudeCode: { disallowedTools: ["Read", token] } })

      // When: the runner policy crosses the Zod config boundary.
      const result = runnersSchema.safeParse(input)

      // Then: parsing fails closed before adapter construction.
      expect(result.success).toBe(false)
    },
  )

  it("rejects lowercase secret-looking Codex env allowlist names", () => {
    // Given: YAML-derived runner config allowlists a lowercase secret-looking env name.
    const input = runnerPolicyInput({ codex: { extraEnvAllowlist: ["github_token"] } })

    // When: the runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: parsing fails closed before adapter construction.
    expect(result.success).toBe(false)
  })

  it("rejects mixed-case secret-looking Claude Code env allowlist names", () => {
    // Given: YAML-derived runner config allowlists a mixed-case secret-looking env name.
    const input = runnerPolicyInput({ claudeCode: { extraEnvAllowlist: ["auth_header"] } })

    // When: the runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: parsing fails closed before adapter construction.
    expect(result.success).toBe(false)
  })
})
