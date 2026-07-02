import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { RunnerDirtyWorktreeError } from "../../src/runner/index.js"
import { runRunnerDevCommand } from "../../src/runner/runner-dev-cli.js"
import { type RunnerRequest, runnerWorkspacePath } from "../../src/runner/types.js"
import { buildRunnerRequest } from "../../src/workflow/job-executor-payloads.js"

const incidentContext = {
  issueId: "SENTRY-TODO-6",
  trustBoundary: "untrusted_external_sentry",
} as const

type RunnerPathFixture =
  | {
      readonly workspacePath: string
      readonly worktreePath: string
    }
  | {
      readonly worktreePath: string
    }

const runnerRequest = (paths: RunnerPathFixture): RunnerRequest => ({
  incidentContext,
  mode: "analysis_only",
  repositoryConstraints: "analysis only",
  ...paths,
})

describe("runner workspace compatibility contract", () => {
  it.each([
    {
      label: "equal",
      paths: { workspacePath: "/tmp/workspace", worktreePath: "/tmp/workspace" },
    },
    {
      label: "divergent",
      paths: { workspacePath: "/tmp/workspace", worktreePath: "/tmp/legacy-worktree" },
    },
  ] as const)("rejects $label workspacePath and legacy worktreePath fields", ({ paths }) => {
    // Given: an external runner request includes both the current and legacy path fields.
    const request = runnerRequest(paths)

    // When / Then: path narrowing fails closed instead of silently choosing one field.
    expect(() => runnerWorkspacePath(request)).toThrow(/workspacePath.*worktreePath/u)
  })

  it("keeps legacy worktreePath-only requests as a compatibility alias", () => {
    // Given: an external runner request still uses only the deprecated field.
    const request = runnerRequest({ worktreePath: "/tmp/legacy-workspace" })

    // When / Then: the helper preserves the intentional compatibility path.
    expect(runnerWorkspacePath(request)).toBe("/tmp/legacy-workspace")
  })
})

describe("runner-facing workspace wording", () => {
  it("reports dirty analysis-only results as a dirty workspace", () => {
    // Given: the dirty-runner error is built for an analysis-only workspace violation.
    const error = new RunnerDirtyWorktreeError("/tmp/workspace", {
      command: "echo",
      exitCode: 7,
    })

    // When / Then: the runner-facing message uses workspace terminology.
    expect(error.message).toContain("dirty workspace")
    expect(error.message).not.toContain("dirty worktree")
  })

  it("points the development runner CLI to --workspace when required args are missing", async () => {
    // Given: a dev runner invocation omits the command and workspace options.
    const result = await runRunnerDevCommand(["--mode", "analysis_only", "--runner", "generic"])

    // When / Then: the observable denial text names the current option.
    expect(result.exitCode).toBe(64)
    expect(result.stdout).toContain("--workspace")
    expect(result.stdout).not.toContain("--worktree")
  })

  it("uses configured repo/workspace wording in runner request prompt constraints", () => {
    // Given: workflow payload construction maps a Git worktree session to runner workspace input.
    const request = buildRunnerRequest({
      allowedCommands: undefined,
      incidentContext,
      mode: "analysis_only",
      session: {
        branchName: "incident/SENTRY-TODO-6",
        close: async () => undefined,
        repoPath: "/repo",
        worktreePath: "/repo/.worktrees/SENTRY-TODO-6",
      },
    })

    // When / Then: the runner-facing prompt constraint says workspace, not worktree.
    expect(request.repositoryConstraints).toContain("repo/workspace")
    expect(request.repositoryConstraints).not.toContain("repo/worktree")
  })
})

describe("dev runner provider options", () => {
  it("runs Claude Code through config-owned options when config is provided", async () => {
    // Given: dev run-runner receives a Claude Code provider config and a recording process seam.
    const tempDir = mkdtempSync(path.join(tmpdir(), "incident-dev-runner-"))
    const configPath = path.join(tempDir, "config.yaml")
    const envPath = path.join(tempDir, "worker.env")
    const workspacePath = path.join(tempDir, "workspace")
    writeFileSync(
      configPath,
      `
sentry:
  projects:
    - organizationSlug: demo-org
      projectSlug: frontend
      slackChannel: "#incidents"
repos:
  allowlist:
    - ${workspacePath}
worktree:
  root: ${tempDir}/worktrees
branch:
  prefix: incident/
slack:
  channels:
    default: "#incidents"
runners:
  provider: claude-code
  claudeCode:
    bin: /opt/claude/bin/claude
    configDir: ${tempDir}/claude
    settingsPath: ${tempDir}/claude/settings.json
    model: claude-sonnet-4
    permissionMode: acceptEdits
    allowedTools:
      - Read
  generic:
    commandAllowlist:
      - echo
    definitions:
      - id: echo-safe
        type: generic
        command: echo
mr:
  provider: gitlab
  gitlab:
    baseUrl: https://gitlab.com/api/v4
    project: demo-org/frontend
  defaultTargetBranch: main
`,
    )
    writeFileSync(
      envPath,
      `FAKE_MODE=1
GITLAB_TOKEN=glpat-redacted-example
SENTRY_AUTH_TOKEN=sntrys_redacted_example
SENTRY_BASE_URL=https://sentry.invalid/api/0
SLACK_APP_TOKEN=xapp-redacted-example
SLACK_BOT_TOKEN=xoxb-redacted-example
STATE_DB_PATH=${tempDir}/state.sqlite
`,
    )
    const invocations: Array<{ readonly args: readonly string[]; readonly command: string }> = []

    // When: the dev CLI runs the selected runner provider.
    const result = await runRunnerDevCommand(
      [
        "--runner",
        "claude-code",
        "--mode",
        "analysis_only",
        "--command",
        "pnpm",
        "--workspace",
        workspacePath,
        "--config",
        configPath,
        "--env-file",
        envPath,
      ],
      {
        cleanChecker: { isClean: async () => true },
        processRunner: {
          run: async (invocation) => {
            invocations.push({ args: invocation.args, command: invocation.command })
            return { exitCode: 0, stderr: "", stdout: JSON.stringify({ analysis: "분석 완료" }) }
          },
        },
      },
    )

    // Then: configured Claude Code executable and invocation overrides are used.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"runnerStatus": "completed"')
    expect(invocations[0]?.command).toBe("/opt/claude/bin/claude")
    expect(invocations[0]?.args).toEqual(
      expect.arrayContaining([
        "--settings",
        `${tempDir}/claude/settings.json`,
        "--model",
        "claude-sonnet-4",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read",
      ]),
    )
  })
})
