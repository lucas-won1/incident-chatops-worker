import { describe, expect, it } from "vitest"

import {
  ensureWorkflowVerificationPassed,
  workflowVerificationSummary,
} from "../../src/workflow/verification.js"

const resultWithVerification = (verificationResults: string | undefined) => ({
  analysis: "analysis",
  command: "fixture",
  mode: "fix_and_mr" as const,
  stderr: "",
  stdout: "",
  ...(verificationResults === undefined ? {} : { verificationResults }),
})

describe("workflow verification parsing", () => {
  it.each([
    "error: pnpm test exited 1",
    "tests timed out",
    "verification skipped by operator",
    "",
    undefined,
  ] as const)("fails closed for non-passing verification text %s", (verificationResults) => {
    // Given: runner verification output lacks an explicit parsed pass signal.
    const result = resultWithVerification(verificationResults)

    // When / Then: the workflow refuses to push or create an MR from ambiguous text.
    expect(workflowVerificationSummary(result).status).not.toBe("passed")
    expect(() => ensureWorkflowVerificationPassed(result)).toThrow(/verification/u)
  })

  it("accepts explicit passed verification text", () => {
    // Given: runner verification output starts with a typed pass status.
    const result = resultWithVerification("passed: pnpm vitest run")

    // When / Then: the workflow accepts the explicit passing signal.
    expect(workflowVerificationSummary(result).status).toBe("passed")
    expect(() => ensureWorkflowVerificationPassed(result)).not.toThrow()
  })
})
