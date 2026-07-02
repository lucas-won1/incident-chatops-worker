import { redactAndTruncate } from "../shared/redaction.js"
import { RunnerPolicyError } from "./errors.js"

export const defaultRunnerTimeoutMs = 1_800_000
export const defaultOutputLimitBytes = 200 * 1024
export const defaultEnvAllowlist = ["PATH", "HOME"] as const

const dangerousCodexFlagValue = (arg: string): string => arg.split("=", 1)[0] ?? arg

const wordsEndWith = (words: readonly string[], suffix: readonly string[]): boolean =>
  suffix.every((word, offset) => words[words.length - suffix.length + offset] === word)

export const isDangerousCodexFlagArgument = (arg: string): boolean => {
  const flag = dangerousCodexFlagValue(arg).toLowerCase()
  if (flag === "--add-dir") {
    return true
  }
  if (!flag.startsWith("--")) {
    return false
  }
  const words = flag.slice(2).split("-").filter(Boolean)
  if (words[0] !== "dangerously" || !words.includes("bypass")) {
    return false
  }
  return (
    wordsEndWith(words, ["approvals", "and", "sandbox"]) || wordsEndWith(words, ["hook", "trust"])
  )
}

const shellMetacharacters = /[;&|`$<>\n\r]/u
const executableWhitespace = /\s/u
const mutationWords = new Set([
  "commit",
  "push",
  "merge_request",
  "merge-request",
  "merge_requests",
  "pull_request",
  "pull-request",
  "pull_requests",
  "mr",
  "pr",
])
const genericRunnerDeniedExecutables = new Set(["git", "gh", "glab"])

const shellInterpreters = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "cmd",
  "powershell",
  "pwsh",
])
const shellEvalFlags = new Set(["-c", "-lc", "/c", "-command", "-encodedcommand"])
const envSplitStringFlags = new Set(["-S", "--split-string"])

const executableName = (command: string): string => {
  const lastSeparatorIndex = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"))
  const basename = lastSeparatorIndex === -1 ? command : command.slice(lastSeparatorIndex + 1)
  return basename.toLowerCase().replace(/\.exe$/u, "")
}

const isShellInterpreterToken = (token: string): boolean =>
  shellInterpreters.has(executableName(token))

export const redactRunnerOutput = (
  value: string,
  limitBytes: number,
  secretValues: readonly string[] = [],
): string => redactAndTruncate(value, limitBytes, secretValues)

export const selectAllowedEnv = (
  source: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[],
): Readonly<Record<string, string>> => {
  const entries = allowlist.flatMap((name): readonly [string, string][] => {
    const value = source[name]
    return value === undefined ? [] : [[name, value]]
  })
  return Object.fromEntries(entries)
}

export const validateExecutable = (command: string, label: string): void => {
  if (command.length === 0 || command.includes("\0") || shellMetacharacters.test(command)) {
    throw new RunnerPolicyError(`${label} executable is unsafe`)
  }
  if (executableWhitespace.test(command)) {
    throw new RunnerPolicyError(`${label} executable must not include arguments`)
  }
  if (isDangerousCodexFlagArgument(command)) {
    throw new RunnerPolicyError(`${label} executable contains forbidden Codex override`)
  }
}

export const validateArgs = (args: readonly string[], label: string): void => {
  for (const arg of args) {
    if (arg.includes("\0") || shellMetacharacters.test(arg)) {
      throw new RunnerPolicyError(`${label} argument is unsafe`)
    }
    if (isDangerousCodexFlagArgument(arg)) {
      throw new RunnerPolicyError(`${label} contains forbidden flag ${arg}`)
    }
  }
}

export const ensureCommandAllowed = (command: string, allowlist: readonly string[]): void => {
  if (!allowlist.includes(command)) {
    throw new RunnerPolicyError(`command ${command} is outside generic command allowlist`)
  }
}

export const rejectShellInterpreterCommand = (
  command: string,
  args: readonly string[],
  label: string,
): void => {
  if (isShellInterpreterToken(command)) {
    if (args.some((arg) => shellEvalFlags.has(arg.toLowerCase()))) {
      throw new RunnerPolicyError(`${label} must not use shell interpreter command strings`)
    }
    throw new RunnerPolicyError(`${label} must not use shell interpreters`)
  }
  if (args.some((arg) => isShellInterpreterToken(arg))) {
    throw new RunnerPolicyError(`${label} must not use shell interpreter command strings`)
  }
  if (
    executableName(command) === "env" &&
    args.some(
      (arg) =>
        envSplitStringFlags.has(arg) ||
        arg.startsWith("--split-string=") ||
        (arg.startsWith("-S") && arg.length > 2),
    )
  ) {
    throw new RunnerPolicyError(`${label} must not use env split-string`)
  }
}

export const ensureGenericCommandSafe = (tokens: readonly string[]): void => {
  if (tokens.some((token) => genericRunnerDeniedExecutables.has(executableName(token)))) {
    throw new RunnerPolicyError("generic runner denies workflow-owned git and provider commands")
  }
  const lowered = tokens.flatMap((token) => token.toLowerCase().split(/\s+/u).filter(Boolean))
  if (lowered.some((token) => mutationWords.has(token))) {
    throw new RunnerPolicyError("generic runner denies workflow-owned git, MR, and PR commands")
  }
  if (
    lowered.includes("gitlab") ||
    (lowered.includes("glab") && lowered.includes("mr")) ||
    (lowered.includes("gh") && lowered.includes("pr"))
  ) {
    throw new RunnerPolicyError("generic runner denies workflow-owned git, MR, and PR commands")
  }
}
