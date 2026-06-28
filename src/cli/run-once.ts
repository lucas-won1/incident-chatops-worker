import { runSentryOnce } from "../sentry/run-once.js"
import { findOptionValue } from "../shared/cli-args.js"
import type { CliResult } from "../shared/cli-result.js"

export const runOnceCommand = async (args: readonly string[]): Promise<CliResult> => {
  return runSentryOnce({ args, findOptionValue })
}
