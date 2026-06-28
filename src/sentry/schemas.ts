import { z } from "zod"

export const sentryIssueSchema = z.object({
  culprit: z.string().optional(),
  firstSeen: z.string().datetime(),
  id: z.string().min(1),
  lastSeen: z.string().datetime(),
  permalink: z.url(),
  project: z.object({
    slug: z.string().min(1),
  }),
  shortId: z.string().optional(),
  status: z.string().min(1),
  title: z.string().min(1),
})

export const sentryIssuePageSchema = z.array(sentryIssueSchema)

export const sentryIssueEventSchema = z
  .object({
    dateCreated: z.string().datetime(),
    eventID: z.string().min(1),
    message: z.string().default(""),
    title: z.string().default(""),
  })
  .passthrough()

export const sentryIssueEventsSchema = z.array(sentryIssueEventSchema)

export type SentryIssue = z.infer<typeof sentryIssueSchema>
export type SentryIssueEvent = z.infer<typeof sentryIssueEventSchema>
