import type { WorkerSettings } from "../config/index.js"
import { assertNever } from "../shared/assert-never.js"

const configuredStatus = (value: string | undefined): "ambient" | "configured" =>
  value === undefined ? "ambient" : "configured"

const overrideStatus = (value: string | undefined): "configured" | "default" =>
  value === undefined ? "default" : "configured"

const genericModeCommandStatus = (settings: WorkerSettings): "configured" | "missing" =>
  settings.config.runners.generic.analysisCommandId === undefined ||
  settings.config.runners.generic.fixCommandId === undefined
    ? "missing"
    : "configured"

export const runnerProviderStatusLines = (settings: WorkerSettings): string => {
  const runners = settings.config.runners
  const common = [`Runner provider: ${runners.provider}`]
  switch (runners.provider) {
    case "codex": {
      const codex = runners.codex
      return common
        .concat([
          `Runner Codex home: ${configuredStatus(codex.home)}`,
          `Runner Codex invocation overrides: bin=${overrideStatus(codex.bin)} profile=${overrideStatus(codex.profile)} model=${overrideStatus(codex.model)} outputRoot=${overrideStatus(codex.outputRoot)}`,
        ])
        .join("\n")
    }
    case "claude-code":
      return common
        .concat([
          `Runner Claude Code config dir: ${configuredStatus(runners.claudeCode.configDir)}`,
          `Runner Claude Code settings file: ${configuredStatus(runners.claudeCode.settingsPath)}`,
          `Runner Claude Code tools: allowed=${runners.claudeCode.allowedTools.length} disallowed=${runners.claudeCode.disallowedTools.length}`,
        ])
        .join("\n")
    case "generic":
      return common
        .concat([
          `Generic runner mode commands: ${genericModeCommandStatus(settings)}`,
          `Generic runner definitions: ${runners.generic.definitions.length}`,
        ])
        .join("\n")
    default:
      return assertNever(runners.provider)
  }
}
