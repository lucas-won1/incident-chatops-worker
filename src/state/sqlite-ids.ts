import { randomUUID } from "node:crypto"

export const makeSqliteId = (prefix: string): string => `${prefix}_${randomUUID()}`
