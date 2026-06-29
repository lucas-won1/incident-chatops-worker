import path from "node:path"

import ts from "typescript"

import { isDangerousCodexFlagArgument } from "../runner/safety.js"

export type TextFile = {
  readonly path: string
  readonly text: string
}

type PackageMetadata = {
  readonly dependencies?: unknown
}

const allowedRuntimeDependencies = new Set(["@slack/bolt", "ky", "sql.js", "yaml", "zod"])
const allowedDevSubcommands = new Set([
  "parse-action",
  "parse-slack-action",
  "render-slack",
  "run-runner",
  "scenario",
  "validate-docs",
  "verify-scope",
])
const unsafeDirectiveNames = new Set(["ignore", "expect-error"])
const unsafeCallNames = new Set(["createServer", "express"])
const processLaunchCallNames = new Set(["execFile", "execFileSync", "spawn", "spawnSync"])
const providerCliNames = new Set(["aws", "az", "bb", "gh", "glab"])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const hasUnapprovedRuntimeDependency = (packageText: string): boolean => {
  if (packageText.length === 0) {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(packageText)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return true
    }
    throw error
  }
  if (!isRecord(parsed)) {
    return true
  }
  const packageMetadata: PackageMetadata = parsed
  const dependencies = packageMetadata.dependencies
  if (dependencies === undefined) {
    return false
  }
  if (!isRecord(dependencies)) {
    return true
  }
  return Object.keys(dependencies).some((name) => !allowedRuntimeDependencies.has(name))
}

const scriptKindForPath = (filePath: string): ts.ScriptKind => {
  const extension = path.extname(filePath)
  switch (extension) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return ts.ScriptKind.JS
    case ".cts":
      return ts.ScriptKind.TS
    case ".mts":
      return ts.ScriptKind.TS
    case ".ts":
      return ts.ScriptKind.TS
    default:
      return ts.ScriptKind.Unknown
  }
}

const sourceFileFor = (file: TextFile): ts.SourceFile | undefined => {
  const scriptKind = scriptKindForPath(file.path)
  if (scriptKind === ts.ScriptKind.Unknown) {
    return undefined
  }
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind)
}

const callName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text
  }
  return undefined
}

const stringLiteralText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  return undefined
}

const firstStringArgument = (node: ts.CallExpression): string | undefined => {
  const firstArgument = node.arguments[0]
  return firstArgument === undefined ? undefined : stringLiteralText(firstArgument)
}

const elementAccessIndex = (expression: ts.Expression): number | undefined => {
  if (
    !ts.isElementAccessExpression(expression) ||
    !ts.isNumericLiteral(expression.argumentExpression)
  ) {
    return undefined
  }
  return Number.parseInt(expression.argumentExpression.text, 10)
}

const devSubcommandRouteLiteral = (node: ts.BinaryExpression): string | undefined => {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return undefined
  }
  const leftText = stringLiteralText(node.left)
  const rightText = stringLiteralText(node.right)
  const routeLiteral = leftText ?? rightText
  if (routeLiteral === undefined) {
    return undefined
  }
  const comparedExpression = leftText === undefined ? node.left : node.right
  return elementAccessIndex(comparedExpression) === 1 ? routeLiteral : undefined
}

const isStrictSourceOverrideLiteral = (value: string): boolean =>
  value.split("=", 1)[0] !== "--add-dir" && isDangerousCodexFlagArgument(value)

const hasSyntaxSurface = (
  file: TextFile,
): {
  readonly providerCliShellout: boolean
  readonly strictBlocked: boolean
  readonly serverCreation: boolean
} => {
  const sourceFile = sourceFileFor(file)
  if (sourceFile === undefined) {
    return { providerCliShellout: false, strictBlocked: false, serverCreation: false }
  }
  let providerCliShellout = false
  let serverCreation = false
  let strictBlocked = false
  const visit = (node: ts.Node): void => {
    if (providerCliShellout && serverCreation && strictBlocked) {
      return
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      strictBlocked = true
    }
    if (ts.isCallExpression(node) && unsafeCallNames.has(callName(node.expression) ?? "")) {
      serverCreation = true
      strictBlocked = true
    }
    if (
      ts.isCallExpression(node) &&
      processLaunchCallNames.has(callName(node.expression) ?? "") &&
      providerCliNames.has(firstStringArgument(node) ?? "")
    ) {
      providerCliShellout = true
      strictBlocked = true
    }
    const literalText = stringLiteralText(node)
    if (literalText !== undefined && isStrictSourceOverrideLiteral(literalText)) {
      strictBlocked = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { providerCliShellout, strictBlocked, serverCreation }
}

const hasUnsafeDirective = (text: string): boolean =>
  text.split(/\r?\n/u).some((line) => {
    const markerIndex = line.indexOf("@ts-")
    if (markerIndex < 0) {
      return false
    }
    const directive = /^[A-Za-z-]+/u.exec(line.slice(markerIndex + 4))?.[0]
    return directive !== undefined && unsafeDirectiveNames.has(directive)
  })

const exportedNames = (file: TextFile): readonly string[] => {
  const sourceFile = sourceFileFor(file)
  if (sourceFile === undefined) {
    return []
  }
  const names: string[] = []
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (isExported !== true) {
      continue
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text)
        }
      }
    }
  }
  return names
}

const hasUnexpectedDevRoute = (file: TextFile): boolean => {
  const sourceFile = sourceFileFor(file)
  if (sourceFile === undefined || path.basename(file.path) !== "cli.ts") {
    return false
  }
  let unexpected = false
  const visit = (node: ts.Node): void => {
    if (unexpected) {
      return
    }
    if (ts.isBinaryExpression(node)) {
      const subcommand = devSubcommandRouteLiteral(node)
      if (subcommand !== undefined && !allowedDevSubcommands.has(subcommand)) {
        unexpected = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return unexpected
}

const hasRepoLocalCliExport = (root: string, file: TextFile): boolean => {
  const relativePath = path.relative(root, file.path)
  return (
    relativePath.startsWith(path.join("src", "repo", path.sep)) &&
    relativePath.endsWith("-cli.ts") &&
    exportedNames(file).length > 0
  )
}

export const hasServerCreationSurface = (file: TextFile): boolean =>
  hasSyntaxSurface(file).serverCreation

export const hasProviderCliShelloutSurface = (file: TextFile): boolean =>
  hasSyntaxSurface(file).providerCliShellout

export const hasStrictBlockedSourceSurface = (file: TextFile): boolean =>
  hasSyntaxSurface(file).strictBlocked || hasUnsafeDirective(file.text)

export const hasShippedDevHelperSurface = (root: string, files: readonly TextFile[]): boolean =>
  files.some((file) => hasUnexpectedDevRoute(file) || hasRepoLocalCliExport(root, file))
