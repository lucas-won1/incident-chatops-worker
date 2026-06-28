import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

const tempDirs: string[] = []
const gitLabBaseUrl = ["https:", "", "gitlab.com", "api", "v4"].join("/")

export const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-cli-"))
  tempDirs.push(dir)
  return dir
}

const configYaml = `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
      slackChannel: "#incidents"
repos:
  allowlist:
    - /Users/won/Work/incident-chatops-worker
worktree:
  root: /Users/won/Work/incident-chatops-worker/.omo/worktrees
branch:
  prefix: incident/
slack:
  channels:
    default: "#incidents"
runners:
  genericCommandAllowlist:
    - echo
  definitions:
    - id: echo-safe
      type: generic
      command: echo
mr:
  provider: gitlab
  gitlab:
    baseUrl: ${gitLabBaseUrl}
    project: demo-org/frontend
    defaultLabels:
      - incident-chatops
    draft: false
  defaultTargetBranch: main
`

export const writeFixtureFiles = (
  dir: string,
  envOverrides: Readonly<Record<string, string>> = {},
): { readonly configPath: string; readonly dbPath: string; readonly envPath: string } => {
  const dbPath = join(dir, "state.sqlite")
  const configPath = join(dir, "config.yaml")
  const envPath = join(dir, "worker.env")
  const env = {
    FAKE_MODE: "1",
    GITLAB_TOKEN: "glpat-redacted-example",
    SENTRY_AUTH_TOKEN: "sntrys_redacted_example",
    SENTRY_BASE_URL: "https://sentry.invalid/api/0",
    SLACK_APP_TOKEN: "xapp-redacted-example",
    SLACK_BOT_TOKEN: "xoxb-redacted-example",
    STATE_DB_PATH: dbPath,
    ...envOverrides,
  }
  writeFileSync(configPath, configYaml)
  writeFileSync(
    envPath,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
  )
  return { configPath, dbPath, envPath }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
