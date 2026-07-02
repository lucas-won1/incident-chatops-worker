import { ZodError, z } from "zod"

import { RunnerOutputParseError } from "./errors.js"
import type { RunnerModeName } from "./types.js"

export const codexAnalysisOutputSchema = z
  .object({
    analysis: z.string().min(1),
  })
  .strict()

export const codexFixOutputSchema = z
  .object({
    analysis: z.string().min(1),
    branchInfo: z.string().min(1),
    changesSummary: z.string().min(1),
    mergeRequestBody: z.string().min(1),
    mrReadiness: z.string().min(1),
    verificationResults: z.string().min(1),
  })
  .strict()

const codexAnalysisFields = ["analysis"] as const

const codexFixFields = [
  "analysis",
  "changesSummary",
  "verificationResults",
  "branchInfo",
  "mrReadiness",
  "mergeRequestBody",
] as const

export const codexJsonSchemaForMode = (mode: RunnerModeName): Readonly<Record<string, unknown>> => {
  const fields = mode === "analysis_only" ? codexAnalysisFields : codexFixFields
  return {
    additionalProperties: false,
    properties: Object.fromEntries(
      fields.map((field) => [field, { minLength: 1, type: "string" }]),
    ),
    required: fields,
    type: "object",
  }
}

export const parseCodexOutputJson = <T>(rawOutput: string, schema: z.ZodType<T>): T => {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawOutput)
    return schema.parse(parsedJson)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      throw new RunnerOutputParseError(`Codex output JSON is invalid: ${error.message}`)
    }
    throw error
  }
}
