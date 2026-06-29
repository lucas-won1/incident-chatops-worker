import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createGitLabMergeRequestProvider,
  type GitLabMergeRequestApiError,
  GitLabMergeRequestParseError,
  type MergeRequestAuditEvent,
} from "../../src/mr/index.js"

type RecordedRequest = {
  readonly body: unknown
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly method: string | undefined
  readonly url: string | undefined
}

type GitLabTestServer = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
  readonly requests: readonly RecordedRequest[]
}

const mergeRequestBodySchema = z.object({
  description: z.string(),
  labels: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  title: z.string(),
})

const readJsonBody = async (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on("error", reject)
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
  })

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const singleHeader = (value: string | readonly string[] | undefined): string | undefined => {
  return typeof value === "string" ? value : value?.[0]
}

const startGitLabServer = async (statusCode: number, body: unknown): Promise<GitLabTestServer> => {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    readJsonBody(request)
      .then((requestBody) => {
        requests.push({
          body: requestBody,
          headers: {
            "content-type": singleHeader(request.headers["content-type"]),
            "private-token": singleHeader(request.headers["private-token"]),
          },
          method: request.method,
          url: request.url,
        })
        writeJson(response, statusCode, body)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown request parse failure"
        writeJson(response, 400, { message })
      })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("GitLab test server address unavailable")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v4`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error instanceof Error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
    requests,
  }
}

const servers: GitLabTestServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
})

describe("GitLab merge request provider", () => {
  it("creates a draft merge request with a title prefix and no unsupported draft body field", async () => {
    // Given: a GitLab API fake and a provider configured with an env-sourced token.
    const server = await startGitLabServer(201, {
      web_url: "https://gitlab.example/acme/shop/-/merge_requests/42",
    })
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createGitLabMergeRequestProvider({
      audit: (event) => {
        auditEvents.push(event)
      },
      baseUrl: server.baseUrl,
      project: "acme/shop",
      token: "glpat-secret-example",
    })

    // When: the provider creates an MR for a pushed incident branch.
    const result = await provider.createMergeRequest({
      bodyTemplate: "Incident fix body for {sourceBranch} into {targetBranch}.",
      draft: true,
      labels: ["incident", "automated"],
      sourceBranch: "incident/demo",
      targetBranch: "main",
      titleTemplate: "Fix {sourceBranch}",
    })

    // Then: the request matches the GitLab MR contract and returns the MR URL only.
    expect(result.url).toBe("https://gitlab.example/acme/shop/-/merge_requests/42")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.method).toBe("POST")
    expect(server.requests[0]?.url).toBe("/api/v4/projects/acme%2Fshop/merge_requests")
    expect(server.requests[0]?.headers["private-token"]).toBe("glpat-secret-example")
    expect(mergeRequestBodySchema.parse(server.requests[0]?.body)).toEqual({
      description: "Incident fix body for incident/demo into main.",
      labels: "incident,automated",
      source_branch: "incident/demo",
      target_branch: "main",
      title: "Draft: Fix incident/demo",
    })
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain('"draft"')
    expect(JSON.stringify(auditEvents)).not.toContain("glpat-secret-example")
    expect(JSON.stringify(auditEvents)).not.toContain("private-token")
  })

  it("keeps an existing GitLab draft title prefix instead of duplicating it", async () => {
    // Given: the title template already encodes GitLab's documented draft marker.
    const server = await startGitLabServer(201, {
      web_url: "https://gitlab.example/acme/shop/-/merge_requests/43",
    })
    servers.push(server)
    const provider = createGitLabMergeRequestProvider({
      baseUrl: server.baseUrl,
      project: "acme/shop",
      token: "glpat-secret-example",
    })

    // When: the provider creates a draft MR from a prefixed template.
    await provider.createMergeRequest({
      bodyTemplate: "body",
      draft: true,
      labels: [],
      sourceBranch: "incident/demo",
      targetBranch: "main",
      titleTemplate: "[Draft] Fix {sourceBranch}",
    })

    // Then: the existing marker is retained and no duplicate marker is added.
    expect(mergeRequestBodySchema.parse(server.requests[0]?.body).title).toBe(
      "[Draft] Fix incident/demo",
    )
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain('"draft"')
  })

  it("exposes GitLab provider identity and repository-safe audit metadata", async () => {
    // Given: a GitLab provider with audit capture enabled.
    const server = await startGitLabServer(201, {
      web_url: "https://gitlab.example/acme/shop/-/merge_requests/42",
    })
    servers.push(server)
    const auditEvents: MergeRequestAuditEvent[] = []
    const provider = createGitLabMergeRequestProvider({
      audit: (event) => {
        auditEvents.push(event)
      },
      baseUrl: server.baseUrl,
      project: "acme/shop",
      token: "glpat-secret-example",
    })

    // When: the provider creates an MR.
    await provider.createMergeRequest({
      bodyTemplate: "body",
      draft: true,
      labels: ["incident"],
      sourceBranch: "incident/demo",
      targetBranch: "main",
      titleTemplate: "title",
    })

    // Then: provider and repository identity are explicit while token/header details stay out of audit.
    expect(provider.provider).toBe("gitlab")
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "merge_request.create.requested",
        provider: "gitlab",
        repository: "acme/shop",
      }),
      expect.objectContaining({
        action: "merge_request.create.succeeded",
        provider: "gitlab",
        repository: "acme/shop",
      }),
    ])
    expect(JSON.stringify(auditEvents)).not.toContain("glpat-secret-example")
    expect(JSON.stringify(auditEvents)).not.toContain("private-token")
  })

  it.each([
    { expectedKind: "authentication", statusCode: 401 },
    { expectedKind: "not_found", statusCode: 404 },
    { expectedKind: "conflict", statusCode: 409 },
    { expectedKind: "server", statusCode: 500 },
  ] as const)("maps HTTP $statusCode to a typed $expectedKind error", async (testCase) => {
    // Given: GitLab rejects MR creation with a known HTTP error class.
    const server = await startGitLabServer(testCase.statusCode, { message: "rejected" })
    servers.push(server)
    const provider = createGitLabMergeRequestProvider({
      baseUrl: server.baseUrl,
      project: "acme/shop",
      token: "glpat-secret-example",
    })

    // When / Then: the provider fails with a typed API error and status code.
    await expect(
      provider.createMergeRequest({
        bodyTemplate: "body",
        draft: false,
        labels: [],
        sourceBranch: "incident/demo",
        targetBranch: "main",
        titleTemplate: "title",
      }),
    ).rejects.toMatchObject({
      kind: testCase.expectedKind,
      statusCode: testCase.statusCode,
    } satisfies Partial<GitLabMergeRequestApiError>)
  })

  it("maps malformed success responses to a typed parse error", async () => {
    // Given: GitLab returns a success status with a malformed response body.
    const server = await startGitLabServer(201, { web_url: 42 })
    servers.push(server)
    const provider = createGitLabMergeRequestProvider({
      baseUrl: server.baseUrl,
      project: "acme/shop",
      token: "glpat-secret-example",
    })

    // When / Then: the boundary parser rejects the malformed response.
    await expect(
      provider.createMergeRequest({
        bodyTemplate: "body",
        draft: false,
        labels: [],
        sourceBranch: "incident/demo",
        targetBranch: "main",
        titleTemplate: "title",
      }),
    ).rejects.toBeInstanceOf(GitLabMergeRequestParseError)
  })
})
