import type { WorkerSettings } from "../config/index.js"
import type { CreateMergeRequestInput, MergeRequestProvider } from "../mr/types.js"
import type { PushGitBranchRequest } from "../repo/local-git.js"
import type { RunnerAdapter, RunnerRequest, RunnerResult } from "../runner/types.js"
import type { SlackRenderedMessage } from "../slack/index.js"
import { openSqliteStateStore } from "../state/sqlite-store.js"
import type {
  WorkflowRepoAdapter,
  WorkflowSlackPublisher,
  WorkflowWorktreeSession,
} from "../workflow/index.js"
import { IncidentWorkflow } from "../workflow/index.js"
import type { DaemonWorkflowRuntime } from "./daemon-runtime.js"

type FakeStateStore = ReturnType<typeof openSqliteStateStore>

export const fakeWorkflowRootThreadTs = "1719999999.000200"

class FakeMergeRequestProvider implements MergeRequestProvider {
  public async createMergeRequest(
    input: CreateMergeRequestInput,
  ): Promise<{ readonly url: string }> {
    return { url: `https://gitlab.invalid/fake/${input.sourceBranch}` }
  }
}

class FakeRunner implements RunnerAdapter {
  public async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      analysis: `fake analysis for ${request.incidentContext.issueId}`,
      command: "fake-runner",
      mode: request.mode,
      stderr: "",
      stdout: "fake runner completed",
      verificationResults: "passed",
    }
  }
}

class FakeWorktreeSession implements WorkflowWorktreeSession {
  public readonly branchName: string
  public readonly repoPath: string
  public readonly worktreePath: string

  public constructor(request: {
    readonly branchName: string
    readonly repoPath: string
  }) {
    this.branchName = request.branchName
    this.repoPath = request.repoPath
    this.worktreePath = `${request.repoPath}/.omo/fake-worktree/${request.branchName.replaceAll("/", "-")}`
  }

  public close(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeRepoAdapter implements WorkflowRepoAdapter {
  public async openWorktree(request: {
    readonly branchName: string
    readonly jobId: string
    readonly repoPath: string
  }): Promise<WorkflowWorktreeSession> {
    return new FakeWorktreeSession(request)
  }

  public pushBranch(_request: PushGitBranchRequest): Promise<void> {
    return Promise.resolve()
  }
}

class FakeSlackPublisher implements WorkflowSlackPublisher {
  readonly #state: FakeStateStore

  public constructor(state: FakeStateStore) {
    this.#state = state
  }

  public async postMessage(message: SlackRenderedMessage): Promise<{ readonly ts?: string }> {
    this.#state.appendAuditEntry({
      actor: "slack:fake",
      action: "slack.post_message.fake",
      configHash: "fake",
      details: `fake Slack post channel=${message.channel} thread=${message.threadTs} text=${message.text}`,
      occurredAt: new Date().toISOString(),
    })
    return message.threadTs === "pending" ? { ts: fakeWorkflowRootThreadTs } : {}
  }
}

const repoPathForProject = (settings: WorkerSettings, projectSlug: string): string => {
  const projectIndex = settings.config.sentryProjects.findIndex(
    (project) => project.projectSlug === projectSlug,
  )
  return settings.config.repos.allowlist[projectIndex] ?? settings.config.repos.allowlist[0] ?? ""
}

const repoPathsByProject = (settings: WorkerSettings): Readonly<Record<string, string>> =>
  Object.fromEntries(
    settings.config.sentryProjects.map((project) => [
      project.projectSlug,
      repoPathForProject(settings, project.projectSlug),
    ]),
  )

export const createFakeDaemonWorkflowRuntime = (
  settings: WorkerSettings,
): DaemonWorkflowRuntime => {
  const state = openSqliteStateStore({ path: settings.env.stateDbPath })
  const workflow = new IncidentWorkflow({
    branchPrefix: settings.config.branchPrefix,
    defaultTargetBranch: settings.config.mr.defaultTargetBranch,
    mrProvider: new FakeMergeRequestProvider(),
    remoteName: "origin",
    repo: new FakeRepoAdapter(),
    repoPaths: repoPathsByProject(settings),
    runner: new FakeRunner(),
    slack: new FakeSlackPublisher(state),
    state,
  })

  return {
    handleDetectedIncident: (incident) => workflow.handleDetectedIncident(incident),
    handleSlackAction: async (intent) => {
      await workflow.handleSlackAction(intent)
    },
    stateStore: state,
    stop: () => state.close(),
  }
}
