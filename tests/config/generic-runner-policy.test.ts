import { describe, expect, it } from "vitest"

import { runnersSchema } from "../../src/config/runner-policy.js"

const commandDefinitions = [
  { args: ["analysis"], command: "echo", id: "echo-analysis", type: "generic" },
  { args: ["fix"], command: "echo", id: "echo-fix", type: "generic" },
] as const

const genericProviderInput = (generic: {
  readonly analysisCommandId?: string
  readonly fixCommandId?: string
}) => ({
  generic: {
    commandAllowlist: ["echo"],
    definitions: commandDefinitions,
    ...generic,
  },
  provider: "generic",
})

describe("generic provider runner policy config boundary", () => {
  it("rejects provider generic when analysisCommandId is missing", () => {
    // Given: production config selects the generic provider without an analysis command id.
    const input = genericProviderInput({ fixCommandId: "echo-fix" })

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: config loading fails before runtime factory selection.
    expect(result.success).toBe(false)
  })

  it("rejects provider generic when fixCommandId is missing", () => {
    // Given: production config selects the generic provider without a fix command id.
    const input = genericProviderInput({ analysisCommandId: "echo-analysis" })

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: config loading fails before runtime factory selection.
    expect(result.success).toBe(false)
  })

  it("rejects provider generic when mode command ids are not defined", () => {
    // Given: generic mode ids point at commands absent from definitions.
    const input = genericProviderInput({
      analysisCommandId: "missing-analysis",
      fixCommandId: "missing-fix",
    })

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: config loading reports both missing command id references.
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "generic.analysisCommandId",
      "generic.fixCommandId",
    ])
  })

  it("normalizes valid generic provider mode ids with legacy definitions and allowlist", () => {
    // Given: legacy generic definitions and allowlist remain at runners.* during migration.
    const input = {
      definitions: commandDefinitions,
      generic: {
        analysisCommandId: "echo-analysis",
        fixCommandId: "echo-fix",
      },
      genericCommandAllowlist: ["echo"],
      provider: "generic",
    }

    // When: runner policy crosses the Zod config boundary.
    const result = runnersSchema.safeParse(input)

    // Then: the normalized generic block contains executable mode ids and legacy policy.
    expect(result.success).toBe(true)
    expect(result.data?.generic).toEqual({
      analysisCommandId: "echo-analysis",
      commandAllowlist: ["echo"],
      definitions: commandDefinitions,
      fixCommandId: "echo-fix",
    })
  })
})
