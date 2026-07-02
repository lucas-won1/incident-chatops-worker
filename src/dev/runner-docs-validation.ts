import { parseDocument } from "yaml"
import { z } from "zod"

const runnerProviderBlocksSchema = z
  .object({
    runners: z
      .object({
        claudeCode: z.record(z.string(), z.unknown()),
        codex: z.record(z.string(), z.unknown()),
        generic: z.record(z.string(), z.unknown()),
        provider: z.string(),
      })
      .passthrough(),
  })
  .passthrough()

const parseYamlExample = (text: string): unknown => {
  const document = parseDocument(text)
  if (document.errors.length > 0 || document.contents === null) {
    return undefined
  }
  return document.toJS()
}

export const hasRunnerProviderBlocks = (yamlExample: string): boolean => {
  const root = parseYamlExample(yamlExample)
  return runnerProviderBlocksSchema.safeParse(root).success
}

export const hasRunnerProviderDocs = (text: string): boolean =>
  [
    "runners.provider",
    "runners.codex",
    "runners.claudeCode",
    "runners.generic",
    "CODEX_HOME",
    "macOS Keychain",
  ].every((phrase) => text.includes(phrase))
