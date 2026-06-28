import { ZodError } from "zod"

import type { WorkerEnv } from "../config/index.js"
import type { SentryProjectMapping } from "../config/policy.js"
import { redactSensitiveJsonValue } from "../shared/redaction.js"
import type {
  IncidentInput,
  IncidentRecord,
  IncidentUpsertResult,
  SentryIssueSnapshotInput,
} from "../state/types.js"
import { SentryExternalApiError, sentryParseError } from "./errors.js"
import { createSentryHttpClient } from "./http-client.js"
import { hasExhaustedSentryRateLimit, parseSentryBackoffSeconds } from "./rate-limit.js"
import { type SentryIssue, sentryIssuePageSchema } from "./schemas.js"

export type SentryPollingSchedule = {
  readonly intervalSeconds: number
  readonly minIntervalSeconds: number
}

export interface SentryIncidentStore {
  getIncidentByIssueId(issueId: string): IncidentRecord | undefined
  saveSentryIssueSnapshot?: (input: SentryIssueSnapshotInput) => unknown
  upsertIncident(input: IncidentInput): IncidentUpsertResult
}

export type PollOnceOptions = {
  readonly authToken: string
  readonly baseUrl: string
  readonly cursor?: string
  readonly onDetectedIncident?: (incident: IncidentInput) => Promise<void> | void
  readonly projects: readonly SentryProjectMapping[]
  readonly secretRedactionValues?: readonly string[]
  readonly store: SentryIncidentStore
}

export type PollOnceResult = {
  readonly status: "ok" | "degraded"
  readonly newIncidents: number
  readonly updatedIncidents: number
  readonly skippedIncidents: number
  readonly backoffSeconds?: number
  readonly detailFetches: number
  readonly nextCursor?: string
}

type PollCounts = {
  readonly newIncidents: number
  readonly updatedIncidents: number
  readonly skippedIncidents: number
}

type SaveIssueSnapshotInput = {
  readonly incidentId: string
  readonly issue: SentryIssue
  readonly secretRedactionValues: readonly string[]
  readonly store: SentryIncidentStore
}

type StoreIssueInput = {
  readonly issue: SentryIssue
  readonly onDetectedIncident: PollOnceOptions["onDetectedIncident"]
  readonly project: SentryProjectMapping
  readonly secretRedactionValues: readonly string[]
  readonly store: SentryIncidentStore
}

export const createSentryPollingSchedule = (env: WorkerEnv): SentryPollingSchedule => ({
  intervalSeconds: env.sentryPollIntervalSeconds,
  minIntervalSeconds: env.sentryPollMinIntervalSeconds,
})

const parseNextCursor = (linkHeader: string | null): string | undefined => {
  if (linkHeader === null) {
    return undefined
  }
  for (const link of linkHeader.split(",")) {
    if (!link.includes('rel="next"') || !link.includes('results="true"')) {
      continue
    }
    const cursorPart = link
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith('cursor="'))
    if (cursorPart !== undefined) {
      return cursorPart.slice(8, -1)
    }
  }
  return undefined
}

const incidentInput = (issue: SentryIssue, project: SentryProjectMapping): IncidentInput => ({
  channelId: project.slackChannel,
  firstSeenAt: issue.firstSeen,
  issueId: issue.id,
  lastSeenAt: issue.lastSeen,
  repoId: issue.project.slug,
  threadTs: "pending",
  title: issue.title,
})

const needsRootThreadTs = (threadTs: string): boolean =>
  threadTs.trim() === "" || threadTs === "pending"

const saveIssueSnapshot = (input: SaveIssueSnapshotInput): void => {
  input.store.saveSentryIssueSnapshot?.({
    capturedAt: new Date().toISOString(),
    incidentId: input.incidentId,
    issueId: input.issue.id,
    snapshotJson: JSON.stringify(
      redactSensitiveJsonValue(input.issue, input.secretRedactionValues),
    ),
  })
}

const notifyDetectedIncident = (
  onDetectedIncident: NonNullable<PollOnceOptions["onDetectedIncident"]>,
  input: IncidentInput,
  existing: IncidentRecord | undefined,
): Promise<PollCounts> =>
  Promise.resolve(onDetectedIncident(input)).then(() =>
    existing === undefined
      ? { newIncidents: 1, skippedIncidents: 0, updatedIncidents: 0 }
      : { newIncidents: 0, skippedIncidents: 0, updatedIncidents: 1 },
  )

