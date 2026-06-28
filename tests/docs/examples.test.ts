import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

import { runCliAsync } from "../../src/cli.js"
import {
  createFixtureRoot,
  readUtf8,
  supportedSoundingUnsupportedClaims,
  validReadme,
  validYamlExample,
  writeDocsFixture,
  writeMinimalDocsFixture,
  writeValidDocsFixture,
  writeValidDocsFixtureWithOperationsClaim,
  writeValidDocsFixtureWithoutPublicDoc,
} from "./docs-fixtures-test-support.js"

const rootDir = process.cwd()

describe("public docs and examples", () => {
  it("keeps example configuration local-first, approval-gated, and secret-free", async () => {
    // Given: the public README and example config files.
    const envExample = await readUtf8(path.join(rootDir, ".env.example"))
    const yamlExample = await readUtf8(path.join(rootDir, "incident-worker.config.example.yaml"))
    const readme = await readUtf8(path.join(rootDir, "README.md"))

    // When: examples are inspected as public repo setup material.
    const parsedYaml: unknown = parseYaml(yamlExample)

    // Then: documented defaults and guardrails match the polling MVP.
    expect(envExample).toContain("SENTRY_POLL_INTERVAL_SECONDS=300")
    expect(JSON.stringify(parsedYaml)).not.toMatch(/xox[abprs]-|xapp-|glpat-|sntrys_/iu)
    expect(readme).toMatch(/Slack approval/iu)
    expect(readme).toMatch(/no webhook|not.*webhook/iu)
    expect(readme).toContain("chat:write")
    expect(readme).toContain("connections:write")
    expect(readme).toMatch(/channel 조회 권한|channels:read/iu)
    expect(readme).toMatch(/Interactivity/iu)
    expect(readme).toContain("GITLAB_TOKEN")
    expect(readme).toMatch(/GitLab Merge Request|GitLab MR/iu)
  })

  it("reports a clean scope verification for the current repo", async () => {
    // Given: the current repository.
    const args = ["dev", "verify-scope", "--strict"]

    // When: the dev scope verifier runs through the real CLI dispatcher.
    const result = await runCliAsync(args)

    // Then: the result names each concrete guardrail instead of returning vague success text.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS polling default 300")
    expect(result.stdout).toContain("PASS Slack approval required")
    expect(result.stdout).toContain("PASS no webhook server")
    expect(result.stdout).toContain("PASS no GUI dependency")
    expect(result.stdout).toContain("PASS no GitHub provider")
    expect(result.stdout).toContain("PASS no unsafe command execution")
    expect(result.stdout).toContain("PASS no raw secret patterns")
  })

  it("reports clean public docs validation with Korean requirement labels", async () => {
    // Given: the current public docs.
    const args = ["dev", "validate-docs"]

    // When: docs validation runs through the real CLI dispatcher.
    const result = await runCliAsync(args)

    // Then: the output names the public docs, links, Korean checks, and plan target.
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS public docs file README.md present")
    expect(result.stdout).toContain("PASS README links docs/security.md")
    expect(result.stdout).toContain("PASS Korean docs requirements docs/security.md")
    expect(result.stdout).toContain("PASS no raw secret patterns")
    expect(result.stdout).toContain("PASS docs unsupported surfaces are non-goals only")
  })

  it("fails scope verification when forbidden MVP surfaces are present", async () => {
    // Given: a fixture tree containing every forbidden surface class.
    const fixtureRoot = await createFixtureRoot("incident-scope-")
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
    await writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ dependencies: { electron: "1.0.0" } }),
    )
    await writeFile(
      path.join(fixtureRoot, "README.md"),
      "Local worker without documented approval gate.\n",
    )
    await writeFile(
      path.join(fixtureRoot, "src", "bad.ts"),
      [
        "import { createServer } from 'node:http'",
        "const token = 'xoxb-live-unredacted-token'",
        "const provider = 'GitHubProvider'",
        "const cmd = 'sh -c dangerous'",
        "createServer()",
      ].join("\n"),
    )

    // When: scope verification scans that tree.
    const result = await runCliAsync(["dev", "verify-scope", "--root", fixtureRoot])

    // Then: every adversarial class is rejected with concrete failure output.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL Slack approval required")
    expect(result.stdout).toContain("FAIL no webhook server")
    expect(result.stdout).toContain("FAIL no GUI dependency")
    expect(result.stdout).toContain("FAIL no GitHub provider")
    expect(result.stdout).toContain("FAIL no unsafe command execution")
    expect(result.stdout).toContain("FAIL no raw secret patterns")
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

  it("rejects injected secret examples during docs validation", async () => {
    // Given: the dev docs validator is asked to inject a secret-like example.

    // When: validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--inject-secret-example"])

    // Then: the malformed public-doc input is rejected without claiming success.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL no raw secret patterns")
  })

  it("fails docs validation when the env example contains a raw Slack token", async () => {
    // Given: a complete docs fixture whose .env.example includes a live-looking token.
    const fixtureRoot = await createFixtureRoot("incident-docs-env-secret-")
    const env = "SENTRY_POLL_INTERVAL_SECONDS=300\nSLACK_BOT_TOKEN=xoxb-live-unredacted-token\n"
    await writeValidDocsFixture(fixtureRoot, { ".env.example": env })

    // When: docs validation scans examples through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: raw values in .env.example fail the shared public-doc secret check.
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL no raw secret patterns")
  })

  it("fails docs validation when the env example is missing", async () => {
    // Given: a docs fixture has README guardrails and parseable YAML but no .env.example.
    const fixtureRoot = await createFixtureRoot("incident-docs-missing-env-")
    await writeDocsFixture(fixtureRoot, {
      "README.md": validReadme,
      "incident-worker.config.example.yaml": validYamlExample,
    })

    // When: validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: the required env example is rejected without all-PASS output.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL required .env.example present")
  })

  it("fails docs validation when a public Korean docs page is missing", async () => {
    // Given: a docs fixture has the old validator requirements but is missing docs/security.md.
    const fixtureRoot = await createFixtureRoot("incident-docs-missing-public-doc-")
    await writeValidDocsFixtureWithoutPublicDoc(fixtureRoot, "docs/security.md")

    // When: docs validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: missing public documentation is rejected with a concrete label.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL public docs file docs/security.md present")
  })

  it("fails docs validation when README does not link every public docs page", async () => {
    // Given: a complete docs fixture whose README omits the security document link.
    const fixtureRoot = await createFixtureRoot("incident-docs-missing-link-")
    await writeValidDocsFixture(fixtureRoot, {
      "README.md": validReadme.replace("[보안](docs/security.md)", "보안 문서"),
    })

    // When: docs validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: README link coverage fails with the missing docs path.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL README links docs/security.md")
  })

  it("fails docs validation when Korean docs requirements are missing", async () => {
    // Given: a complete docs fixture whose security page loses a stable Korean heading.
    const fixtureRoot = await createFixtureRoot("incident-docs-missing-korean-")
    await writeValidDocsFixture(fixtureRoot, {
      "docs/security.md": "# Security Model\n\n## Threat model\nSlack approval env-only\n",
    })

    // When: docs validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: the Korean-first requirement fails for that page.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL Korean docs requirements docs/security.md")
  })

  it.each(supportedSoundingUnsupportedClaims)(
    "fails docs validation when unsupported surface claims are advertised: %s",
    async (claim) => {
      // Given: a complete docs fixture that presents an unsupported surface as available.
      const fixtureRoot = await createFixtureRoot("incident-docs-unsupported-surface-")
      await writeValidDocsFixtureWithOperationsClaim(fixtureRoot, claim)

      // When: docs validation scans public docs.
      const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

      // Then: supported-sounding unsupported surfaces are rejected.
      expect(result.stdout).toContain("FAIL docs unsupported surfaces are non-goals only")
    },
  )

  it("fails docs validation when the YAML example is malformed", async () => {
    // Given: a docs fixture has README guardrails and env defaults but malformed YAML.
    const fixtureRoot = await createFixtureRoot("incident-docs-bad-yaml-")
    await writeValidDocsFixture(fixtureRoot, {
      "incident-worker.config.example.yaml":
        "sentry:\n  projects:\n    - organizationSlug: [demo\n",
    })

    // When: validation runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: the malformed YAML is rejected structurally.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL YAML example parses")
  })

  it("fails scope verification when the requested plan path is missing", async () => {
    // Given: a scope verification command references a nonexistent plan path.
    const fixtureRoot = await createFixtureRoot("incident-missing-plan-")
    const missingPlan = path.join(fixtureRoot, "missing-plan.md")

    // When: scope verification runs through the real CLI dispatcher.
    const result = await runCliAsync(["dev", "verify-scope", "--plan", missingPlan])

    // Then: stale plan state is rejected before success can be inferred.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL plan path exists")
  })
})
