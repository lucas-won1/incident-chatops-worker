import { ConfigValidationError, type WorkerSettings } from "../config/index.js"
import { createSentryPollingSchedule, SentryExternalApiError } from "../sentry/index.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { createSlackSocketModeAdapter } from "../slack/index.js"
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
    workflowRuntime ??= Promise.resolve(
      (dependencies.daemonWorkflowFactory ?? createProductionDaemonWorkflowRuntime)(settings),
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
      await adapter.start()
      return {
        stop: async () => {
          await adapter.stop()
          await workflow.stop?.()
        },
      }
    },
  }
}

const createFakeStarter = (): DaemonStarter => ({
  runPollOnce: () =>
    ok("source=sentry status=ok fake=true new=0 updated=0 skipped=0 detailFetches=0\n"),
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
    const slack = await starter.startSlack(loaded.settings)
    emitLine(
      lines,
      runtime,
      loaded.fakeMode ? "Slack Socket Mode: fake connection ready" : "Slack Socket Mode: started",
    )
    emitLine(lines, runtime, `Sentry polling scheduler: poll interval ${schedule.intervalSeconds}s`)
    if (args.includes("--once")) {
      const pollResult =
        starter.runPollOnce === undefined
          ? await runOnceCommand(args)
          : await starter.runPollOnce(loaded.settings)
      await stopResource(slack)
      if (pollResult.exitCode !== 0) {
        return pollResult
      }
      emitLine(lines, runtime, pollResult.stdout.trim())
      emitLine(lines, runtime, "one poll cycle complete")
      emitLine(lines, runtime, "clean shutdown")
      return daemonOk(lines, runtime)
    }
    const scheduler = starter.startScheduler(loaded.settings)
    await waitForAbort(runtime.signal)
    await stopResource(scheduler)
    await stopResource(slack)
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
