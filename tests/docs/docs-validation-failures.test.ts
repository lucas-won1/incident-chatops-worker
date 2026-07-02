import { describe, expect, it } from "vitest"

import { runCliAsync } from "../../src/cli.js"
import {
  createFixtureRoot,
  validOperationsDocWithClaim,
  validReadme,
  writeValidDocsFixture,
  writeValidDocsFixtureWithoutPublicDoc,
} from "./docs-fixtures-test-support.js"

const githubSecretPrefixes = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"] as const
const unavailableNonGoalClaims = [
  "Webhook setup is not planned in this release.",
  "GUI dashboard is not planned in this release.",
  "Bitbucket provider is not planned in this release.",
  "Operators should know webhook setup is not planned in this release.",
] as const
const strictValidDocsOverrides = {
  "README.md": [
    "로컬 우선 worker with Slack approval.",
    "문서 맵",
    "This local-first MVP has no webhook default.",
    "[아키텍처](docs/architecture.md)",
    "[설정](docs/configuration.md)",
    "[보안](docs/security.md)",
    "[연동](docs/integrations.md)",
    "[운영](docs/operations.md)",
    "[문제 해결](docs/troubleshooting.md)",
  ].join("\n"),
  "docs/architecture.md":
    "# 아키텍처와 워크플로\n\n## 컴포넌트 맵\n시퀀스 Sentry polling Slack thread GitLab MR trust boundary\n",
} as const

describe("docs validation failure coverage", () => {
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

  it("fails docs validation when runner provider docs are stale", async () => {
    // Given: complete public docs whose YAML example still uses only legacy runner keys.
    const fixtureRoot = await createFixtureRoot("incident-docs-stale-runner-provider-")
    await writeValidDocsFixture(fixtureRoot, {
      ...strictValidDocsOverrides,
      "incident-worker.config.example.yaml": [
        "sentry:",
        "  projects:",
        "    - organizationSlug: demo-org",
        "      projectSlug: frontend",
        '      slackChannel: "#incidents"',
        "repos:",
        "  allowlist:",
        "    - /repo",
        "worktree:",
        "  root: /repo/.worktrees",
        "branch:",
        "  prefix: incident/",
        "slack:",
        "  channels:",
        '    default: "#incidents"',
        "runners:",
        "  genericCommandAllowlist:",
        "    - echo",
        "  definitions:",
        "    - id: echo-safe",
        "      type: generic",
        "      command: echo",
        "mr:",
        "  provider: gitlab",
        "  gitlab:",
        "    baseUrl: https://gitlab.com/api/v4",
        "    project: demo-org/frontend",
        "  defaultTargetBranch: main",
      ].join("\n"),
    })

    // When: docs validation scans stale runner examples.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: provider-block coverage fails instead of accepting legacy-only examples.
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("FAIL YAML example uses runner provider blocks")
  })

  it.each(githubSecretPrefixes)(
    "fails docs validation when public docs contain a raw GitHub token prefix: %s",
    async (prefix) => {
      // Given: complete public docs with a live-looking GitHub token prefix in .env.example.
      const fixtureRoot = await createFixtureRoot("incident-docs-github-secret-")
      const env = `SENTRY_POLL_INTERVAL_SECONDS=300\nGITHUB_TOKEN=${prefix}liveUnredactedToken\n`
      await writeValidDocsFixture(fixtureRoot, { ...strictValidDocsOverrides, ".env.example": env })

      // When: docs validation scans examples through the real CLI dispatcher.
      const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

      // Then: GitHub token-shaped values fail the shared public-doc secret check.
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("FAIL no raw secret patterns")
    },
  )

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

  it("allows future provider docs only as explicit unavailable wording", async () => {
    // Given: a future provider line uses an explicit non-goal phrase.
    const fixtureRoot = await createFixtureRoot("incident-docs-future-provider-unavailable-")
    await writeValidDocsFixture(fixtureRoot, {
      ...strictValidDocsOverrides,
      "docs/operations.md": validOperationsDocWithClaim(
        "Bitbucket provider is not available in this release.",
      ),
    })

    // When: docs validation scans future-provider non-goal wording.
    const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

    // Then: explicit unavailable wording stays allowed.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs unsupported surfaces are non-goals only")
  })

  it.each(unavailableNonGoalClaims)(
    "allows unsupported docs surfaces when explicit wording says unavailable: %s",
    async (claim) => {
      // Given: unsupported surface prose explicitly says the surface is not planned.
      const fixtureRoot = await createFixtureRoot("incident-docs-unavailable-surface-")
      await writeValidDocsFixture(fixtureRoot, {
        ...strictValidDocsOverrides,
        "docs/operations.md": validOperationsDocWithClaim(claim),
      })

      // When: docs validation scans unsupported-surface unavailable wording.
      const result = await runCliAsync(["dev", "validate-docs", "--root", fixtureRoot])

      // Then: negative non-goal prose stays allowed, including operator-facing wording.
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("PASS docs unsupported surfaces are non-goals only")
    },
  )
})
