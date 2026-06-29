import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadWorkerSettings } from "../../src/config/index.js"

const configuredGitLabBaseUrl = ["https:", "", "gitlab.example", "api", "v4"].join("/")

const gitLabRoutingBlock = `  gitlab:\n    baseUrl: ${configuredGitLabBaseUrl}\n    project: acme/frontend\n    defaultLabels:\n      - incident-chatops\n      - automated\n    draft: true\n`
const githubRoutingBlock =
  "  github:\n    baseUrl: https://api.github.com\n    owner: acme\n    repo: frontend\n    defaultLabels:\n      - incident-chatops\n    draft: false\n"
const validYaml = `sentry:\n  projects:\n    - organizationSlug: demo-org\n      projectSlug: frontend\n      slackChannel: "#incidents"\nrepos:\n  allowlist:\n    - /Users/won/Work/incident-chatops-worker\nworktree:\n  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees\nbranch:\n  prefix: incident/\nslack:\n  channels:\n    default: "#incidents"\nrunners:\n  genericCommandAllowlist:\n    - echo\n  definitions:\n    - id: echo-safe\n      type: generic\n      command: echo\n      args:\n        - safe\nmr:\n  provider: gitlab\n${gitLabRoutingBlock}  defaultTargetBranch: main\n`

const validGithubYaml = validYaml.replace(
  `  provider: gitlab\n${gitLabRoutingBlock}`,
  `  provider: github\n${githubRoutingBlock}`,
)

const commonEnvLines = [
  "SLACK_APP_TOKEN=xapp-redacted-example",
  "SLACK_BOT_TOKEN=xoxb-redacted-example",
  "SENTRY_AUTH_TOKEN=sntrys_redacted_example",
  "HOME=/Users/demo",
]

const envSourceWith = (providerLines: readonly string[]): string =>
  [...commonEnvLines, ...providerLines].join("\n")

const selectedProviderAcceptScenarios = [
  {
    name: "GitLab",
    absentEnv: "GITHUB_TOKEN",
    configSource: validYaml,
    envSource: envSourceWith(["GITLAB_TOKEN=glpat-redacted-example"]),
    provider: "gitlab",
  },
  {
    name: "GitHub",
    absentEnv: "GITLAB_TOKEN",
    configSource: validGithubYaml,
    envSource: envSourceWith(["GITHUB_TOKEN=ghp-redacted-example", "GITLAB_TOKEN="]),
    provider: "github",
  },
] satisfies readonly {
  readonly absentEnv: string
  readonly configSource: string
  readonly envSource: string
  readonly name: string
  readonly provider: "gitlab" | "github"
}[]

const selectedProviderRejectScenarios = [
  { name: "GitLab", absentEnv: "GITLAB_TOKEN", configSource: validYaml },
  { name: "GitHub", absentEnv: "GITHUB_TOKEN", configSource: validGithubYaml },
] satisfies readonly {
  readonly absentEnv: string
  readonly configSource: string
  readonly name: string
}[]

const tempDirs: string[] = []

const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "incident-chatops-config-"))
  tempDirs.push(dir)
  return dir
}

const writeTempFile = (name: string, source: string): string => {
  const dir = makeTempDir()
  const filePath = path.join(dir, name)
  writeFileSync(filePath, source)
  return filePath
}

const loadSettingsFromSources = (configSource: string, envSource: string) => {
  const configPath = writeTempFile("config.yaml", configSource)
  const envFilePath = writeTempFile("worker.env", envSource)
  return loadWorkerSettings({ configPath, envFilePath })
}

afterEach(() => {
  vi.unstubAllEnvs()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true })
    }
  }
})

describe("selected provider token validation", () => {
  it.each(selectedProviderAcceptScenarios)(
    "accepts $name settings when unselected provider token is absent",
    ({ absentEnv, configSource, envSource, provider }) => {
      // Given: only the selected provider token is present.
      vi.stubEnv(absentEnv, undefined)

      // When: settings are loaded from env plus YAML.
      const settings = loadSettingsFromSources(configSource, envSource)

      // Then: the unselected provider token is not required.
      expect(settings.config.mr.provider).toBe(provider)
    },
  )

  it.each(selectedProviderRejectScenarios)(
    "rejects $name settings when selected provider token is missing",
    ({ absentEnv, configSource }) => {
      // Given: the selected provider token is missing.
      vi.stubEnv(absentEnv, undefined)

      // When / Then: settings validation rejects the missing selected-provider token.
      expect(() => loadSettingsFromSources(configSource, envSourceWith([]))).toThrow(absentEnv)
    },
  )

  it("rejects GitLab settings when the selected provider token is empty", () => {
    // Given: GitLab is selected but its env-file token value is empty.
    vi.stubEnv("GITLAB_TOKEN", undefined)

    // When / Then: selected-provider validation reports the missing selected token.
    expect(() => loadSettingsFromSources(validYaml, envSourceWith(["GITLAB_TOKEN="]))).toThrow(
      "GITLAB_TOKEN must be set in env when mr.provider is gitlab",
    )
  })
})
