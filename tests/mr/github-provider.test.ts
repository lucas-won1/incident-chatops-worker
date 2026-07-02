import { afterEach, describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  type CreateMergeRequestInput,
  createGitHubPullRequestProvider,
  type MergeRequestAuditEvent,
} from "../../src/mr/index.js"
import {
  createSuccessResponse,
  type GitHubTestServer,
  labelsBodySchema,
  pullRequestBodySchema,
  type RecordedGitHubRequest,
  startGitHubServer,
} from "./github-provider-test-server.js"

const createInput = (
  overrides: Partial<CreateMergeRequestInput> = {},
): CreateMergeRequestInput => ({
  bodyTemplate: "body",
  draft: false,
  labels: [],
  sourceBranch: "incident/demo",
  targetBranch: "main",
  titleTemplate: "title",
  ...overrides,
})

const createProvider = (server: GitHubTestServer, auditEvents?: MergeRequestAuditEvent[]) =>
  createGitHubPullRequestProvider({
    ...(auditEvents === undefined
      ? {}
      : {
          audit: (event: MergeRequestAuditEvent) => {
            auditEvents.push(event)
          },
        }),
    baseUrl: server.baseUrl,
    owner: "acme",
    repo: "shop",
    token: "github_pat_secret_example",
  })

const expectCreateRequest = (
  request: RecordedGitHubRequest | undefined,
  expectedBody: z.infer<typeof pullRequestBodySchema>,
): void => {
  expect(request?.method).toBe("POST")
  expect(request?.url).toBe("/repos/acme/shop/pulls")
  expect(request?.headers.authorization).toBe("Bearer github_pat_secret_example")
  expect(request?.headers.accept).toBe("application/vnd.github+json")
  expect(request?.headers["x-github-api-version"]).toBe("2022-11-28")
  expect(pullRequestBodySchema.parse(request?.body)).toEqual(expectedBody)
}

const expectSafeAudit = (auditEvents: readonly MergeRequestAuditEvent[]): void => {
  expect(JSON.stringify(auditEvents)).not.toContain("github_pat_secret_example")
  expect(JSON.stringify(auditEvents)).not.toContain("authorization")
  expect(JSON.stringify(auditEvents)).not.toContain("Bearer")
}

const servers: GitHubTestServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
})

