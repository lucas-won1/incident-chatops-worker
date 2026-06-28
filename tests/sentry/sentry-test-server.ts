import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export type TestServer = {
  readonly baseUrl: string
  readonly detailFetches: () => number
  readonly close: () => Promise<void>
}

export const json = (response: ServerResponse, body: unknown, headers = {}): void => {
  response.writeHead(200, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

export const startSentryServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> => {
  let detailFetches = 0
  const server = createServer((request, response) => {
    if (request.url?.includes("/events/") === true) {
      detailFetches += 1
    }
    handler(request, response)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("test server address unavailable")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/0`,
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
    detailFetches: () => detailFetches,
  }
}
