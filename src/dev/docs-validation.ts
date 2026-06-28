import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { parseDocument } from "yaml"

import { findOptionValue } from "../shared/cli-args.js"
import type { CliResult } from "../shared/cli-result.js"
import {
  hasServerCreationSurface,
  hasShippedDevHelperSurface,
  hasStrictBlockedSourceSurface,
  hasUnapprovedRuntimeDependency,
  type TextFile,
} from "./scope-scan.js"

type ScopeCheck = { readonly label: string; readonly ok: boolean }

const excludedDirectories = new Set([".git", ".omo", "coverage", "node_modules"])
const secretLikePattern = /(?:xox[abprs]-|xapp-|glpat-|sntrys_)[A-Za-z0-9_-]{4,}/giu
const allowedSampleSecretPattern =
  /(?:^|[-_])(?:redacted|example|sample|placeholder|dummy|fake|secret)(?:$|[-_])/iu
const publicDocRequirements = [
  { filePath: "README.md", phrases: ["로컬 우선", "문서 맵", "Slack approval"] },
  { filePath: "docs/architecture.md", phrases: ["컴포넌트 맵", "시퀀스", "trust boundary"] },
  { filePath: "docs/configuration.md", phrases: ["설정 레퍼런스", "기본 원칙", "YAML"] },
  { filePath: "docs/security.md", phrases: ["보안 모델", "기본 위협 모델", "Slack approval"] },
  { filePath: "docs/integrations.md", phrases: ["연동", "Slack 앱", "Sentry polling"] },
  { filePath: "docs/operations.md", phrases: ["운영 가이드", "로컬 셸 운영", "SQLite"] },
  { filePath: "docs/troubleshooting.md", phrases: ["문제 해결", "증상", "해결"] },
] as const
const unsupportedDocsSurfacePattern =
  /webhook|github[\s-]+(?:pr|provider)|\bgui\b(?!\/)|dashboard|대시보드/iu
const explicitNonGoalPattern =
  /비목표|지원[^\n.]*아니|지원하지|제외|없|금지|범위 밖|실패|guardrail|쓰지 않습니다|not|no /iu
const readmeNoWebhookPattern = /no webhook|not.{0,40}webhook|webhook.{0,40}not/iu

const readIfPresent = (filePath: string): string =>
  existsSync(filePath) ? readFileSync(filePath, "utf8") : ""

const readableFile = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile()
  } catch (error) {
    if (error instanceof Error) {
      return false
    }
    throw error
  }
}

const yamlParses = (text: string): boolean => {
  const document = parseDocument(text)
  return document.errors.length === 0 && document.contents !== null
}

const collectFiles = (root: string): readonly TextFile[] => {
  if (!existsSync(root)) {
    return []
  }
  const files: TextFile[] = []
  const visit = (entryPath: string): void => {
    const stats = statSync(entryPath)
    if (stats.isDirectory()) {
      if (excludedDirectories.has(path.basename(entryPath))) {
        return
      }
      for (const entry of readdirSync(entryPath)) {
        visit(path.join(entryPath, entry))
      }
      return
    }
    if (stats.isFile() && /\.(?:cjs|example|js|json|mjs|md|map|ts|yaml|yml)$/u.test(entryPath)) {
      files.push({ path: entryPath, text: readFileSync(entryPath, "utf8") })
    }
  }
  visit(root)
  return files
}

const hasRawSecret = (text: string): boolean => {
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

const hasAnySecretMarker = (text: string): boolean => {
  secretLikePattern.lastIndex = 0
  const hasSecretMarker = secretLikePattern.test(text)
  secretLikePattern.lastIndex = 0
  return hasSecretMarker
}

const hasReadmeLink = (readme: string, filePath: string): boolean =>
  filePath === "README.md" || readme.includes(`](${filePath})`) || readme.includes(filePath)

const hasUnsupportedDocsSurface = (text: string): boolean => {
  let context = ""
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("#")) {
      context = line
    }
    if (
      unsupportedDocsSurfacePattern.test(line) &&
      !explicitNonGoalPattern.test(`${context}\n${line}`)
    ) {
      return true
    }
  }
  return false
}

const sourceFiles = (files: readonly TextFile[]): readonly TextFile[] =>
  files.filter(
    (file) =>
      file.path.includes(`${path.sep}src${path.sep}`) &&
      !file.path.endsWith(path.join("src", "dev", "docs-validation.ts")),
  )

const shippedScanFiles = (root: string, files: readonly TextFile[]): readonly TextFile[] =>
  files.filter((file) => {
    const relativePath = path.relative(root, file.path)
    return (
      relativePath === "package.json" ||
      relativePath.startsWith(`src${path.sep}`) ||
      relativePath.startsWith(`dist${path.sep}`)
    )
  })

const hasWebhookServer = (files: readonly TextFile[]): boolean =>
  sourceFiles(files).some(
    (file) => hasServerCreationSurface(file) || /sentry.{0,24}webhook/iu.test(file.text),
  )

const hasGuiDependency = (root: string): boolean =>
  hasUnapprovedRuntimeDependency(readIfPresent(path.join(root, "package.json")))

const hasStrictBlockedSourcePattern = (root: string, files: readonly TextFile[]): boolean =>
  shippedScanFiles(root, files).some((file) => hasStrictBlockedSourceSurface(file))

const hasGitHubProvider = (files: readonly TextFile[]): boolean =>
  sourceFiles(files).some((file) =>
    /GitHub\w*Provider|github-provider|github\s+pr/iu.test(file.text),
  )

