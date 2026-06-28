import { readFileSync } from "node:fs"

import { findOptionValue } from "../shared/cli-args.js"
import { type CliResult, fail, ok } from "../shared/cli-result.js"
import { parseSlackActionPayload, SlackActionPayloadError } from "./action-payload.js"
import {
  buildInitialIncidentMessage,
  parseInitialIncidentFixture,
  SlackBlockRenderError,
} from "./block-kit.js"

const parseJsonFile = (path: string): unknown => {
  const contents = readFileSync(path, "utf8")
  try {
    return JSON.parse(contents)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SlackActionPayloadError("invalid_payload", `Invalid JSON file: ${path}`)
    }
    throw error
  }
}

const runParseSlackAction = (args: readonly string[]): CliResult => {
  const payloadPath = findOptionValue(args, "--payload")
  if (payloadPath === undefined) {
    return fail(64, "Missing required option: --payload\n")
  }

  try {
    const intent = parseSlackActionPayload(parseJsonFile(payloadPath))
    return ok(`${JSON.stringify(intent)}\n`)
  } catch (error) {
    if (error instanceof SlackActionPayloadError) {
      return fail(65, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}

const runRenderSlack = (args: readonly string[]): CliResult => {
  const fixturePath = findOptionValue(args, "--fixture")
  if (fixturePath === undefined) {
    return fail(64, "Missing required option: --fixture\n")
  }

  try {
    const fixture = parseInitialIncidentFixture(parseJsonFile(fixturePath))
    return ok(`${JSON.stringify(buildInitialIncidentMessage(fixture), null, 2)}\n`)
  } catch (error) {
    if (error instanceof SlackActionPayloadError || error instanceof SlackBlockRenderError) {
      return fail(65, `${error.name}: ${error.message}\n`)
    }
    throw error
  }
}

export const runSlackDevCommand = (
  subcommand: string | undefined,
  args: readonly string[],
): CliResult | undefined => {
  switch (subcommand) {
    case "parse-action":
      return runParseSlackAction(args)
    case "parse-slack-action":
      return runParseSlackAction(args)
    case "render-slack":
      return runRenderSlack(args)
    default:
      return undefined
  }
}
