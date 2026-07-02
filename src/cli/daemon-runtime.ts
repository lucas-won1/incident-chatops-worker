import ky from "ky"
import { z } from "zod"

import type { WorkerSettings } from "../config/index.js"
import { LocalGitRepoAdapter } from "../repo/local-git.js"
import { createProductionRunner } from "../runner/factory.js"
import type { RunnerAdapter, RunnerRequest } from "../runner/types.js"
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
  type WorkflowWorktreePreparer,
} from "../workflow/index.js"
import { CommandWorktreePreparer } from "../workflow/worktree-preparer.js"
import {
  type DaemonPollOnce,
  daemonSentryContext,
  repoPathsByProject,
} from "./daemon-sentry-runtime.js"
import {
  createSelectedMergeRequestProvider,
  daemonSecretValues,
  type MergeRequestProviderFactory,
  selectedMergeRequestDefaults,
  selectedMergeRequestProviderOptions,
} from "./mr-provider-routing.js"

export type { DaemonPollOnce } from "./daemon-sentry-runtime.js"
export {
  detectedWorkflowIncident,
  formatPollOnceResult,
  runDaemonPollOnce,
} from "./daemon-sentry-runtime.js"

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
  readonly worktreePreparer?: WorkflowWorktreePreparer
  readonly writeStatus?: (line: string) => void
}

const slackPostResponseSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
})

const recoverAbandonedActiveJobs = (
  state: DaemonStateStore,
  reportStatus: ((line: string) => void) | undefined,
): void => {
  const recoveredJobs = state.abandonActiveJobs({
    actor: "daemon",
    details: "daemon startup recovered active job left by a previous worker process",
    finishedAt: new Date().toISOString(),
    state: "failed",
  })
  if (recoveredJobs.length === 0) {
    return
  }
  const jobIds = recoveredJobs.map((job) => job.jobId).join(",")
  reportStatus?.(
    `workflow recovered abandoned active jobs count=${recoveredJobs.length} jobs=${jobIds}`,
  )
}

const isPendingThreadTs = (threadTs: string): boolean =>
  threadTs.trim() === "" || threadTs === "pending"

const createConfiguredWorktreePreparer = (
  settings: WorkerSettings,
): WorkflowWorktreePreparer | undefined => {
  const commands = settings.config.worktreePrepare.commands
  if (commands.length === 0) {
    return undefined
  }
  return new CommandWorktreePreparer({
    commands,
    projectEnv: settings.config.runners.projectEnv,
    secretValues: daemonSecretValues(settings),
    timeoutMs: settings.config.worktreePrepare.timeoutMs,
  })
}

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
    | "mrProviderFactory"
    | "repo"
    | "runner"
    | "sentryContext"
    | "slack"
    | "worktreePreparer"
    | "writeStatus"
  > = {},
): DaemonWorkflowRuntime => {
  const runner = dependencies.runner ?? createProductionRunner(settings)
  const state = openSqliteStateStore({ path: settings.env.stateDbPath })
  const createMrProvider = dependencies.mrProviderFactory ?? createSelectedMergeRequestProvider
  const providerOptions = selectedMergeRequestProviderOptions(settings)
  const mrDefaults = selectedMergeRequestDefaults(settings)
  const reportStatus =
    dependencies.writeStatus === undefined
      ? undefined
      : (line: string): void => {
          dependencies.writeStatus?.(redactSensitiveText(line, daemonSecretValues(settings)))
        }
  recoverAbandonedActiveJobs(state, reportStatus)
  const worktreePreparer =
    dependencies.worktreePreparer ?? createConfiguredWorktreePreparer(settings)
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
    runner,
    sentryContext: dependencies.sentryContext ?? daemonSentryContext(settings),
    sentryContextSecretValues: daemonSecretValues(settings),
    slack: dependencies.slack ?? {
      postMessage: (message) => postSlackMessage(settings, message),
    },
    state,
    ...(reportStatus === undefined ? {} : { statusReporter: reportStatus }),
    ...(worktreePreparer === undefined ? {} : { worktreePreparer }),
  })

  return {
    handleDetectedIncident: (incident) => workflow.handleDetectedIncident(incident),
    handleSlackAction: async (intent) => {
      const actionDetails = `kind=${intent.kind} issue=${intent.issueId}`
      reportStatus?.(`workflow action received ${actionDetails}`)
      try {
        const result = await workflow.handleSlackAction(intent)
        const jobDetails =
          "jobId" in result && result.jobId !== undefined ? ` job=${result.jobId}` : ""
        reportStatus?.(
          `workflow action handled ${actionDetails} result=${result.kind}${jobDetails}`,
        )
      } catch (error) {
        if (error instanceof Error) {
          reportStatus?.(`workflow action failed ${actionDetails} error=${error.message}`)
        }
        throw error
      }
    },
    stateStore: state,
    stop: () => state.close(),
  }
}
