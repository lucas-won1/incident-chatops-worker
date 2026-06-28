import type { Database, SqlValue } from "sql.js"

import { StateStoreDataError } from "./errors.js"

export type SqlRow = ReadonlyMap<string, SqlValue>

export type SqlParams = Record<string, SqlValue>

export const selectRows = (
  db: Database,
  sql: string,
  params: SqlParams = {},
): readonly SqlRow[] => {
  const results = db.exec(sql, params)
  const [result] = results
  if (result === undefined) {
    return []
  }

  return result.values.map((values) => {
    const row = new Map<string, SqlValue>()
    result.columns.forEach((column, index) => {
      const value = values[index]
      if (value === undefined) {
        throw new StateStoreDataError(`Missing SQLite column value: ${column}`)
      }
      row.set(column, value)
    })
    return row
  })
}

export const selectOne = (db: Database, sql: string, params: SqlParams = {}): SqlRow | undefined =>
  selectRows(db, sql, params)[0]

export const requiredString = (row: SqlRow, column: string): string => {
  const value = row.get(column)
  if (typeof value === "string") {
    return value
  }

  throw new StateStoreDataError(`Expected SQLite text column: ${column}`)
}

export const requiredNumber = (row: SqlRow, column: string): number => {
  const value = row.get(column)
  if (typeof value === "number") {
    return value
  }

  throw new StateStoreDataError(`Expected SQLite numeric column: ${column}`)
}

export const nullableString = (row: SqlRow, column: string): string | null => {
  const value = row.get(column)
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === "string") {
    return value
  }

  throw new StateStoreDataError(`Expected nullable SQLite text column: ${column}`)
}
