#!/usr/bin/env node
import { pathToFileURL } from "node:url"

import {
  type CliRuntimeOptions,
  runDaemonCommand,
  runDoctorCommand,
  runLogsCommand,
  runOnceCommand,
  runStatusCommand,
} from "./cli/commands.js"
import { runSentryOnce } from "./sentry/run-once.js"
import { findOptionValue } from "./shared/cli-args.js"
import { type CliResult, fail, ok } from "./shared/cli-result.js"
import { isWorkerCommand, workerCommands } from "./shared/commands.js"
import { UnknownCommandError } from "./shared/errors.js"

const helpText = `incident-worker

Usage:
  incident-worker <command> [options]

Commands:
  daemon     Start the local worker daemon shell.
  doctor     Check local setup prerequisites.
  status     Print worker status.
  run-once   Run one worker cycle.
  logs       Print local audit logs.
  mcp        Serve read-only incident handoff tools over MCP stdio.
  dev        Run development validation helpers.

Options:
  --help, -h  Show this help.
`

export const renderHelp = (): string => helpText

const runDevCommand = async (args: readonly string[]): Promise<CliResult> => {
  const subcommand = args[0]
  switch (subcommand) {
    case "parse-action":
    case "parse-slack-action":
    case "render-slack": {
      const { runSlackDevCommand } = await import("./slack/slack-dev-cli.js")
      return (
        runSlackDevCommand(subcommand, args.slice(1)) ??
        fail(64, `Unknown dev command: ${subcommand}\n`)
      )
    }
    case "run-runner": {
      const { runRunnerDevCommand } = await import("./runner/runner-dev-cli.js")
      return runRunnerDevCommand(args.slice(1))
    }
    case "scenario": {
      const { runWorkflowScenarioCommand } = await import("./workflow/scenario-cli.js")
      return runWorkflowScenarioCommand(args.slice(1))
    }
    case "validate-docs":
    case "verify-scope": {
      const { runDocsDevCommand } = await import("./dev/docs-validation.js")
      return (
        runDocsDevCommand(subcommand, args.slice(1)) ??
        fail(64, `Unknown dev command: ${subcommand}\n`)
      )
    }
    default:
      return fail(64, `Unknown dev command: ${subcommand ?? ""}\n`)
  }
}

export const runCliAsync = async (
  args: readonly string[],
  runtime: CliRuntimeOptions = {},
): Promise<CliResult> => {
  if (args[0] === "daemon") {
    return runDaemonCommand(args.slice(1), runtime)
  }

  if (args[0] === "doctor") {
    return runDoctorCommand(args.slice(1), runtime.reachability)
  }

  if (args[0] === "run-once" && findOptionValue(args, "--source") === undefined) {
    return runOnceCommand(args.slice(1))
  }

  if (args[0] === "run-once" && findOptionValue(args, "--source") === "sentry") {
    return runSentryOnce({ args: args.slice(1), findOptionValue })
  }

  if (args[0] === "mcp") {
    const { runMcpCommand } = await import("./cli/mcp.js")
    return runMcpCommand(args.slice(1))
  }

  if (args[0] === "dev") {
    return runDevCommand(args.slice(1))
  }

  return runCli(args)
}

export const runCli = (args: readonly string[]): CliResult => {
  const firstArg = args[0]

  if (firstArg === undefined || firstArg === "--help" || firstArg === "-h" || firstArg === "help") {
    return ok(renderHelp())
  }

  if (firstArg === "dev") {
    return fail(64, `Unknown dev command: ${args[1] ?? ""}\n`)
  }

  if (firstArg === "logs") {
    return runLogsCommand(args.slice(1))
  }

  if (firstArg === "status") {
    return runStatusCommand(args.slice(1))
  }

  if (isWorkerCommand(firstArg)) {
    return ok(`${firstArg}: command shell placeholder\n`)
  }

  const error = new UnknownCommandError(firstArg)
  return fail(64, `${error.message}\nRun incident-worker --help for available commands.\n`)
}

export const writeCliResult = (result: CliResult): void => {
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr)
  }
  process.exitCode = result.exitCode
}

export const isCliEntrypoint = (argv: readonly string[]): boolean => {
  const scriptPath = argv[1]
  if (scriptPath === undefined) {
    return false
  }

  return import.meta.url === pathToFileURL(scriptPath).href
}

export const main = (argv: readonly string[]): void => {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)
  runCliAsync(argv.slice(2), {
    signal: controller.signal,
    writeStdout: (text) => process.stdout.write(text),
  })
    .then(writeCliResult)
    .catch((error: unknown) => {
      if (error instanceof Error) {
        writeCliResult(fail(70, `${error.name}: ${error.message}\n`))
        return
      }
      writeCliResult(fail(70, "Unknown CLI failure\n"))
    })
}

if (isCliEntrypoint(process.argv)) {
  main(process.argv)
}

export { workerCommands }
