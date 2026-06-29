import { describe, expect, it } from "vitest"

import { redactSensitiveText } from "../../src/shared/redaction.js"

describe("sensitive text redaction", () => {
  it("redacts GitHub token-looking values without configured exact secrets", () => {
    // Given: untrusted runtime text carries token-shaped GitHub values.
    const text = ["github_pat_x", "ghp_x", "gho_x", "ghu_x", "ghs_x", "ghr_x"].join(" ")

    // When: the shared runtime redactor handles the text without exact secret input.
    const redacted = redactSensitiveText(text)

    // Then: every GitHub token-looking value is redacted by pattern.
    expect(redacted).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]")
  })
})
