import type { WorkerSettings } from "../config/index.js"
import type { PollOnceOptions, PollOnceResult } from "../sentry/index.js"
import { fetchIssueContext, pollOnce } from "../sentry/index.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import type { IncidentWorkflowOptions, WorkflowDetectedIncident } from "../workflow/index.js"
import type { DaemonWorkflowRuntime } from "./daemon-runtime.js"
import { daemonSecretValues } from "./mr-provider-routing.js"

type DaemonStateStore = ReturnType<typeof openSqliteStateStore>

export type DaemonPollOnce = (options: PollOnceOptions) => Promise<PollOnceResult>

export type DaemonPollRuntimeDependencies = {
  readonly pollOnce?: DaemonPollOnce
  readonly writeStatus?: (line: string) => void
}

const repoPathForIncident = (settings: WorkerSettings, repoId: string): string => {
  const projectIndex = settings.config.sentryProjects.findIndex(
    (project) => project.projectSlug === repoId,
  )
  return settings.config.repos.allowlist[projectIndex] ?? settings.config.repos.allowlist[0] ?? ""
}

export const repoPathsByProject = (settings: WorkerSettings): Readonly<Record<string, string>> =>
  Object.fromEntries(
    settings.config.sentryProjects.map((project) => [
      project.projectSlug,
      repoPathForIncident(settings, project.projectSlug),
    ]),
  )

const sentryProjectForIncident = (settings: WorkerSettings, repoId: string) => {
  const project = settings.config.sentryProjects.find((mapping) => mapping.projectSlug === repoId)
  if (project === undefined) {
    throw new Error(`Sentry project mapping missing for ${repoId}`)
  }
  return project
}

export const daemonSentryContext = (
  settings: WorkerSettings,
): NonNullable<IncidentWorkflowOptions["sentryContext"]> => ({
  fetchIssueContext: (incident) => {
    const project = sentryProjectForIncident(settings, incident.repoId)
    return fetchIssueContext({
      authToken: settings.env.sentryAuthToken,
      baseUrl: settings.env.sentryBaseUrl,
      issueId: incident.issueId,
      organizationSlug: project.organizationSlug,
    })
  },
})

export const detectedWorkflowIncident = (
  settings: WorkerSettings,
  incident: Parameters<NonNullable<PollOnceOptions["onDetectedIncident"]>>[0],
): WorkflowDetectedIncident => ({
  ...incident,
  repoPath: repoPathForIncident(settings, incident.repoId),
})

const recordDegradedPoll = (
  settings: WorkerSettings,
  store: DaemonStateStore | undefined,
  writeStatus: ((line: string) => void) | undefined,
  details: string,
): void => {
  const safeDetails = redactSensitiveText(details, daemonSecretValues(settings))
  writeStatus?.(`Sentry polling scheduler: degraded ${safeDetails}`)
  store?.appendAuditEntry({
    actor: "daemon",
    action: "sentry.poll_degraded",
    configHash: "daemon",
    details: safeDetails,
    occurredAt: new Date().toISOString(),
  })
}

export const formatPollOnceResult = (result: PollOnceResult): string =>
  `source=sentry status=${result.status} new=${result.newIncidents} updated=${result.updatedIncidents} skipped=${result.skippedIncidents} detailFetches=${result.detailFetches}${result.backoffSeconds === undefined ? "" : ` backoffSeconds=${result.backoffSeconds}`}`

export const runDaemonPollOnce = async (
  settings: WorkerSettings,
  workflow: DaemonWorkflowRuntime,
  dependencies: DaemonPollRuntimeDependencies,
): Promise<PollOnceResult> => {
  let store: DaemonStateStore | undefined
  let ownsStore = false
  try {
    store = workflow.stateStore
    if (store === undefined) {
      store = openSqliteStateStore({ path: settings.env.stateDbPath })
      ownsStore = true
    }
    const result = await (dependencies.pollOnce ?? pollOnce)({
      authToken: settings.env.sentryAuthToken,
      baseUrl: settings.env.sentryBaseUrl,
      onDetectedIncident: async (incident) => {
        await workflow.handleDetectedIncident(detectedWorkflowIncident(settings, incident))
      },
      projects: settings.config.sentryProjects,
      secretRedactionValues: daemonSecretValues(settings),
      store,
    })
    if (result.status === "degraded") {
      recordDegradedPoll(
        settings,
        store,
        dependencies.writeStatus,
        `Sentry poll degraded${result.backoffSeconds === undefined ? "" : ` backoffSeconds=${result.backoffSeconds}`}`,
      )
    }
    return result
  } catch (error) {
    if (error instanceof Error) {
      recordDegradedPoll(
        settings,
        store,
        dependencies.writeStatus,
        `${error.name}: ${error.message}`,
      )
      return {
        detailFetches: 0,
        newIncidents: 0,
        skippedIncidents: 0,
        status: "degraded",
        updatedIncidents: 0,
      }
    }
    throw error
  } finally {
    if (ownsStore) {
      store?.close()
    }
  }
}
