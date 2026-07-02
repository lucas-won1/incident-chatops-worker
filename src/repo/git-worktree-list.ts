export type GitWorktreeEntry = {
  readonly branch?: string
  readonly path: string
}

const branchRefPrefix = "refs/heads/"

export const parseGitWorktreeList = (stdout: string): readonly GitWorktreeEntry[] => {
  const entries: GitWorktreeEntry[] = []
  let currentPath: string | undefined
  let currentBranch: string | undefined

  const pushEntry = (): void => {
    if (currentPath === undefined) {
      return
    }
    const entry =
      currentBranch === undefined
        ? { path: currentPath }
        : { branch: currentBranch, path: currentPath }
    entries.push(entry)
    currentPath = undefined
    currentBranch = undefined
  }

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) {
      pushEntry()
      continue
    }
    const separatorIndex = line.indexOf(" ")
    const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1)

    switch (key) {
      case "worktree":
        pushEntry()
        currentPath = value
        break
      case "branch":
        currentBranch = value.startsWith(branchRefPrefix)
          ? value.slice(branchRefPrefix.length)
          : value
        break
      default:
        break
    }
  }
  pushEntry()
  return entries
}