const storeIssue = (input: StoreIssueInput): PollCounts | Promise<PollCounts> => {
  const { issue, onDetectedIncident, project, secretRedactionValues, store } = input
  const existing = store.getIncidentByIssueId(issue.id)
  const incident = incidentInput(issue, project)
  if (existing !== undefined) {
    saveIssueSnapshot({ incidentId: existing.incidentId, issue, secretRedactionValues, store })
  }
  if (
    existing !== undefined &&
    needsRootThreadTs(existing.threadTs) &&
    onDetectedIncident !== undefined
  ) {
    return notifyDetectedIncident(onDetectedIncident, incident, existing)
  }
  if (existing !== undefined && existing.lastSeenAt === issue.lastSeen) {
    return { newIncidents: 0, skippedIncidents: 1, updatedIncidents: 0 }
  }
  if (existing === undefined && onDetectedIncident !== undefined) {
    const result = store.upsertIncident(incident)
    saveIssueSnapshot({ incidentId: result.incidentId, issue, secretRedactionValues, store })
    return notifyDetectedIncident(onDetectedIncident, incident, existing)
  }
  const result = store.upsertIncident(incident)
  saveIssueSnapshot({ incidentId: result.incidentId, issue, secretRedactionValues, store })
  return result.created
    ? { newIncidents: 1, skippedIncidents: 0, updatedIncidents: 0 }
    : { newIncidents: 0, skippedIncidents: 0, updatedIncidents: 1 }
}

const addCounts = (left: PollCounts, right: PollCounts): PollCounts => ({
  newIncidents: left.newIncidents + right.newIncidents,
  skippedIncidents: left.skippedIncidents + right.skippedIncidents,
  updatedIncidents: left.updatedIncidents + right.updatedIncidents,
})

const fetchIssues = async (
  client: ReturnType<typeof createSentryHttpClient>,
  project: SentryProjectMapping,
  cursor: string | undefined,
): Promise<{ readonly issues: readonly SentryIssue[]; readonly response: Response }> => {
  const searchParams = new URLSearchParams({
    query: `is:unresolved project:${project.projectSlug}`,
  })
  if (cursor !== undefined) {
    searchParams.set("cursor", cursor)
  }

  const response = await client.get(`organizations/${project.organizationSlug}/issues/`, {
    searchParams,
  })
  if (response.status === 429 || hasExhaustedSentryRateLimit(response.headers)) {
    return { issues: [], response }
  }
  if (!response.ok) {
    throw new SentryExternalApiError(
      `Sentry issues request failed with HTTP ${response.status}`,
      response.status,
    )
  }

  try {
    const body = await response.json()
    return { issues: sentryIssuePageSchema.parse(body), response }
  } catch (error) {
    if (error instanceof ZodError) {
      throw sentryParseError("issues", error)
    }
    if (error instanceof SyntaxError) {
      throw new SentryExternalApiError("Malformed Sentry issues response JSON", response.status)
    }
    throw error
  }
}

export const pollOnce = async (options: PollOnceOptions): Promise<PollOnceResult> => {
  const client = createSentryHttpClient({
    authToken: options.authToken,
    baseUrl: options.baseUrl,
  })
  let counts: PollCounts = { newIncidents: 0, skippedIncidents: 0, updatedIncidents: 0 }
  let nextCursor: string | undefined
  const secretRedactionValues = options.secretRedactionValues ?? []

  for (const project of options.projects) {
    const page = await fetchIssues(client, project, options.cursor)
    if (page.response.status === 429 || hasExhaustedSentryRateLimit(page.response.headers)) {
      return {
        backoffSeconds: parseSentryBackoffSeconds(
          page.response.headers,
          Math.floor(Date.now() / 1000),
        ),
        detailFetches: 0,
        newIncidents: counts.newIncidents,
        skippedIncidents: counts.skippedIncidents,
        status: "degraded",
        updatedIncidents: counts.updatedIncidents,
      }
    }

    nextCursor = parseNextCursor(page.response.headers.get("link")) ?? nextCursor
    for (const issue of page.issues) {
      counts = addCounts(
        counts,
        await storeIssue({
          issue,
          onDetectedIncident: options.onDetectedIncident,
          project,
          secretRedactionValues,
          store: options.store,
        }),
      )
    }
  }

  const baseResult = {
    detailFetches: 0,
    newIncidents: counts.newIncidents,
    skippedIncidents: counts.skippedIncidents,
    status: "ok" as const,
    updatedIncidents: counts.updatedIncidents,
  }
  return nextCursor === undefined ? baseResult : { ...baseResult, nextCursor }
}
