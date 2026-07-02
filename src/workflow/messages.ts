import { slackChannelId, slackThreadTs } from "../domain/ids.js"
import { redactAndTruncate, redactSensitiveText } from "../shared/redaction.js"
import type { SlackRenderedMessage } from "../slack/block-kit.js"

type WorkflowMessageInput = {
  readonly channelId: string
  readonly threadTs: string
  readonly text: string
}

const sectionMessage = (input: WorkflowMessageInput): SlackRenderedMessage => ({
  channel: slackChannelId(input.channelId),
  threadTs: slackThreadTs(input.threadTs),
  text: redactAndTruncate(input.text, 180),
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: redactAndTruncate(input.text, 2500),
      },
    },
  ],
})

export const buildWorkflowStatusMessage = (
  channelId: string,
  threadTs: string,
  text: string,
): SlackRenderedMessage => sectionMessage({ channelId, threadTs, text })

export const safeErrorText = (
  prefix: string,
  error: unknown,
  secretValues: readonly string[] = [],
): string => {
  if (error instanceof Error) {
    return `${prefix}: ${redactSensitiveText(error.message, secretValues)}`
  }
  return `${prefix}: unknown failure`
}
