import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import { createFixtureRoot, writeMinimalDocsFixture } from "./docs-fixtures-test-support.js"

describe("docs scope guardrails", () => {
  it("keeps baseline guardrails for webhook, GUI, unsafe commands, and raw secrets", async () => {
    // Given: separate fixture trees with the existing forbidden surface classes.
    const webhookRoot = await createFixtureRoot("incident-baseline-webhook-")
    await writeMinimalDocsFixture(webhookRoot)
    await mkdir(path.join(webhookRoot, "src"), { recursive: true })
    await writeFile(
      path.join(webhookRoot, "src", "webhook.ts"),
      ["import { createServer } from 'node:http'", "createServer()"].join("\n"),
    )

    const guiRoot = await createFixtureRoot("incident-baseline-gui-")
    await writeMinimalDocsFixture(guiRoot, {
      "package.json": JSON.stringify({ dependencies: { electron: "1.0.0" } }),
    })

    const unsafeRoot = await createFixtureRoot("incident-baseline-unsafe-")
    await writeMinimalDocsFixture(unsafeRoot)
    await mkdir(path.join(unsafeRoot, "src"), { recursive: true })
    await writeFile(path.join(unsafeRoot, "src", "unsafe.ts"), 'const cmd = "sh -c dangerous"\n')

    const secretRoot = await createFixtureRoot("incident-baseline-secret-")
    await writeMinimalDocsFixture(secretRoot)
    await mkdir(path.join(secretRoot, "src"), { recursive: true })
    await writeFile(path.join(secretRoot, "src", "secret.ts"), 'const token = "xoxb-live-token"\n')

    // When: each guardrail fixture is scanned through the real CLI dispatcher.
    const webhookResult = await runCliAsync(["dev", "verify-scope", "--root", webhookRoot])
    const guiResult = await runCliAsync(["dev", "verify-scope", "--root", guiRoot])
    const unsafeResult = await runCliAsync(["dev", "verify-scope", "--root", unsafeRoot])
    const secretResult = await runCliAsync(["dev", "verify-scope", "--root", secretRoot])

    // Then: the pre-existing forbidden surface classes remain rejected independently.
    expect(webhookResult.stdout).toContain("FAIL no webhook server")
    expect(guiResult.stdout).toContain("FAIL no GUI dependency")
    expect(unsafeResult.stdout).toContain("FAIL no unsafe command execution")
    expect(secretResult.stdout).toContain("FAIL no raw secret patterns")
  })

  it("allows shipped GitHub provider source while keeping scope verification clean", async () => {
    // Given: a valid fixture with GitLab and GitHub provider source only.
    const fixtureRoot = await createFixtureRoot("incident-github-provider-scope-")
    await writeMinimalDocsFixture(fixtureRoot, {
      "package.json": JSON.stringify({ dependencies: { ky: "1.0.0" } }),
    })
    await mkdir(path.join(fixtureRoot, "src", "mr"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "mr", "github-provider.ts"),
      'export const createGitHubPullRequestProvider = () => "github provider"\n',
    )

    // When: scope verification scans shipped GitHub provider code.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: GitHub is in the shipped provider allowlist.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS only GitLab/GitHub providers are shipped")
  })

  it("rejects future provider source while allowing GitHub provider source", async () => {
    // Given: a source fixture with both supported GitHub and unsupported future provider names.
    const fixtureRoot = await createFixtureRoot("incident-future-provider-scope-")
    await writeMinimalDocsFixture(fixtureRoot)
    await mkdir(path.join(fixtureRoot, "src", "mr"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "mr", "providers.ts"),
      [
        'export const createGitHubPullRequestProvider = () => "github"',
        'export const createBitbucketPullRequestProvider = () => "bitbucket"',
      ].join("\n"),
    )

    // When: scope verification scans shipped provider source.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: future providers remain blocked outside documentation TODOs.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL only GitLab/GitHub providers are shipped")
  })

  it("fails scope verification when shipped smoke CLI source starts a server", async () => {
    // Given: a fixture tree that mirrors the rejected shipped smoke helper shape.
    const fixtureRoot = await createFixtureRoot("incident-smoke-server-scope-")
    await writeMinimalDocsFixture(fixtureRoot)
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "gitlab-smoke-cli.ts"),
      ["import { createServer } from 'node:http'", "createServer()"].join("\n"),
    )

    // When: scope verification scans source files.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: smoke CLI naming does not exempt shipped source from the no-server rule.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL no webhook server")
  })

  it("fails scope verification when Node source spawns shell eval forms", async () => {
    // Given: a fixture tree with valid public docs and realistic unsafe Node command execution.
    const fixtureRoot = await createFixtureRoot("incident-unsafe-spawn-")
    await writeMinimalDocsFixture(fixtureRoot)
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "unsafe.ts"),
      [
        'import { spawn } from "node:child_process"',
        'spawn("sh", ["-c", "dangerous"])',
        'spawn("bash", ["-lc", "dangerous"])',
      ].join("\n"),
    )

    // When: scope verification scans the realistic source fixture.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: shell-eval argv forms are rejected instead of slipping through as a PASS.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL no unsafe command execution")
  })

  it("fails scope verification when source shells out to provider CLIs", async () => {
    // Given: shipped source tries to create review requests through provider CLIs.
    const fixtureRoot = await createFixtureRoot("incident-provider-cli-shellout-")
    await writeMinimalDocsFixture(fixtureRoot)
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "provider-cli.ts"),
      [
        'import { spawn } from "node:child_process"',
        'spawn("gh", ["pr", "create"])',
        'spawn("glab", ["mr", "create"])',
      ].join("\n"),
    )

    // When: scope verification scans the provider CLI shellout source.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: provider CLI dependencies are rejected separately from GitHub REST support.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL no provider CLI shellout")
  })

  it("fails scope verification only in strict mode for strict source patterns", async () => {
    // Given: a fixture whose normal scope is valid but source contains strict-only patterns.
    const fixtureRoot = await createFixtureRoot("incident-strict-scope-")
    await writeMinimalDocsFixture(fixtureRoot)
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "strict.ts"),
      'const forbidden = "--dangerously-bypass-approvals-and-sandbox"\n',
    )

    // When: scope verification runs in normal and strict modes.
    const normalResult = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])
    const strictResult = await runCliAsync([
      "dev",
      "verify-scope",
      "--strict",
      "--root",
      fixtureRoot,
    ])

    // Then: only strict mode rejects the strict source pattern.
    expect(normalResult.exitCode).toBe(0)
    expect(strictResult.exitCode).not.toBe(0)
    expect(strictResult.stdout).toContain("FAIL strict source forbidden-pattern scan clean")
  })

  it("fails strict scope verification when shipped build output contains strict patterns", async () => {
    // Given: a fixture whose source is valid but shipped build output contains strict-only patterns.
    const fixtureRoot = await createFixtureRoot("incident-strict-dist-scope-")
    await writeMinimalDocsFixture(fixtureRoot, {
      "package.json": JSON.stringify({ dependencies: {} }),
    })
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await mkdir(path.join(fixtureRoot, "dist"), { recursive: true })
    await writeFile(path.join(fixtureRoot, "src", "clean.ts"), "export const clean = true\n")
    await writeFile(
      path.join(fixtureRoot, "dist", "bad.js"),
      'const forbidden = "--dangerously-bypass-approvals-and-sandbox"\n',
    )

    // When: strict scope verification scans that fixture.
    const result = await runCliAsync(["dev", "verify-scope", "--strict", "--root", fixtureRoot])

    // Then: shipped build output is included in the strict scan.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL strict source forbidden-pattern scan clean")
  })

  it("fails strict scope verification when shipped helper routes and exports are present", async () => {
    // Given: a fixture that mirrors removed shipped helper routes and exports.
    const fixtureRoot = await createFixtureRoot("incident-dev-helper-scope-")
    await writeMinimalDocsFixture(fixtureRoot, {
      "package.json": JSON.stringify({ dependencies: {} }),
    })
    await mkdir(path.join(fixtureRoot, "src", "repo"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "src", "cli.ts"),
      [
        'if (args[0] === "dev" && args[1] === "git-smoke") {',
        "  return runGitSmoke(args.slice(2))",
        "}",
      ].join("\n"),
    )
    await writeFile(
      path.join(fixtureRoot, "src", "repo", "git-smoke-cli.ts"),
      "export const runGitSmoke = async () => undefined\n",
    )

    // When: strict scope verification scans shipped source.
    const result = await runCliAsync(["dev", "verify-scope", "--strict", "--root", fixtureRoot])

    // Then: shipped helper CLI routes and exports are rejected.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL strict shipped dev helper scan clean")
  })
})
