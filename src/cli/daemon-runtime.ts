import ky from "ky"
import { z } from "zod"

import type { WorkerSettings } from "../config/index.js"
import { LocalGitRepoAdapter } from "../repo/local-git.js"
import { GitRunnerCleanChecker } from "../runner/clean-checker.js"
import { CodexExecRunner } from "../runner/codex.js"
import type { RunnerAdapter, RunnerRequest } from "../runner/types.js"
import type { PollOnceOptions, PollOnceResult } from "../sentry/index.js"
import { fetchIssueContext, pollOnce } from "../sentry/index.js"
import { redactSensitiveText } from "../shared/redaction.js"
import type {
  SlackActionIntent,
  SlackRenderedMessage,
  SlackSocketModeAdapter,
  SlackSocketModeOptions,
} from "../slack/index.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import {
  IncidentWorkflow,
  type IncidentWorkflowOptions,
  type WorkflowDetectedIncident,
  type WorkflowRepoAdapter,
  type WorkflowSlackPublisher,
} from "../workflow/index.js"
import {
  createSelectedMergeRequestProvider,
  daemonSecretValues,
  type MergeRequestProviderFactory,
  selectedMergeRequestDefaults,
  selectedMergeRequestProviderOptions,
  serviceTokenEnvNames,
} from "./mr-provider-routing.js"

type DaemonStateStore = ReturnType<typeof openSqliteStateStore>

export type DaemonWorkflowRuntime = {
  readonly handleDetectedIncident: (incident: WorkflowDetectedIncident) => Promise<void>
  readonly handleSlackAction: (intent: SlackActionIntent) => Promise<void>
  readonly stateStore?: DaemonStateStore
  readonly stop?: () => Promise<void> | void
}

export type DaemonWorkflowFactory = (
  settings: WorkerSettings,
) => DaemonWorkflowRuntime | Promise<DaemonWorkflowRuntime>

export type DaemonPollOnce = (options: PollOnceOptions) => Promise<PollOnceResult>

export type SlackSocketModeFactory = (options: SlackSocketModeOptions) => SlackSocketModeAdapter

export type DaemonRuntimeDependencies = {
  readonly daemonWorkflowFactory?: DaemonWorkflowFactory
  readonly mrProviderFactory?: MergeRequestProviderFactory
  readonly pollOnce?: DaemonPollOnce
  readonly repo?: WorkflowRepoAdapter
  readonly runner?: RunnerAdapter<RunnerRequest>
  readonly sentryContext?: IncidentWorkflowOptions["sentryContext"]
  readonly slack?: WorkflowSlackPublisher
  readonly slackSocketModeFactory?: SlackSocketModeFactory
  readonly writeStatus?: (line: string) => void
}

const slackPostResponseSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
})

const repoPathForIncident = (settings: WorkerSettings, repoId: string): string => {
  const projectIndex = settings.config.sentryProjects.findIndex(
    (project) => project.projectSlug === repoId,
  )
  return settings.config.repos.allowlist[projectIndex] ?? settings.config.repos.allowlist[0] ?? ""
}

const repoPathsByProject = (settings: WorkerSettings): Readonly<Record<string, string>> =>
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

const isPendingThreadTs = (threadTs: string): boolean =>
  threadTs.trim() === "" || threadTs === "pending"

const postSlackMessage = async (
  settings: WorkerSettings,
  message: SlackRenderedMessage,
): Promise<{ readonly ts?: string }> => {
  const response = await ky.post("https://slack.com/api/chat.postMessage", {
    headers: {
      authorization: `Bearer ${settings.env.slackBotToken}`,
    },
    json: {
      blocks: message.blocks,
      channel: message.channel,
      text: message.text,
      thread_ts: isPendingThreadTs(message.threadTs) ? undefined : message.threadTs,
    },
    retry: { limit: 0 },
    throwHttpErrors: false,
    timeout: 10000,
  })
  if (response.status !== 200) {
    throw new Error(`Slack chat.postMessage HTTP ${response.status}`)
  }
  const body = slackPostResponseSchema.parse(await response.json())
  if (!body.ok) {
    throw new Error(`Slack chat.postMessage rejected: ${body.error ?? "unknown"}`)
  }
  return body.ts === undefined ? {} : { ts: body.ts }
}

export const createProductionDaemonWorkflowRuntime = (
  settings: WorkerSettings,
  dependencies: Pick<
    DaemonRuntimeDependencies,
    "mrProviderFactory" | "repo" | "runner" | "sentryContext" | "slack"
  > = {},
): DaemonWorkflowRuntime => {
  const state = openSqliteStateStore({ path: settings.env.stateDbPath })
  const createMrProvider = dependencies.mrProviderFactory ?? createSelectedMergeRequestProvider
  const providerOptions = selectedMergeRequestProviderOptions(settings)
  const mrDefaults = selectedMergeRequestDefaults(settings)
  const workflow = new IncidentWorkflow({
    allowedRunnerCommands: settings.config.runners.genericCommandAllowlist,
    branchPrefix: settings.config.branchPrefix,
    defaultTargetBranch: settings.config.mr.defaultTargetBranch,
    mrDefaults,
    mrProvider: createMrProvider(providerOptions),
    remoteName: "origin",
    repo:
      dependencies.repo ??
      new LocalGitRepoAdapter({
        allowlist: settings.config.repos.allowlist,
        branchPrefix: settings.config.branchPrefix,
        worktreeRoot: settings.config.worktreeRoot,
      }),
    repoPaths: repoPathsByProject(settings),
    runner:
      dependencies.runner ??
      new CodexExecRunner({
        cleanChecker: new GitRunnerCleanChecker(),
        secretEnvNames: serviceTokenEnvNames,
        secretValues: daemonSecretValues(settings),
      }),
    sentryContext: dependencies.sentryContext ?? {
      fetchIssueContext: (incident) => {
        const project = sentryProjectForIncident(settings, incident.repoId)
        return fetchIssueContext({
          authToken: settings.env.sentryAuthToken,
          baseUrl: settings.env.sentryBaseUrl,
          issueId: incident.issueId,
          organizationSlug: project.organizationSlug,
        })
      },
    },
    sentryContextSecretValues: daemonSecretValues(settings),
    slack: dependencies.slack ?? {
      postMessage: (message) => postSlackMessage(settings, message),
    },
    state,
  })

  return {
    handleDetectedIncident: (incident) => workflow.handleDetectedIncident(incident),
    handleSlackAction: async (intent) => {
      await workflow.handleSlackAction(intent)
    },
    stateStore: state,
    stop: () => state.close(),
  }
}

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
  dependencies: DaemonRuntimeDependencies,
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