const hasUnsafeCommandExecution = (files: readonly TextFile[]): boolean =>
  sourceFiles(files).some((file) =>
    /(?:^|["'\s])(?:sh|bash)\s+-c\b|shell:\s*true|child_process\.exec|execSync\s*\(|\bspawn\s*\(\s*["'`](?:sh|bash)["'`]\s*,\s*\[\s*["'`](?:-c|-lc)["'`]/mu.test(
      file.text,
    ),
  )

const hasSlackApprovalGate = (readme: string): boolean => /Slack approval/iu.test(readme)

const hasPollingDefault = (envExample: string): boolean =>
  /^SENTRY_POLL_INTERVAL_SECONDS=300$/mu.test(envExample)

const renderChecks = (checks: readonly ScopeCheck[]): string =>
  checks
    .map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.label}`)
    .join("\n")
    .concat("\n")

const check = (label: string, ok: boolean): ScopeCheck => ({ label, ok })

const resultFromChecks = (checks: readonly ScopeCheck[]): CliResult => ({
  exitCode: checks.every((check) => check.ok) ? 0 : 1,
  stdout: renderChecks(checks),
  stderr: "",
})

export const validateDocs = (args: readonly string[]): CliResult => {
  const root = findOptionValue(args, "--root") ?? process.cwd()
  const plan = findOptionValue(args, "--plan")
  const planPath = plan === undefined ? undefined : path.resolve(root, plan)
  const injectSecretExample = args.includes("--inject-secret-example")
  const envExamplePath = path.join(root, ".env.example")
  const yamlExamplePath = path.join(root, "incident-worker.config.example.yaml")
  const readme = `${readIfPresent(path.join(root, "README.md"))}${
    injectSecretExample ? "\nInjected example: xoxb-live-unredacted-token\n" : ""
  }`
  const yamlExample = readIfPresent(yamlExamplePath)
  const docsText = publicDocRequirements
    .map((doc) => readIfPresent(path.join(root, doc.filePath)))
    .join("\n")
  const docsAndExamples = `${readme}\n${docsText}\n${readIfPresent(envExamplePath)}\n${yamlExample}`
  const checks: readonly ScopeCheck[] = [
    ...(planPath === undefined ? [] : [check("docs plan path exists", readableFile(planPath))]),
    ...publicDocRequirements.map((doc) =>
      check(
        `public docs file ${doc.filePath} present`,
        readableFile(path.join(root, doc.filePath)),
      ),
    ),
    ...publicDocRequirements
      .filter((doc) => doc.filePath !== "README.md")
      .map((doc) => check(`README links ${doc.filePath}`, hasReadmeLink(readme, doc.filePath))),
    ...publicDocRequirements.map((doc) =>
      check(
        `Korean docs requirements ${doc.filePath}`,
        doc.phrases.every((phrase) =>
          readIfPresent(path.join(root, doc.filePath)).includes(phrase),
        ),
      ),
    ),
    check("required .env.example present", readableFile(envExamplePath)),
    check("required YAML example present", readableFile(yamlExamplePath)),
    check("YAML example parses", yamlParses(yamlExample)),
    check("README documents Slack approval", hasSlackApprovalGate(readme)),
    check("README documents no-webhook default", readmeNoWebhookPattern.test(readme)),
    check("YAML example has no secret-looking values", !hasAnySecretMarker(yamlExample)),
    check("no raw secret patterns", !hasRawSecret(docsAndExamples)),
    check("docs unsupported surfaces are non-goals only", !hasUnsupportedDocsSurface(docsText)),
  ]
  return resultFromChecks(checks)
}

export const verifyScope = (args: readonly string[]): CliResult => {
  const root = findOptionValue(args, "--root") ?? process.cwd()
  const plan = findOptionValue(args, "--plan")
  const strict = args.includes("--strict")
  const planPath = plan === undefined ? undefined : path.resolve(root, plan)
  const files = collectFiles(root)
  const readme = readIfPresent(path.join(root, "README.md"))
  const envExample = readIfPresent(path.join(root, ".env.example"))
  const publicText = [
    readme,
    envExample,
    readIfPresent(path.join(root, "incident-worker.config.example.yaml")),
  ].join("\n")
  const checks: readonly ScopeCheck[] = [
    ...(planPath === undefined ? [] : [check("plan path exists", readableFile(planPath))]),
    check("polling default 300", hasPollingDefault(envExample)),
    check("Slack approval required", hasSlackApprovalGate(readme)),
    check("no webhook server", !hasWebhookServer(files)),
    check("no GUI dependency", !hasGuiDependency(root)),
    check("no GitHub provider", !hasGitHubProvider(files)),
    check("no unsafe command execution", !hasUnsafeCommandExecution(files)),
    check(
      "no raw secret patterns",
      !hasRawSecret(publicText) && !sourceFiles(files).some((file) => hasRawSecret(file.text)),
    ),
    ...(strict
      ? [
          check(
            "strict source forbidden-pattern scan clean",
            !hasStrictBlockedSourcePattern(root, files),
          ),
          check(
            "strict shipped dev helper scan clean",
            !hasShippedDevHelperSurface(root, shippedScanFiles(root, files)),
          ),
        ]
      : []),
  ]
  return resultFromChecks(checks)
}

export const runDocsDevCommand = (
  subcommand: string | undefined,
  args: readonly string[],
): CliResult | undefined => {
  switch (subcommand) {
    case "validate-docs":
      return validateDocs(args)
    case "verify-scope":
      return verifyScope(args)
    default:
      return undefined
  }
}
