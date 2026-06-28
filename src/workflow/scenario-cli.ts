import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parse as parseYaml } from "yaml"
import { z } from "zod"

import { repoId, sentryIssueId, slackChannelId, slackThreadTs, slackUserId } from "../domain/ids.js"
import type { CreateMergeRequestInput, MergeRequestProvider } from "../mr/types.js"
import type { RunnerAdapter, RunnerRequest, RunnerResult } from "../runner/types.js"
import { findOptionValue } from "../shared/cli-args.js"
import type { CliResult } from "../shared/cli-result.js"
import { fail, ok } from "../shared/cli-result.js"
import { redactSensitiveText } from "../shared/redaction.js"
import { SlackActionIds, type SlackActionIntent } from "../slack/action-payload.js"
import type { SlackRenderedMessage } from "../slack/block-kit.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import { IncidentWorkflow } from "./incident-workflow.js"
import type { WorkflowRepoAdapter, WorkflowWorktreeSession } from "./types.js"

const scenarioSchema = z
  .object({
    name: z.string().min(1),
    incident: z.object({
      channelId: z.string().min(1),
      issueId: z.string().min(1),
      repoId: z.string().min(1),
      repoPath: z.string().min(1),
      threadTs: z.string().min(1),
      title: z.string().min(1),
    }),
    actions: z.array(
      z.union([z.literal("analyze"), z.literal("fix"), z.literal("duplicate_analyze")]),
    ),
    runner: z.object({
      analysisSummary: z.string().min(1),
      dirtyAnalysis: z.boolean().default(false),
      verification: z.union([z.literal("passed"), z.literal("failed")]).default("passed"),
    }),
    mr: z.object({ fail: z.boolean().default(false) }).default({ fail: false }),
  })
  .strict()

type Scenario = z.infer<typeof scenarioSchema>

class ScenarioSlack implements Readonly<{ messages: readonly SlackRenderedMessage[] }> {
  public readonly messages: SlackRenderedMessage[] = []

  public async postMessage(message: SlackRenderedMessage): Promise<{ readonly ts?: string }> {
    this.messages.push(message)
    return {}
  }
}

class ScenarioRunner implements RunnerAdapter<RunnerRequest> {
  public readonly calls: RunnerRequest[] = []

  public constructor(private readonly scenario: Scenario) {}

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request)
    if (request.mode === "analysis_only" && this.scenario.runner.dirtyAnalysis) {
      throw new Error("analysis-only dirty worktree rejected")
    }
    return {
      analysis: this.scenario.runner.analysisSummary,
      branchInfo: `incident/${this.scenario.incident.issueId}`,
      changesSummary: "Fixture fix changes applied.",
      command: "scenario-runner",
      mode: request.mode,
      stderr: "",
      stdout: "scenario runner completed",
      verificationResults: this.scenario.runner.verification,
    }
  }
}

class ScenarioWorktree implements WorkflowWorktreeSession {
  public readonly worktreePath: string

  public constructor(
    public readonly branchName: string,
    public readonly repoPath: string,
  ) {
    this.worktreePath = `/tmp/${branchName.replaceAll("/", "-")}`
  }

  public async close(): Promise<void> {}
}

class ScenarioRepo implements WorkflowRepoAdapter {
  public readonly opened: string[] = []
  public readonly pushed: string[] = []

  public async openWorktree(request: {
    readonly branchName: string
    readonly jobId: string
    readonly repoPath: string
  }): Promise<WorkflowWorktreeSession> {
    this.opened.push(`${request.branchName}:${request.jobId}`)
    return new ScenarioWorktree(request.branchName, request.repoPath)
  }

  public async pushBranch(request: {
    readonly branchName: string
    readonly remote: string
    readonly repoPath: string
  }): Promise<void> {
    this.pushed.push(`${request.remote}/${request.branchName}`)
  }
}

class ScenarioMrProvider implements MergeRequestProvider {
  public readonly calls: CreateMergeRequestInput[] = []

