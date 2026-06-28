import { spawn } from "node:child_process"

import { RunnerTimeoutError } from "./errors.js"
import { redactRunnerOutput, validateArgs, validateExecutable } from "./safety.js"
import type { RunnerProcess, RunnerProcessInvocation, RunnerProcessResult } from "./types.js"

export class SafeProcessRunner implements RunnerProcess {
  public async run(invocation: RunnerProcessInvocation): Promise<RunnerProcessResult> {
    validateExecutable(invocation.command, "runner")
    validateArgs(invocation.args, "runner")

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let timedOut = false
      let settled = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, invocation.timeoutMs)

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(error)
      }

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
      child.on("error", rejectOnce)
      child.on("close", (code) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (timedOut) {
          reject(new RunnerTimeoutError(invocation.command, invocation.timeoutMs))
          return
        }
        resolve({
          exitCode: code ?? 1,
          stderr: redactRunnerOutput(
            Buffer.concat(stderrChunks).toString("utf8"),
            invocation.outputLimitBytes,
            invocation.secretRedactionValues ?? [],
          ),
          stdout: redactRunnerOutput(
            Buffer.concat(stdoutChunks).toString("utf8"),
            invocation.outputLimitBytes,
            invocation.secretRedactionValues ?? [],
          ),
        })
      })

      child.stdin.end(invocation.stdin ?? "")
    })
  }
}
