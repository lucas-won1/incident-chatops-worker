const secretLikePattern =
  /(?:xox[abprs]-|xapp-|glpat-|sntrys_|github_pat_|gh[opusr]_)[A-Za-z0-9_-]{4,}/giu
const allowedSampleSecretPattern =
  /(?:^|[-_])(?:redacted|example|sample|placeholder|dummy|fake|secret)(?:$|[-_])/iu
const unsupportedDocsSurfacePattern = /webhook|\bgui\b(?!\/)|dashboard|대시보드/iu
const unsupportedSurfaceTodoPattern =
  /^\s*(?:[-*]\s*)?\[\s\]\s*(?:webhook|\bgui\b(?!\/)|dashboard|대시보드)/iu
const unsupportedSurfaceNonGoalPattern =
  /비목표|지원[^\n.]*아니|지원하지|제외|없|금지|거부|범위 밖|실패|쓰지 않습니다|(?:not|never)\s+(?:supported|shipped|implemented|available|planned)|(?:unsupported|unimplemented|non-goal|out of scope)|no\s+(?:support\s+for|webhook|gui|dashboard)/iu
const supportedSurfaceAvailabilityClaimPattern =
  /(?<!\bno\s)(?<!\bnot\s)(?<!\bnever\s)\b(?:available|supports?|supported|supporting|shipped|implemented|enabled|ready|creates?|operational)\b|지원(?:됨|됩니다|한다|합니다)|사용\s*가능|제공/iu
const supportedSurfaceNegativeUsePattern =
  /지원되는\s+(?:것|기능)처럼\s+쓰지 않습니다|shipped\s+provider[가이]?\s+아닙니다/iu
const futureGitProviderPattern =
  /\b(?:bitbucket|gitea|forgejo|codeberg|azure\s+devops(?:\s+repos)?|aws\s+codecommit|codecommit|gerrit)\b/iu
const futureGitProviderTodoPattern =
  /^\s*(?:[-*]\s*)?\[\s\]\s*(?:bitbucket|gitea|forgejo|codeberg|azure\s+devops(?:\s+repos)?|aws\s+codecommit|codecommit|gerrit)\b/iu
const futureGitProviderNonGoalPattern =
  /비목표|지원[^\n.]*아니|지원하지|제외|없|금지|거부|범위 밖|쓰지 않습니다|(?:not|never)\s+(?:supported|shipped|implemented|available|planned)|(?:unsupported|unimplemented|non-goal|out of scope)|no\s+support\s+for/iu

export const hasRawSecret = (text: string): boolean => {
  secretLikePattern.lastIndex = 0
  const matches = text.matchAll(secretLikePattern)
  for (const match of matches) {
    const value = match[0]
    if (!allowedSampleSecretPattern.test(value)) {
      return true
    }
  }
  return false
}

export const hasAnySecretMarker = (text: string): boolean => {
  secretLikePattern.lastIndex = 0
  const hasSecretMarker = secretLikePattern.test(text)
  secretLikePattern.lastIndex = 0
  return hasSecretMarker
}

export const hasReadmeLink = (readme: string, filePath: string): boolean =>
  filePath === "README.md" || readme.includes(`](${filePath})`) || readme.includes(filePath)

export const hasUnsupportedDocsSurface = (text: string): boolean => {
  let context = ""
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("#")) {
      context = line
    }
    const hasAvailabilityClaim = supportedSurfaceAvailabilityClaimPattern.test(line)
    const unsupportedSurfaceAllowed =
      supportedSurfaceNegativeUsePattern.test(line) ||
      (unsupportedSurfaceNonGoalPattern.test(line) && !hasAvailabilityClaim) ||
      unsupportedSurfaceTodoPattern.test(line) ||
      (unsupportedSurfaceNonGoalPattern.test(context) && !hasAvailabilityClaim)
    if (unsupportedDocsSurfacePattern.test(line) && !unsupportedSurfaceAllowed) {
      return true
    }
    const futureGitProviderAllowed =
      supportedSurfaceNegativeUsePattern.test(line) ||
      (futureGitProviderNonGoalPattern.test(line) && !hasAvailabilityClaim) ||
      futureGitProviderTodoPattern.test(line) ||
      (futureGitProviderNonGoalPattern.test(context) && !hasAvailabilityClaim)
    if (futureGitProviderPattern.test(line) && !futureGitProviderAllowed) {
      return true
    }
  }
  return false
}
