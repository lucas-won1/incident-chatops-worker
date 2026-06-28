import { writeFileSync } from "node:fs"

import type {
  RunnerProcess,
  RunnerProcessInvocation,
  RunnerProcessResult,
} from "../../src/runner/index.js"

export class LastMessageProcess implements RunnerProcess {
  public readonly invocations: RunnerProcessInvocation[] = []

  public constructor(
    private readonly lastMessageJson: string,
    private readonly result: RunnerProcessResult = {
      exitCode: 0,
      stderr: "",
      stdout: "codex transport log",
    },
  ) {}

  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    this.invocations.push(invocation)
    const outputFlagIndex = invocation.args.indexOf("--output-last-message")
    const outputPath = invocation.args[outputFlagIndex + 1]
    if (outputPath === undefined) {
      throw new Error("missing --output-last-message path")
    }
    writeFileSync(outputPath, this.lastMessageJson)
    return this.result
  }
}
