import { ConfigValidationError, type WorkerSettings } from "../config/index.js"
import { createSentryPollingSchedule, SentryExternalApiError } from "../sentry/index.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { createSlackSocketModeAdapter } from "../slack/index.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import {
  createProductionDaemonWorkflowRuntime,
  type DaemonRuntimeDependencies,
  type DaemonWorkflowRuntime,
  formatPollOnceResult,
  runDaemonPollOnce,
} from "./daemon-runtime.js"
import { runOnceCommand } from "./run-once.js"
import { configFailure, loadCommandSettings } from "./settings.js"

export type CliRuntimeOptions = {
  readonly daemonStarter?: DaemonStarter
  readonly daemonWorkflowFactory?: DaemonRuntimeDependencies["daemonWorkflowFactory"]
  readonly pollOnce?: DaemonRuntimeDependencies["pollOnce"]
  readonly reachability?: import("./doctor.js").ReachabilityChecker
  readonly signal?: AbortSignal
  readonly slackSocketModeFactory?: DaemonRuntimeDependencies["slackSocketModeFactory"]
  readonly writeStdout?: (text: string) => void
}

export type StartedDaemonResource = {
  readonly stop?: () => Promise<void> | void
}

export type DaemonStarter = {
  readonly runPollOnce?: (settings: WorkerSettings) => CliResult | Promise<CliResult>
  readonly startScheduler: (settings: WorkerSettings) => StartedDaemonResource
  readonly startSlack: (settings: WorkerSettings) => Promise<StartedDaemonResource>
}

const waitForAbort = async (signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) {
    return new Promise(() => undefined)
  }
  if (signal.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

const stopResource = async (resource: StartedDaemonResource): Promise<void> => {
  await resource.stop?.()
}

const createDefaultStarter = (runtime: CliRuntimeOptions): DaemonStarter => {
  let workflowRuntime: Promise<DaemonWorkflowRuntime> | undefined
  const slackSocketModeFactory = runtime.slackSocketModeFactory ?? createSlackSocketModeAdapter
  const dependencies: DaemonRuntimeDependencies = {
    ...(runtime.daemonWorkflowFactory === undefined
      ? {}
      : { daemonWorkflowFactory: runtime.daemonWorkflowFactory }),
    ...(runtime.pollOnce === undefined ? {} : { pollOnce: runtime.pollOnce }),
    slackSocketModeFactory,
    writeStatus: (line) => emitRuntimeLine(runtime, line),
  }
  const getWorkflowRuntime = (settings: WorkerSettings): Promise<DaemonWorkflowRuntime> => {
    const workflowFactory = dependencies.daemonWorkflowFactory
    workflowRuntime ??= Promise.resolve(
      workflowFactory === undefined
        ? createProductionDaemonWorkflowRuntime(settings, dependencies)
        : workflowFactory(settings),
    )
    return workflowRuntime
  }
  const runWorkflowPoll = async (settings: WorkerSettings): Promise<CliResult> => {
    const workflow = await getWorkflowRuntime(settings)
    const result = await runDaemonPollOnce(settings, workflow, dependencies)
    return ok(`${formatPollOnceResult(result)}\n`)
  }

  return {
    runPollOnce: runWorkflowPoll,
    startScheduler: (settings) => {
      let activePoll: Promise<CliResult> = Promise.resolve(ok(""))
      const runScheduledPoll = (): void => {
        activePoll = runWorkflowPoll(settings)
      }
      runScheduledPoll()
      const interval = setInterval(runScheduledPoll, settings.env.sentryPollIntervalSeconds * 1000)
      return {
        stop: async () => {
          clearInterval(interval)
          await activePoll
        },
      }
    },
    startSlack: async (settings) => {
      const workflow = await getWorkflowRuntime(settings)
      const adapter = slackSocketModeFactory({
        appToken: settings.env.slackAppToken,
        botToken: settings.env.slackBotToken,
        dispatch: async (intent) => {
          await workflow.handleSlackAction(intent)
        },
      })
      try {
        await adapter.start()
      } catch (error) {
        await workflow.stop?.()
        throw error
      }
      return {
        stop: async () => {
          try {
            await adapter.stop()
          } finally {
            await workflow.stop?.()
          }
        },
      }
    },
  }
}

const createFakeStarter = (): DaemonStarter => ({
  runPollOnce: (settings) => {
    const store = openSqliteStateStore({ path: settings.env.stateDbPath })
    try {
      return ok("source=sentry status=ok fake=true new=0 updated=0 skipped=0 detailFetches=0\n")
    } finally {
      store.close()
    }
  },
  startScheduler: (settings) => {
    const interval = setInterval(() => undefined, settings.env.sentryPollIntervalSeconds * 1000)
    return {
      stop: () => clearInterval(interval),
    }
  },
  startSlack: async () => ({}),
})

const emitLine = (lines: string[], runtime: CliRuntimeOptions, line: string): void => {
  const text = `${line}\n`
  lines.push(line)
  runtime.writeStdout?.(text)
}

const emitRuntimeLine = (runtime: CliRuntimeOptions, line: string): void => {
  runtime.writeStdout?.(`${line}\n`)
}

const daemonOk = (lines: readonly string[], runtime: CliRuntimeOptions): CliResult =>
  runtime.writeStdout === undefined ? ok(lines.join("\n").concat("\n")) : ok("")

export const runDaemonCommand = async (
  args: readonly string[],
  runtime: CliRuntimeOptions = {},
): Promise<CliResult> => {
  const lines: string[] = []
  try {
    const loaded = loadCommandSettings(args)
    const schedule = createSentryPollingSchedule(loaded.settings.env)
    const starter =
      runtime.daemonStarter ??
      (loaded.fakeMode ? createFakeStarter() : createDefaultStarter(runtime))
    emitLine(lines, runtime, "daemon starting")
    let slack: StartedDaemonResource | undefined = await starter.startSlack(loaded.settings)
    emitLine(
      lines,
      runtime,
      loaded.fakeMode ? "Slack Socket Mode: fake connection ready" : "Slack Socket Mode: started",
    )
    emitLine(lines, runtime, `Sentry polling scheduler: poll interval ${schedule.intervalSeconds}s`)
    if (args.includes("--once")) {
      const pollResult = await (async () => {
        try {
          return starter.runPollOnce === undefined
            ? await runOnceCommand(args)
            : await starter.runPollOnce(loaded.settings)
        } finally {
          await stopResource(slack)
          slack = undefined
        }
      })()
      if (pollResult.exitCode !== 0) {
        return pollResult
      }
      emitLine(lines, runtime, pollResult.stdout.trim())
      emitLine(lines, runtime, "one poll cycle complete")
      emitLine(lines, runtime, "clean shutdown")
      return daemonOk(lines, runtime)
    }
    let scheduler: StartedDaemonResource | undefined
    try {
      scheduler = starter.startScheduler(loaded.settings)
      await waitForAbort(runtime.signal)
    } finally {
      if (scheduler !== undefined) {
        await stopResource(scheduler)
      }
      await stopResource(slack)
      slack = undefined
    }
    emitLine(lines, runtime, "shutdown signal received")
    emitLine(lines, runtime, "clean shutdown")
    return daemonOk(lines, runtime)
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
