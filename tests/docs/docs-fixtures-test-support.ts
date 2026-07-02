import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const validReadme = [
  "Slack approval is required before mutation.",
  "This local-first MVP has no webhook default.",
  "[아키텍처](docs/architecture.md)",
  "[설정](docs/configuration.md)",
  "[보안](docs/security.md)",
  "[연동](docs/integrations.md)",
  "[운영](docs/operations.md)",
  "[문제 해결](docs/troubleshooting.md)",
].join("\n")

export const validEnvExample = [
  "SENTRY_POLL_INTERVAL_SECONDS=300",
  "GITLAB_TOKEN=gitlab-token-redacted-example",
  "GITHUB_TOKEN=github-token-redacted-example",
].join("\n")

export const validYamlExample = [
  "sentry:",
  "  projects:",
  "    - organizationSlug: demo-org",
  "      projectSlug: frontend",
  '      slackChannel: "#incidents"',
  "repos:",
  "  allowlist:",
  "    - /repo",
  "worktree:",
  "  root: /repo/.worktrees",
  "branch:",
  "  prefix: incident/",
  "slack:",
  "  channels:",
  '    default: "#incidents"',
  "runners:",
  "  provider: codex",
  "  codex:",
  "    bin: codex",
  "    home: /repo/.codex-home",
  "    profile: incident-worker",
  "    model: gpt-5-codex",
  "    extraEnvAllowlist: []",
  "  claudeCode:",
  "    bin: claude",
  "    configDir: /repo/.claude-config",
  "    settingsPath: /repo/.claude-config/settings.json",
  "    model: claude-sonnet-4",
  "    allowedTools:",
  "      - Read",
  "    disallowedTools: []",
  "    extraEnvAllowlist: []",
  "  generic:",
  "    analysisCommandId: echo-analysis",
  "    fixCommandId: echo-fix",
  "    commandAllowlist:",
  "      - echo",
  "    definitions:",
  "      - id: echo-analysis",
  "        type: generic",
  "        command: echo",
  "      - id: echo-fix",
  "        type: generic",
  "        command: echo",
].join("\n")

export const validOperationsDocWithClaim = (claim: string): string =>
  ["# 운영 가이드", "", "## 로컬 셸 운영", "SQLite daemon run-once status logs", "", claim].join(
    "\n",
  )

export const validPublicDocs: Readonly<Record<string, string>> = {
  "docs/architecture.md":
    "# 아키텍처와 워크플로\n\n## 컴포넌트 맵\nSentry polling Slack thread GitLab MR trust boundary\n",
  "docs/configuration.md":
    "# 설정 레퍼런스\n\n## 기본 원칙\n.env YAML secret repos.allowlist runners.provider runners.codex runners.claudeCode runners.generic CODEX_HOME macOS Keychain\n",
  "docs/integrations.md":
    "# 연동, runner, worktree, GitLab\n\n## Slack 앱\nSocket Mode Sentry polling GitLab\n",
  "docs/operations.md": "# 운영 가이드\n\n## 로컬 셸 운영\ndaemon run-once status logs SQLite\n",
  "docs/security.md":
    "# 보안 모델\n\n## 기본 위협 모델\n로컬 우선 Slack approval env-only webhook 기본값 없습니다\n",
  "docs/troubleshooting.md":
    "# 문제 해결\n\n## 설정과 config\n증상 원인 확인 해결 validate-docs raw secret\n",
}

const minimalPublicExamples: Readonly<Record<string, string>> = {
  ".env.example": validEnvExample,
  "README.md": validReadme,
  "incident-worker.config.example.yaml": validYamlExample,
}

export const readUtf8 = async (filePath: string): Promise<string> =>
  await readFile(filePath, "utf8")

export const createFixtureRoot = async (prefix: string): Promise<string> =>
  await mkdtemp(path.join(tmpdir(), prefix))

export const writeDocsFixture = async (
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  await mkdir(root, { recursive: true })
  for (const [fileName, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, fileName)), { recursive: true })
    await writeFile(path.join(root, fileName), text)
  }
}

export const writeMinimalDocsFixture = async (
  root: string,
  files: Readonly<Record<string, string>> = {},
): Promise<void> => writeDocsFixture(root, { ...minimalPublicExamples, ...files })

export const writeValidDocsFixture = async (
  root: string,
  files: Readonly<Record<string, string>> = {},
): Promise<void> =>
  writeDocsFixture(root, {
    ...minimalPublicExamples,
    ...validPublicDocs,
    ...files,
  })

export const writeValidDocsFixtureWithoutPublicDoc = async (
  root: string,
  omittedFileName: string,
): Promise<void> => {
  const includedPublicDocs = Object.fromEntries(
    Object.entries(validPublicDocs).filter(([fileName]) => fileName !== omittedFileName),
  )
  await writeDocsFixture(root, {
    ...minimalPublicExamples,
    ...includedPublicDocs,
  })
}
