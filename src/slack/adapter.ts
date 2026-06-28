import { App } from "@slack/bolt"

import type { SlackActionIntent } from "./action-payload.js"
import { parseSlackActionPayload } from "./action-payload.js"
import {
  type AnalysisCompleteMessageInput,
  buildAnalysisCompleteMessage,
  buildInitialIncidentMessage,
  type InitialIncidentMessageInput,
  type SlackRenderedMessage,
} from "./block-kit.js"

export type SlackPostMessageRequest = {
  readonly channel: string
  readonly thread_ts: string
  readonly text: string
  readonly blocks: SlackRenderedMessage["blocks"]
}

export type SlackPostMessageResult = {
  readonly ts?: string
}

export interface SlackClient {
  readonly postMessage: (message: SlackPostMessageRequest) => Promise<SlackPostMessageResult>
}

export interface SlackChatAdapter {
  readonly postInitialIncident: (
    input: InitialIncidentMessageInput,
  ) => Promise<SlackPostMessageResult>
  readonly postAnalysisComplete: (
    input: AnalysisCompleteMessageInput,
  ) => Promise<SlackPostMessageResult>
}

export type SlackActionDispatcher = (intent: SlackActionIntent) => void | Promise<void>

export type SlackAck = () => void | Promise<void>

export type SlackBlockActionHandlingInput = {
  readonly payload: unknown
  readonly ack: SlackAck
  readonly dispatch: SlackActionDispatcher
}

const toPostMessageRequest = (message: SlackRenderedMessage): SlackPostMessageRequest => ({
  channel: message.channel,
  thread_ts: message.threadTs,
  text: message.text,
  blocks: message.blocks,
})

export const createSlackChatAdapter = (client: SlackClient): SlackChatAdapter => ({
  postInitialIncident: (input) =>
    client.postMessage(toPostMessageRequest(buildInitialIncidentMessage(input))),
  postAnalysisComplete: (input) =>
    client.postMessage(toPostMessageRequest(buildAnalysisCompleteMessage(input))),
})

export const handleSlackBlockAction = async (
  input: SlackBlockActionHandlingInput,
): Promise<SlackActionIntent> => {
  await input.ack()
  const intent = parseSlackActionPayload(input.payload)
  await input.dispatch(intent)
  return intent
}

export type SlackSocketModeOptions = {
  readonly botToken: string
  readonly appToken: string
  readonly dispatch: SlackActionDispatcher
}

export type SlackSocketModeAdapter = {
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void> | void
}

export const createSlackSocketModeAdapter = (
  options: SlackSocketModeOptions,
): SlackSocketModeAdapter => {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
  })

  app.action(/^incident\./, async ({ ack, body }) => {
    await handleSlackBlockAction({
      payload: body,
      ack,
      dispatch: options.dispatch,
    })
  })

  return {
    start: async () => {
      await app.start()
    },
    stop: async () => {
      await app.stop()
    },
  }
}
