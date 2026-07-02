import { type GitCommandRunner, SpawnGitCommandRunner } from "../repo/local-git.js"
import type { RunnerCleanChecker } from "./types.js"

export const dirtyStatusFor = async (
  cleanChecker: RunnerCleanChecker,
  workspacePath: string,
): Promise<string | undefined> => {
  const status = await cleanChecker.dirtyStatus?.(workspacePath)
  const trimmed = status?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

export class GitRunnerCleanChecker implements RunnerCleanChecker {
  readonly #runner: GitCommandRunner

  public constructor(runner: GitCommandRunner = new SpawnGitCommandRunner()) {
    this.#runner = runner
  }

  public async isClean(workspacePath: string): Promise<boolean> {
    return (await this.dirtyStatus(workspacePath)).trim().length === 0
  }

  public async dirtyStatus(workspacePath: string): Promise<string> {
    const result = await this.#runner.run({
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      command: "git",
      cwd: workspacePath,
    })
    return result.stdout
  }
}
