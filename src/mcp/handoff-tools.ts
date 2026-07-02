import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { IncidentHandoffRecord } from "../state/types.js"

type IncidentHandoffLookupStore = {
  readonly getIncidentHandoffByIssueId: (issueId: string) => IncidentHandoffRecord | undefined
  readonly listIncidentHandoffs: (limit: number) => readonly IncidentHandoffRecord[]
}

type IssueIdInput = {
  readonly issueId: string
}

type ListHandoffsInput = {
  readonly limit?: number | undefined
}

type IncidentHandoffToolHandlers = {
  readonly incident_get_handoff: (input: IssueIdInput) => Promise<CallToolResult>
  readonly incident_list_handoffs: (input: ListHandoffsInput) => Promise<CallToolResult>
  readonly incident_get_followup_prompt: (input: IssueIdInput) => Promise<CallToolResult>
}

const defaultHandoffLimit = 20
const maxHandoffLimit = 50

const readOnlyAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
} as const

const issueIdInputSchema = z.object({
  issueId: z.string().min(1),
})

const listHandoffsInputSchema = z.object({
  limit: z.number().int().min(1).max(maxHandoffLimit).optional(),
})

const handoffStructuredSchema = z.object({
  analysisSummary: z.string().optional(),
  changesSummary: z.string().optional(),
  createdAt: z.string().optional(),
  followUpPrompt: z.string().optional(),
  found: z.boolean(),
  handoffId: z.string().optional(),
  headSha: z.string().optional(),
  incidentId: z.string().optional(),
  issueId: z.string(),
  jobId: z.string().optional(),
  mrReadiness: z.string().optional(),
  mrUrl: z.string().optional(),
  provider: z.string().optional(),
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  verificationSummary: z.string().optional(),
})

const handoffSummarySchema = z.object({
  createdAt: z.string(),
  found: z.literal(true),
  headSha: z.string(),
  issueId: z.string(),
  mrUrl: z.string(),
  provider: z.string(),
  repoId: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
})

const listHandoffsOutputSchema = z.object({
  handoffs: z.array(handoffSummarySchema),
})

const followupPromptOutputSchema = z.object({
  followUpPrompt: z.string().optional(),
  found: z.boolean(),
  issueId: z.string(),
})

export const incidentHandoffToolDefinitions = {
  incident_get_handoff: {
    description: "Look up the latest persisted incident handoff by Sentry issue id.",
    inputSchema: issueIdInputSchema.shape,
    outputSchema: handoffStructuredSchema,
    annotations: readOnlyAnnotations,
  },
  incident_list_handoffs: {
    description: "List the latest persisted incident handoffs.",
    inputSchema: listHandoffsInputSchema.shape,
    outputSchema: listHandoffsOutputSchema,
    annotations: readOnlyAnnotations,
  },
  incident_get_followup_prompt: {
    description: "Return only the Codex follow-up prompt for an incident handoff.",
    inputSchema: issueIdInputSchema.shape,
    outputSchema: followupPromptOutputSchema,
    annotations: readOnlyAnnotations,
  },
} as const

const handoffToStructured = (
  handoff: IncidentHandoffRecord,
): Readonly<Record<string, unknown>> => ({
  analysisSummary: handoff.analysisSummary,
  changesSummary: handoff.changesSummary,
  createdAt: handoff.createdAt,
  followUpPrompt: handoff.followUpPrompt,
  found: true,
  handoffId: handoff.handoffId,
  headSha: handoff.headSha,
  incidentId: handoff.incidentId,
  issueId: handoff.issueId,
  jobId: handoff.jobId,
  mrReadiness: handoff.mrReadiness,
  mrUrl: handoff.mrUrl,
  provider: handoff.provider,
  repoId: handoff.repoId,
  repoPath: handoff.repoPath,
  sourceBranch: handoff.sourceBranch,
  targetBranch: handoff.targetBranch,
  verificationSummary: handoff.verificationSummary,
})

const handoffToSummary = (handoff: IncidentHandoffRecord): Readonly<Record<string, unknown>> => ({
  createdAt: handoff.createdAt,
  found: true,
  headSha: handoff.headSha,
  issueId: handoff.issueId,
  mrUrl: handoff.mrUrl,
  provider: handoff.provider,
  repoId: handoff.repoId,
  sourceBranch: handoff.sourceBranch,
  targetBranch: handoff.targetBranch,
})

const notFoundResult = (issueId: string): CallToolResult => ({
  content: [{ type: "text", text: `No handoff found for ${issueId}.` }],
  structuredContent: { issueId, found: false },
})

export const createIncidentHandoffToolHandlers = (
  store: IncidentHandoffLookupStore,
): IncidentHandoffToolHandlers => ({
  incident_get_handoff: async (input) => {
    const parsed = issueIdInputSchema.parse(input)
    const handoff = store.getIncidentHandoffByIssueId(parsed.issueId)
    if (handoff === undefined) {
      return notFoundResult(parsed.issueId)
    }
    return {
      content: [
        {
          type: "text",
          text: `Handoff ${handoff.issueId}: ${handoff.mrUrl} on ${handoff.sourceBranch}.`,
        },
      ],
      structuredContent: handoffToStructured(handoff),
    }
  },
  incident_list_handoffs: async (input) => {
    const parsed = listHandoffsInputSchema.parse(input)
    const limit = parsed.limit ?? defaultHandoffLimit
    const handoffs = store.listIncidentHandoffs(limit).map(handoffToSummary)
    return {
      content: [{ type: "text", text: `Found ${handoffs.length} incident handoff(s).` }],
      structuredContent: { handoffs },
    }
  },
  incident_get_followup_prompt: async (input) => {
    const parsed = issueIdInputSchema.parse(input)
    const handoff = store.getIncidentHandoffByIssueId(parsed.issueId)
    if (handoff === undefined) {
      return notFoundResult(parsed.issueId)
    }
    return {
      content: [{ type: "text", text: handoff.followUpPrompt }],
      structuredContent: {
        issueId: handoff.issueId,
        found: true,
        followUpPrompt: handoff.followUpPrompt,
      },
    }
  },
})
