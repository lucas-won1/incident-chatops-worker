import { z } from "zod"

import type { RunnerIncidentContext } from "../runner/types.js"
import { redactSensitiveJsonValue, redactSensitiveText } from "../shared/redaction.js"
import type { IncidentRecord } from "../state/types.js"
import { WorkflowSentryContextError } from "./errors.js"
import type { IncidentWorkflowOptions, WorkflowJobContext } from "./types.js"

const trustBoundary = "untrusted_external_sentry" as const

const runnerEventSchema = z.record(z.string(), z.unknown())

const runnerIncidentContextSchema = z.object({
  events: z.array(runnerEventSchema).optional(),
  issueId: z.string().min(1),
  title: z.string().optional(),
  trustBoundary: z.literal(trustBoundary),
})

type ParsedRunnerIncidentContext = z.infer<typeof runnerIncidentContextSchema>

type ResolveRunnerIncidentContextInput = {
  readonly context: WorkflowJobContext
  readonly options: IncidentWorkflowOptions
}

const fallbackIncidentContext = (incident: IncidentRecord): RunnerIncidentContext => ({
  events: [
    {
      issueId: incident.issueId,
      title: incident.title,
      trustBoundary,
    },
  ],
  issueId: incident.issueId,
  title: incident.title,
  trustBoundary,
})

const contextWithIncidentTitle = (
  incident: IncidentRecord,
  context: RunnerIncidentContext,
): RunnerIncidentContext => ({
  ...context,
  issueId: incident.issueId,
  title: context.title ?? incident.title,
})

const redactedEvent = (
  event: Readonly<Record<string, unknown>>,
  secretValues: readonly string[],
): Readonly<Record<string, unknown>> =>
  runnerEventSchema.parse(redactSensitiveJsonValue(event, secretValues))

const redactedIncidentContext = (
  context: RunnerIncidentContext,
  secretValues: readonly string[],
): RunnerIncidentContext => ({
  ...(context.events === undefined
    ? {}
    : { events: context.events.map((event) => redactedEvent(event, secretValues)) }),
  ...(context.title === undefined
    ? {}
    : { title: redactSensitiveText(context.title, secretValues) }),
  issueId: context.issueId,
  trustBoundary: context.trustBoundary,
})

const runnerIncidentContext = (parsed: ParsedRunnerIncidentContext): RunnerIncidentContext => ({
  ...(parsed.events === undefined ? {} : { events: parsed.events }),
  ...(parsed.title === undefined ? {} : { title: parsed.title }),
  issueId: parsed.issueId,
  trustBoundary: parsed.trustBoundary,
})

const parseStoredIncidentContext = (
  snapshotJson: string,
  secretValues: readonly string[],
): RunnerIncidentContext | undefined => {
  try {
    const parsedJson: unknown = JSON.parse(snapshotJson)
    const parsed = runnerIncidentContextSchema.safeParse(parsedJson)
    return parsed.success
      ? redactedIncidentContext(runnerIncidentContext(parsed.data), secretValues)
      : undefined
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

const latestStoredIncidentContext = (
  options: IncidentWorkflowOptions,
  incident: IncidentRecord,
  secretValues: readonly string[],
): RunnerIncidentContext | undefined => {
  const snapshot = options.state.getLatestSentryIssueSnapshot?.(incident.incidentId)
  if (snapshot === undefined) {
    return undefined
  }
  return parseStoredIncidentContext(snapshot.snapshotJson, secretValues)
}

const saveFetchedIncidentContext = (
  options: IncidentWorkflowOptions,
  incident: IncidentRecord,
  context: RunnerIncidentContext,
): void => {
  options.state.saveSentryIssueSnapshot?.({
    capturedAt: new Date().toISOString(),
    incidentId: incident.incidentId,
    issueId: incident.issueId,
    snapshotJson: JSON.stringify(context),
  })
}

export const resolveRunnerIncidentContext = async (
  input: ResolveRunnerIncidentContextInput,
): Promise<RunnerIncidentContext> => {
  const secretValues = input.options.sentryContextSecretValues ?? []
  const stored = latestStoredIncidentContext(input.options, input.context.incident, secretValues)
  if (stored !== undefined) {
    return redactedIncidentContext(
      contextWithIncidentTitle(input.context.incident, stored),
      secretValues,
    )
  }
  const provider = input.options.sentryContext
  if (provider === undefined) {
    return redactedIncidentContext(fallbackIncidentContext(input.context.incident), secretValues)
  }
  try {
    const fetched = redactedIncidentContext(
      contextWithIncidentTitle(
        input.context.incident,
        await provider.fetchIssueContext(input.context.incident),
      ),
      secretValues,
    )
    saveFetchedIncidentContext(input.options, input.context.incident, fetched)
    return fetched
  } catch (error) {
    if (error instanceof Error) {
      throw new WorkflowSentryContextError(input.context.incident.issueId)
    }
    throw error
  }
}
