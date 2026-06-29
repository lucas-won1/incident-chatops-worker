import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { z } from "zod"

export type RecordedGitHubRequest = {
  readonly body: unknown
  readonly headers: {
    readonly accept: string | undefined
    readonly authorization: string | undefined
    readonly "content-type": string | undefined
    readonly "x-github-api-version": string | undefined
  }
  readonly method: string | undefined
  readonly url: string | undefined
}

export type GitHubResponse = {
  readonly body: unknown
  readonly statusCode: number
}

export type GitHubTestServer = {
  readonly baseUrl: string
  readonly close: () => Promise<void>
  readonly requests: readonly RecordedGitHubRequest[]
}

export const pullRequestBodySchema = z.object({
  base: z.string(),
  body: z.string(),
  draft: z.boolean(),
  head: z.string(),
  title: z.string(),
})

export const labelsBodySchema = z.object({
  labels: z.array(z.string()),
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

const recordRequest = (request: IncomingMessage, body: unknown): RecordedGitHubRequest => ({
  body,
  headers: {
    accept: singleHeader(request.headers.accept),
    authorization: singleHeader(request.headers.authorization),
    "content-type": singleHeader(request.headers["content-type"]),
    "x-github-api-version": singleHeader(request.headers["x-github-api-version"]),
  },
  method: request.method,
  url: request.url,
})

export const startGitHubServer = async (
  responses: readonly GitHubResponse[],
): Promise<GitHubTestServer> => {
  const requests: RecordedGitHubRequest[] = []
  const queuedResponses: GitHubResponse[] = [...responses]
  const server = createServer((request, response) => {
    readJsonBody(request)
      .then((requestBody) => {
        requests.push(recordRequest(request, requestBody))
        const nextResponse = queuedResponses.shift() ?? {
          body: { message: "unexpected request" },
          statusCode: 500,
        }
        writeJson(response, nextResponse.statusCode, nextResponse.body)
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
    throw new Error("GitHub test server address unavailable")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
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

export const createSuccessResponse = (number: number): GitHubResponse => ({
  body: {
    html_url: `https://github.example/acme/shop/pull/${number}`,
    number,
  },
  statusCode: 201,
})