describe("GitHub pull request provider", () => {
  it("creates a pull request with rendered templates, REST headers, JSON body, labels, and safe audit events", async () => {
    // Given: a GitHub API fake and a provider configured with an env-sourced token.
    const server = await startGitHubServer([
      createSuccessResponse(42),
      { body: [{ name: "incident" }], statusCode: 200 },
    ])
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createGitHubPullRequestProvider({
      audit: (event) => {
        auditEvents.push(event)
      },
      baseUrl: `${server.baseUrl}/`,
      owner: "acme",
      repo: "shop",
      token: "github_pat_secret_example",
    })

    // When: the provider creates a PR for a pushed incident branch.
    const result = await provider.createMergeRequest({
      bodyTemplate: "Incident fix body for {sourceBranch} into {targetBranch}.",
      draft: true,
      labels: ["incident", "automated"],
      sourceBranch: "incident/demo",
      targetBranch: "main",
      titleTemplate: "Fix {sourceBranch}",
    })

    // Then: the create and label requests match the GitHub REST contracts.
    expect(provider.provider).toBe("github")
    expect(result.url).toBe("https://github.example/acme/shop/pull/42")
    expect(server.requests).toHaveLength(2)
    expectCreateRequest(server.requests[0], {
      base: "main",
      body: "Incident fix body for incident/demo into main.",
      draft: true,
      head: "incident/demo",
      title: "Fix incident/demo",
    })
    expect(server.requests[1]?.method).toBe("POST")
    expect(server.requests[1]?.url).toBe("/repos/acme/shop/issues/42/labels")
    expect(labelsBodySchema.parse(server.requests[1]?.body)).toEqual({
      labels: ["incident", "automated"],
    })
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "merge_request.create.requested",
        provider: "github",
        repository: "acme/shop",
      }),
      expect.objectContaining({
        action: "merge_request.create.succeeded",
        provider: "github",
        repository: "acme/shop",
        statusCode: 201,
        url: "https://github.example/acme/shop/pull/42",
      }),
      expect.objectContaining({
        action: "merge_request.labels.succeeded",
        provider: "github",
        repository: "acme/shop",
        statusCode: 200,
      }),
    ])
    expectSafeAudit(auditEvents)
  })

  it("sends long pull request bodies as JSON instead of shelling through a CLI", async () => {
    // Given: untrusted PR text with shell-looking content and a body longer than argv-friendly usage.
    const server = await startGitHubServer([createSuccessResponse(7)])
    servers.push(server)
    const provider = createProvider(server)
    const longBody = `$(gh pr create --fill)\n${"body-line\n".repeat(5000)}`

    // When: the provider creates a PR without labels.
    await provider.createMergeRequest(
      createInput({
        bodyTemplate: longBody,
        titleTemplate: "Fix {sourceBranch}",
      }),
    )

    // Then: the body is delivered intact in the JSON payload and no label/CLI-shaped extra request occurs.
    expect(server.requests).toHaveLength(1)
    expect(pullRequestBodySchema.parse(server.requests[0]?.body).body).toBe(longBody)
  })

  it("does not call the labels API when labels are empty", async () => {
    // Given: a GitHub provider with no labels requested.
    const server = await startGitHubServer([createSuccessResponse(8)])
    servers.push(server)
    const provider = createProvider(server)

    // When: the provider creates a PR.
    await provider.createMergeRequest(createInput())

    // Then: only the PR create endpoint is called.
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.url).toBe("/repos/acme/shop/pulls")
  })

  it("maps create non-201 responses to a typed provider error and failed audit event", async () => {
    // Given: GitHub rejects PR creation with an HTTP response that is not the create success status.
    const server = await startGitHubServer([{ body: { message: "nope" }, statusCode: 200 }])
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createProvider(server, auditEvents)

    // When / Then: the provider rejects with status and audit stage details.
    await expect(provider.createMergeRequest(createInput())).rejects.toMatchObject({
      kind: "unexpected",
      name: "GitHubPullRequestApiError",
      statusCode: 200,
    })
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "merge_request.create.requested" }),
      expect.objectContaining({
        action: "merge_request.create.failed",
        provider: "github",
        repository: "acme/shop",
        stage: "create",
        statusCode: 200,
      }),
    ])
  })

  it("returns the created PR URL and audits label failures when labels fail after creation", async () => {
    // Given: GitHub creates the PR but rejects label application.
    const server = await startGitHubServer([
      createSuccessResponse(9),
      { body: { message: "missing label" }, statusCode: 422 },
    ])
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createProvider(server, auditEvents)

    // When: the provider creates a PR but cannot apply labels.
    const result = await provider.createMergeRequest(createInput({ labels: ["missing-label"] }))

    // Then: label failure is non-fatal so the workflow can persist the PR URL.
    expect(result.url).toBe("https://github.example/acme/shop/pull/9")
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "merge_request.create.requested" }),
      expect.objectContaining({
        action: "merge_request.create.succeeded",
        provider: "github",
        repository: "acme/shop",
        statusCode: 201,
        url: "https://github.example/acme/shop/pull/9",
      }),
      expect.objectContaining({
        action: "merge_request.labels.failed",
        provider: "github",
        repository: "acme/shop",
        stage: "labels",
        statusCode: 422,
      }),
    ])
  })

  it("returns the created PR URL and audits label transport failures when labels fail after creation", async () => {
    // Given: GitHub creates the PR but the labels request loses transport after creation.
    const server = await startGitHubServer([createSuccessResponse(11)])
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createGitHubPullRequestProvider({
      audit: (event) => {
        auditEvents.push(event)
        if (event.action === "merge_request.create.succeeded") {
          servers.pop()
          void server.close()
        }
      },
      baseUrl: server.baseUrl,
      owner: "acme",
      repo: "shop",
      token: "github_pat_secret_example",
    })

    // When: the provider creates a PR but cannot reach the labels API.
    const result = await provider.createMergeRequest(createInput({ labels: ["incident"] }))

    // Then: label transport failure is non-fatal so the workflow can persist the PR URL.
    expect(result.url).toBe("https://github.example/acme/shop/pull/11")
    expect(auditEvents.at(-1)).toMatchObject({
      action: "merge_request.labels.failed",
      kind: "transport",
      statusCode: undefined,
    })
    expectSafeAudit(auditEvents)
  })

  it.each([
    { body: { html_url: 42, number: 10 }, label: "malformed html_url" },
    {
      body: { html_url: "https://github.example/acme/shop/pull/10", number: 0 },
      label: "invalid number",
    },
    { body: { html_url: "https://github.example/acme/shop/pull/10" }, label: "missing number" },
  ] as const)("maps $label success responses to a typed parse error", async (testCase) => {
    // Given: GitHub returns HTTP 201 with a malformed PR response payload.
    const server = await startGitHubServer([{ body: testCase.body, statusCode: 201 }])
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createProvider(server, auditEvents)

    // When / Then: the boundary parser rejects malformed response data.
    await expect(provider.createMergeRequest(createInput())).rejects.toMatchObject({
      name: "GitHubPullRequestParseError",
      statusCode: 201,
    })
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "merge_request.create.requested" }),
      expect.objectContaining({
        action: "merge_request.create.failed",
        kind: "parse",
        provider: "github",
        repository: "acme/shop",
        stage: "create",
        statusCode: 201,
      }),
    ])
  })
})
