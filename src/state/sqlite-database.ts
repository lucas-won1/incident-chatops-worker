import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import initSqlJs, { type Database } from "sql.js"

import { StateStoreOpenError } from "./errors.js"

const SQL = await initSqlJs()
const ownerOnlyDatabaseMode = 0o600
type DatabaseAccessMode = "read" | "write"

const repairDatabaseMode = (path: string): void => {
  try {
    chmodSync(path, ownerOnlyDatabaseMode)
  } catch (error) {
    if (error instanceof Error) {
      throw new StateStoreOpenError(path, error.message)
    }
    throw error
  }
}

export const readDatabaseBytes = (
  path: string,
  createIfMissing: boolean,
  accessMode: DatabaseAccessMode,
): Uint8Array | undefined => {
  if (!existsSync(path)) {
    if (createIfMissing) {
      return undefined
    }
    throw new StateStoreOpenError(path, `SQLite database does not exist: ${path}`)
  }

  try {
    if (accessMode === "write") {
      repairDatabaseMode(path)
    }
    return readFileSync(path)
  } catch (error) {
    if (error instanceof Error) {
      throw new StateStoreOpenError(path, error.message)
    }
    throw error
  }
}

export const openDatabase = (
  path: string,
  createIfMissing: boolean,
  accessMode: DatabaseAccessMode = "write",
): Database => {
  const bytes = readDatabaseBytes(path, createIfMissing, accessMode)
  return bytes === undefined ? new SQL.Database() : new SQL.Database(bytes)
}

export const persistDatabase = (db: Database, path: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(db.export()), { mode: ownerOnlyDatabaseMode })
  repairDatabaseMode(path)
}

export const transaction = <Result>(
  db: Database,
  path: string,
  operation: () => Result,
): Result => {
  db.run("BEGIN IMMEDIATE")
  try {
    const result = operation()
    db.run("COMMIT")
    persistDatabase(db, path)
    return result
  } catch (error) {
    db.run("ROLLBACK")
    throw error
  }
}
