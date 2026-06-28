import ky, { type KyInstance } from "ky"

export type SentryHttpClientOptions = {
  readonly authToken: string
  readonly baseUrl: string
}

export const createSentryHttpClient = (options: SentryHttpClientOptions): KyInstance =>
  ky.create({
    headers: {
      authorization: `Bearer ${options.authToken}`,
    },
    prefix: options.baseUrl.replace(/\/$/u, ""),
    retry: {
      limit: 0,
    },
    throwHttpErrors: false,
    timeout: 10000,
  })
