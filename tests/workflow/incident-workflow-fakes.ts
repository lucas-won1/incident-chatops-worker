import type {
  CreateMergeRequestInput,
  MergeRequestProvider,
  MergeRequestProviderId,
} from "../../src/mr/types.js"
import type { RunnerRequest, RunnerResult } from "../../src/runner/types.js"
import type { SlackRenderedMessage } from "../../src/slack/block-kit.js"
import type {
  WorkflowRepoAdapter,
  WorkflowSlackPublisher,
  WorkflowWorktreePrepareRequest,
  WorkflowWorktreePreparer,
  WorkflowWorktreeSession,
} from "../../src/workflow/index.js"

export class RecordingSlackPublisher implements WorkflowSlackPublisher {
  public readonly messages: SlackRenderedMessage[] = []
  public rootPostTs: string | undefined

  public async postMessage(message: SlackRenderedMessage): Promise<{ readonly ts?: string }> {
    this.messages.push(message)
    if (message.threadTs === "pending" && this.rootPostTs !== undefined) {
      return { ts: this.rootPostTs }
    }
    return {}
  }
}

export class RecordingRunner {
  public readonly calls: RunnerRequest[] = []
  readonly #results: RunnerResult[]

  public constructor(results: readonly RunnerResult[]) {
    this.#results = [...results]
  }

  public async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(request)
    const nextResult = this.#results.shift()
    if (nextResult === undefined) {
      throw new Error("test runner result queue exhausted")
    }
    return nextResult
  }
}

export class RecordingWorktreeSession implements WorkflowWorktreeSession {
  public readonly branchName: string
  public readonly repoPath: string
  public readonly worktreePath: string
  public closeCalls = 0
  public cleanupFails = false
  public onClose: (() => void) | undefined

  public constructor(branchName: string, repoPath: string) {
    this.branchName = branchName
    this.repoPath = repoPath
    this.worktreePath = `/tmp/${branchName.replaceAll("/", "-")}`
  }

  public async close(): Promise<void> {
    this.closeCalls += 1
    if (this.cleanupFails) {
      throw new Error("cleanup failed")
    }
    this.onClose?.()
  }
}

export class RecordingRepoAdapter implements WorkflowRepoAdapter {
  public readonly currentHeadRequests: { readonly repoPath: string }[] = []
  public readonly openRequests: Parameters<WorkflowRepoAdapter["openWorktree"]>[0][] = []
  public readonly pushRequests: Parameters<WorkflowRepoAdapter["pushBranch"]>[0][] = []
  public readonly sessions: RecordingWorktreeSession[] = []
  public cleanupFails = false
  public dirtyWorkspaceStatus = ""
  public headSha = "abc123def4567890abc123def4567890abc123de"
  public currentHeadFailure: Error | undefined
  public onClose: (() => void) | undefined
  public pushFailure: Error | undefined

  public async dirtyStatus(): Promise<string> {
    return this.dirtyWorkspaceStatus
  }

  public async openWorktree(
    request: Parameters<WorkflowRepoAdapter["openWorktree"]>[0],
  ): Promise<WorkflowWorktreeSession> {
    this.openRequests.push(request)
    const session = new RecordingWorktreeSession(request.branchName, request.repoPath)
    session.cleanupFails = this.cleanupFails
    session.onClose = this.onClose
    this.sessions.push(session)
    return session
  }

  public async pushBranch(
    request: Parameters<WorkflowRepoAdapter["pushBranch"]>[0],
  ): Promise<void> {
    this.pushRequests.push(request)
    if (this.pushFailure !== undefined) {
      throw this.pushFailure
    }
  }

  public async currentHead(request: { readonly repoPath: string }): Promise<string> {
    this.currentHeadRequests.push(request)
    if (this.currentHeadFailure !== undefined) {
      throw this.currentHeadFailure
    }
    return this.headSha
  }
}

export class RecordingPreparer implements WorkflowWorktreePreparer {
  public readonly calls: WorkflowWorktreePrepareRequest[] = []
  public failure: Error | undefined

  public async prepare(request: WorkflowWorktreePrepareRequest): Promise<void> {
    this.calls.push(request)
    if (this.failure !== undefined) {
      throw this.failure
    }
  }
}

export class RecordingMergeRequestProvider implements MergeRequestProvider {
  public readonly provider: MergeRequestProviderId
  public readonly url: string
  public readonly calls: CreateMergeRequestInput[] = []
  public failure: Error | undefined

  public constructor(
    provider: MergeRequestProviderId = "gitlab",
    url = defaultMergeRequestUrl(provider),
  ) {
    this.provider = provider
    this.url = url
  }

  public async createMergeRequest(
    input: CreateMergeRequestInput,
  ): Promise<{ readonly url: string }> {
    this.calls.push(input)
    if (this.failure !== undefined) {
      throw this.failure
    }
    return { url: this.url }
  }
}

const defaultMergeRequestUrl = (provider: MergeRequestProviderId): string => {
  switch (provider) {
    case "gitlab":
      return "https://gitlab.example/incidents/merge_requests/7"
    case "github":
      return "https://github.example/incidents/pull/7"
  }
}

export const runnerResult = (overrides: Partial<RunnerResult> = {}): RunnerResult => ({
  analysis: "Root cause: checkout crash in payment handler.",
  branchInfo: "incident/SENTRY-10",
  changesSummary: "Patched null guard.",
  command: "fixture-runner",
  mode: "analysis_only",
  stderr: "",
  stdout: "ok",
  verificationResults: "passed",
  ...overrides,
})
