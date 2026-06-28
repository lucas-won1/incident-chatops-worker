import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openSqliteStateStore } from "../../src/state/sqlite-store.js"

const tempDirs: string[] = []

const createTempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "incident-state-mode-"))
  tempDirs.push(dir)
  return join(dir, "state.sqlite")
}

const fileMode = (path: string): number => statSync(path).mode & 0o777

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("SQLite state file permissions", () => {
  it("creates and reopens state database files with owner-only mode", () => {
    // Given: a new state database path.
    const dbPath = createTempDbPath()

    // When: the state store creates and later reopens the SQLite file.
    const created = openSqliteStateStore({ path: dbPath })
    created.close()
    const modeAfterCreate = fileMode(dbPath)
    const reopened = openSqliteStateStore({ path: dbPath })
    reopened.close()

    // Then: both saves keep the file owner-only.
    expect(modeAfterCreate).toBe(0o600)
    expect(fileMode(dbPath)).toBe(0o600)
  })

  it("repairs an existing state database file that is group-readable", () => {
    // Given: an existing database file with overly broad permissions.
    const dbPath = createTempDbPath()
    const created = openSqliteStateStore({ path: dbPath })
    created.close()
    chmodSync(dbPath, 0o644)

    // When: the state store opens the existing file.
    const reopened = openSqliteStateStore({ path: dbPath })
    reopened.close()

    // Then: the file mode is repaired to owner-only.
    expect(fileMode(dbPath)).toBe(0o600)
  })
})
