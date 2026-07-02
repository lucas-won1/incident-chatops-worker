import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parse as parseYaml } from "yaml"
import { z } from "zod"

import { repoId, sentryIssueId, slackChannelId, slackThreadTs, slackUserId } from "../domain/ids.js"
import type {
  CreateMergeRequestInput,
  MergeRequestProvider,
  MergeRequestProviderId,
} from "../mr/types.js"
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
    mr: z
      .object({
        fail: z.boolean().default(false),
        provider: z.union([z.literal("gitlab"), z.literal("github")]).default("gitlab"),
      })
      .default({ fail: false, provider: "gitlab" }),
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
    private readonly recordClose: () => void,
  ) {
    this.worktreePath = `/tmp/${branchName.replaceAll("/", "-")}`
  }

  public async close(): Promise<void> {
    this.recordClose()
  }
}

class ScenarioRepo implements WorkflowRepoAdapter {
  public readonly closed: string[] = []
  public readonly opened: string[] = []
  public readonly pushed: string[] = []

  public constructor(private readonly scenario: Scenario) {}

  public async currentHead(): Promise<string> {
    return "0000000000000000000000000000000000000000"
  }

  public async dirtyStatus(): Promise<string> {
    if (this.scenario.runner.dirtyAnalysis) {
      return "?? scenario-dirty-analysis.txt\n"
    }
    return ""
  }

  public async openWorktree(request: {
    readonly branchName: string
    readonly jobId: string
    readonly repoPath: string
  }): Promise<WorkflowWorktreeSession> {
    this.opened.push(`${request.branchName}:${request.jobId}`)
    return new ScenarioWorktree(request.branchName, request.repoPath, () => {
      this.closed.push(request.branchName)
    })
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

  public constructor(
    public readonly provider: MergeRequestProviderId,
    private readonly shouldFail: boolean,
  ) {}

  public async createMergeRequest(
    input: CreateMergeRequestInput,
  ): Promise<{ readonly url: string }> {
    this.calls.push(input)
    if (this.shouldFail) {
      throw new Error(`${this.provider} fixture rejected MR token-secret`)
    }
    return { url: `https://${this.provider}.example/incidents/merge_requests/7` }
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
  const repo = new ScenarioRepo(scenario)
  const mrProvider = new ScenarioMrProvider(scenario.mr.provider, scenario.mr.fail)
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
    "analysis worker worktree opens: 0",
    `fix worker worktree opens: ${repo.opened.length}`,
    `worker worktree opens: ${repo.opened.length} ${repo.opened.join(",")}`,
    `worker worktree cleanup calls: ${repo.closed.length} ${repo.closed.join(",")}`,
    `push calls: ${repo.pushed.length} ${repo.pushed.join(",")}`,
    `MR calls: ${mrProvider.calls.length}`,
    `MR provider: ${mrProvider.provider}`,
    `MR URL: ${mrProvider.calls.length > 0 && !scenario.mr.fail ? `https://${mrProvider.provider}.example/incidents/merge_requests/7` : "none"}`,
    `workflow failed: ${audit.some((entry) => entry.action === "workflow.failed") ? "yes" : "no"}`,
    `audit actions: ${audit.map((entry) => entry.action).join(",")}`,
    "cleanup: scenario temp store removed",
  ].join("\n")
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
  return ok(`${transcript}\n`)
}
