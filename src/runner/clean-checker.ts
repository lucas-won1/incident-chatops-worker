import { type GitCommandRunner, SpawnGitCommandRunner } from "../repo/local-git.js"
import type { RunnerCleanChecker } from "./types.js"

export class GitRunnerCleanChecker implements RunnerCleanChecker {
  readonly #runner: GitCommandRunner

  public constructor(runner: GitCommandRunner = new SpawnGitCommandRunner()) {
    this.#runner = runner
  }

  public async isClean(worktreePath: string): Promise<boolean> {
    const result = await this.#runner.run({
      args: ["status", "--porcelain=v1"],
      command: "git",
      cwd: worktreePath,
    })
    return result.stdout.trim().length === 0
  }
}
