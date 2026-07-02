import { z } from "zod"

import { RunnerOutputParseError } from "./errors.js"

export const claudeAnalysisOutputSchema = z.object({ analysis: z.string().min(1) }).strict()

export const claudeFixOutputSchema = z
  .object({
    analysis: z.string().min(1),
    branchInfo: z.string().min(1),
    changesSummary: z.string().min(1),
    mergeRequestBody: z.string().min(1),
    mrReadiness: z.string().min(1),
    verificationResults: z.string().min(1),
  })
  .strict()

const claudeResultEnvelopeSchema = z
  .object({ result: z.union([z.string(), z.record(z.string(), z.unknown())]) })
  .passthrough()

export const analysisFields = ["analysis"] as const

export const fixFields = [
  "analysis",
  "changesSummary",
  "verificationResults",
  "branchInfo",
  "mrReadiness",
  "mergeRequestBody",
] as const

export const jsonSchemaFor = (fields: readonly string[]): Readonly<Record<string, unknown>> => ({
  additionalProperties: false,
  properties: Object.fromEntries(fields.map((field) => [field, { minLength: 1, type: "string" }])),
  required: fields,
  type: "object",
})

const resultPayload = (result: string | Readonly<Record<string, unknown>>): unknown => {
  if (typeof result !== "string") {
    return result
  }
  try {
    return JSON.parse(result)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RunnerOutputParseError(`Claude Code result JSON is malformed: ${error.message}`)
    }
    throw error
  }
}

export const parseClaudeOutput = <T>(stdout: string, schema: z.ZodType<T>): T => {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(stdout)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RunnerOutputParseError(`Claude Code JSON is malformed: ${error.message}`)
    }
    throw error
  }

  const direct = schema.safeParse(parsedJson)
  if (direct.success) {
    return direct.data
  }
  const envelope = claudeResultEnvelopeSchema.safeParse(parsedJson)
  if (!envelope.success) {
    throw new RunnerOutputParseError(`Claude Code JSON schema mismatch: ${direct.error.message}`)
  }
  const parsed = schema.safeParse(resultPayload(envelope.data.result))
  if (parsed.success) {
    return parsed.data
  }
  throw new RunnerOutputParseError(
    `Claude Code result JSON schema mismatch: ${parsed.error.message}`,
  )
}
