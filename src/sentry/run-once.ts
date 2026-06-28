import {
  createProductionDaemonWorkflowRuntime,
  detectedWorkflowIncident,
} from "../cli/daemon-runtime.js"
import { createFakeDaemonWorkflowRuntime } from "../cli/fake-workflow-runtime.js"
import { configFailure, loadCommandSettings } from "../cli/settings.js"
import { ConfigValidationError } from "../config/index.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import { SentryExternalApiError } from "./errors.js"
import { pollOnce } from "./polling-source.js"

type RunOnceOptions = {
  readonly args: readonly string[]
  readonly findOptionValue: (args: readonly string[], optionName: string) => string | undefined
}

export const runSentryOnce = async (options: RunOnceOptions): Promise<CliResult> => {
  const configPath = options.findOptionValue(options.args, "--config")
  if (configPath === undefined) {
    return fail(64, "run-once --source sentry requires --config <path>\n")
  }

  try {
    const loaded = loadCommandSettings(options.args)
    const workflow = loaded.fakeMode
      ? createFakeDaemonWorkflowRuntime(loaded.settings)
      : createProductionDaemonWorkflowRuntime(loaded.settings)
    let store = workflow.stateStore
    let ownsStore = false
    try {
      if (store === undefined) {
        store = openSqliteStateStore({ path: loaded.settings.env.stateDbPath })
        ownsStore = true
      }
      const result = await pollOnce({
        authToken: loaded.settings.env.sentryAuthToken,
        baseUrl: loaded.settings.env.sentryBaseUrl,
        onDetectedIncident: async (incident) => {
          await workflow.handleDetectedIncident(detectedWorkflowIncident(loaded.settings, incident))
        },
        projects: loaded.settings.config.sentryProjects,
        secretRedactionValues: [
          loaded.settings.env.gitlabToken,
          loaded.settings.env.sentryAuthToken,
          loaded.settings.env.slackAppToken,
          loaded.settings.env.slackBotToken,
        ],
        store,
      })
      return ok(
        `source=sentry status=${result.status} new=${result.newIncidents} updated=${result.updatedIncidents} skipped=${result.skippedIncidents} detailFetches=${result.detailFetches}${result.backoffSeconds === undefined ? "" : ` backoffSeconds=${result.backoffSeconds}`}\n`,
      )
    } finally {
      if (ownsStore) {
        store?.close()
      }
      await workflow.stop?.()
    }
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return configFailure(error)
    }
    if (error instanceof SentryExternalApiError) {
      return fail(69, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}
