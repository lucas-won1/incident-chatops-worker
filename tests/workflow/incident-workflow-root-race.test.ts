import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { SlackRenderedMessage } from "../../src/slack/block-kit.js"
import { openSqliteStateStore } from "../../src/state/sqlite-store.js"
import type { WorkflowSlackPublisher } from "../../src/workflow/index.js"
import { IncidentWorkflow } from "../../src/workflow/index.js"
import {
  RecordingMergeRequestProvider,
  RecordingRepoAdapter,
  RecordingRunner,
  runnerResult,
} from "./incident-workflow-fakes.js"
import { detectedIncident } from "./incident-workflow-support.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-root-race-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

const deferred = (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} => {
  let resolvePromise = (): void => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

class BlockingRootSlackPublisher implements WorkflowSlackPublisher {
  public readonly messages: SlackRenderedMessage[] = []
  public rootPostCalls = 0
  readonly #firstRootPost = deferred()
  readonly #releaseRootPost = deferred()
  readonly #rootThreadTs: string

  public constructor(rootThreadTs: string) {
    this.#rootThreadTs = rootThreadTs
  }

  public async postMessage(message: SlackRenderedMessage): Promise<{ readonly ts?: string }> {
    this.messages.push(message)
    if (message.threadTs !== "pending") {
      return {}
    }
    this.rootPostCalls += 1
    if (this.rootPostCalls === 1) {
      this.#firstRootPost.resolve()
    }
    await this.#releaseRootPost.promise
    return { ts: this.#rootThreadTs }
  }

  public async waitForFirstRootPost(): Promise<void> {
    await this.#firstRootPost.promise
  }

  public releaseRootPost(): void {
    this.#releaseRootPost.resolve()
  }
}

describe("incident workflow root-thread concurrency", () => {
  it("posts exactly one Slack root thread when duplicate pending detections race", async () => {
    // Given: two detections for the same pending incident overlap while the root Slack post is in-flight.
    const rootThreadTs = "1719992222.000500"
    const slack = new BlockingRootSlackPublisher(rootThreadTs)
    const store = openSqliteStateStore({ path: createTempDbPath() })
    const workflow = new IncidentWorkflow({
      branchPrefix: "incident/",
      defaultTargetBranch: "main",
      mrProvider: new RecordingMergeRequestProvider(),
      remoteName: "origin",
      repo: new RecordingRepoAdapter(),
      repoPaths: { "repo-api": "/allowed/repo-api" },
      runner: new RecordingRunner([runnerResult()]),
      slack,
      state: store,
    })
    const pendingIncident = { ...detectedIncident, threadTs: "pending" }

    try {
      // When: the duplicate detection starts before the first root post has persisted its timestamp.
      const firstDetection = workflow.handleDetectedIncident(pendingIncident)
      await slack.waitForFirstRootPost()
      const secondDetection = workflow.handleDetectedIncident(pendingIncident)
      slack.releaseRootPost()
      await Promise.all([firstDetection, secondDetection])

      // Then: only one root message is posted and the stored incident uses that Slack timestamp.
      expect(slack.rootPostCalls).toBe(1)
      expect(slack.messages.filter((message) => message.threadTs === "pending")).toHaveLength(1)
      expect(store.getIncidentByIssueId("SENTRY-10")?.threadTs).toBe(rootThreadTs)
    } finally {
      store.close()
    }
  })
})