  public constructor(private readonly shouldFail: boolean) {}

  public async createMergeRequest(
    input: CreateMergeRequestInput,
  ): Promise<{ readonly url: string }> {
    this.calls.push(input)
    if (this.shouldFail) {
      throw new Error("GitLab fixture rejected MR glpat-secret")
    }
    return { url: "https://gitlab.example/incidents/merge_requests/7" }
  }
}

const actionIntent = (
  scenario: Scenario,
  action: Scenario["actions"][number],
): SlackActionIntent => {
  const base = {
    issueId: sentryIssueId(scenario.incident.issueId),
    repoId: repoId(scenario.incident.repoId),
    channel: { id: slackChannelId(scenario.incident.channelId) },
    thread: {
      channelId: slackChannelId(scenario.incident.channelId),
      threadTs: slackThreadTs(scenario.incident.threadTs),
    },
    actor: { slackUserId: slackUserId("U_SCENARIO") },
  }
  switch (action) {
    case "analyze":
    case "duplicate_analyze":
      return { ...base, kind: "analyze_requested", actionId: SlackActionIds.analyze }
    case "fix":
      return { ...base, kind: "fix_requested", actionId: SlackActionIds.fixAfterAnalysis }
  }
}

const parseScenario = (fixturePath: string): Scenario => {
  const raw = parseYaml(readFileSync(fixturePath, "utf8"))
  return scenarioSchema.parse(raw)
}

const messageText = (message: SlackRenderedMessage): string =>
  redactSensitiveText(`${message.text} ${JSON.stringify(message.blocks)}`)

export const runWorkflowScenarioCommand = async (args: readonly string[]): Promise<CliResult> => {
  const fixturePath = findOptionValue(args, "--fixture")
  if (fixturePath === undefined) {
    return fail(64, "scenario requires --fixture <path>\n")
  }

  const scenario = parseScenario(fixturePath)
  const tempDir = mkdtempSync(join(tmpdir(), "incident-workflow-scenario-"))
  const store = openSqliteStateStore({ path: join(tempDir, "state.sqlite") })
  const slack = new ScenarioSlack()
  const runner = new ScenarioRunner(scenario)
  const repo = new ScenarioRepo()
  const mrProvider = new ScenarioMrProvider(scenario.mr.fail)
  const workflow = new IncidentWorkflow({
    branchPrefix: "incident/",
    defaultTargetBranch: "main",
    mrProvider,
    remoteName: "origin",
    repo,
    repoPaths: { [scenario.incident.repoId]: scenario.incident.repoPath },
    runner,
    slack,
    state: store,
  })

  await workflow.handleDetectedIncident({
    ...scenario.incident,
    firstSeenAt: "2026-06-26T00:00:00.000Z",
    lastSeenAt: "2026-06-26T00:01:00.000Z",
  })
  for (const action of scenario.actions) {
    await workflow.handleSlackAction(actionIntent(scenario, action))
  }
  const audit = store.listAuditEntries()
  const jobRows = new Set(
    audit.filter((entry) => entry.action === "job.claimed").map((entry) => entry.jobId),
  )
  const transcript = [
    `scenario=${scenario.name}`,
    `Sentry issue detected: ${scenario.incident.issueId}`,
    `Slack messages: ${slack.messages.length}`,
    ...slack.messages.map((message, index) => `slack[${index + 1}]: ${messageText(message)}`),
    `runner executions: ${runner.calls.length}`,
    `job rows: ${jobRows.size}`,
    `push calls: ${repo.pushed.length} ${repo.pushed.join(",")}`,
    `MR calls: ${mrProvider.calls.length}`,
    `MR URL: ${mrProvider.calls.length > 0 && !scenario.mr.fail ? "https://gitlab.example/incidents/merge_requests/7" : "none"}`,
    `audit actions: ${audit.map((entry) => entry.action).join(",")}`,
    "cleanup: scenario temp store removed",
  ].join("\n")
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
  return ok(`${transcript}\n`)
}
