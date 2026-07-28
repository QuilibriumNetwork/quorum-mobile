// expo-sqlite replacement for Node, backed by node:sqlite (built in on Node 22).
//
// Mobile's message store (services/storage/messagesDb.ts) uses only the
// SYNCHRONOUS half of expo-sqlite's surface, which maps almost one-to-one onto
// node:sqlite. The mapped surface was grepped from that file, not guessed:
//
//   openDatabaseSync / deleteDatabaseSync
//   db.execSync / runSync / getAllSync / getFirstSync / prepareSync /
//   withTransactionSync
//   stmt.executeSync / finalizeSync
//
// ⚠️ SQLCipher is NOT emulated. messagesDb opens with `PRAGMA key = "x'...'"`
// for encryption at rest; node:sqlite has no such pragma and would throw. Key
// pragmas are swallowed, so the harness DB is PLAINTEXT. Two consequences:
//   - encryption-at-rest bugs are invisible here and stay device-only
//   - harness DB files must never hold real user data (they are in-memory by
//     default below, which enforces it)
//
// Databases are in-memory unless HARNESS_SQLITE_DIR is set. In-memory is the
// default deliberately: a run should not leave message databases on the
// developer's machine, and every scenario should start from a known-empty store.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

type Params = unknown[];

/** Swallow SQLCipher pragmas node:sqlite cannot honour. See header. */
function isCipherPragma(sql: string): boolean {
  return /^\s*PRAGMA\s+(key|cipher|rekey)/i.test(sql);
}

export interface SQLiteStatement {
  executeSync(...params: Params): unknown;
  finalizeSync(): void;
}

export interface SQLiteDatabase {
  execSync(sql: string): void;
  runSync(sql: string, params?: Params): { changes: number; lastInsertRowId: number };
  getAllSync<T = unknown>(sql: string, params?: Params): T[];
  getFirstSync<T = unknown>(sql: string, params?: Params): T | null;
  prepareSync(sql: string): SQLiteStatement;
  withTransactionSync(fn: () => void): void;
  closeSync(): void;
}

const open = new Map<string, DatabaseSync>();

function location(name: string): string {
  const dir = process.env.HARNESS_SQLITE_DIR;
  return dir ? resolve(dir, name) : ':memory:';
}

export function openDatabaseSync(name: string): SQLiteDatabase {
  let db = open.get(name);
  if (!db) {
    db = new DatabaseSync(location(name));
    open.set(name, db);
  }
  const handle = db;

  return {
    execSync: (sql) => {
      // expo's execSync accepts multiple statements; so does node:sqlite's exec.
      if (isCipherPragma(sql)) return;
      handle.exec(sql);
    },
    runSync: (sql, params = []) => {
      const r = handle.prepare(sql).run(...(params as never[]));
      return {
        changes: Number(r.changes),
        lastInsertRowId: Number(r.lastInsertRowid),
      };
    },
    getAllSync: <T,>(sql: string, params: Params = []) =>
      handle.prepare(sql).all(...(params as never[])) as T[],
    getFirstSync: <T,>(sql: string, params: Params = []) =>
      (handle.prepare(sql).get(...(params as never[])) as T) ?? null,
    prepareSync: (sql) => {
      const stmt = handle.prepare(sql);
      return {
        executeSync: (...params: Params) => stmt.run(...(params as never[])),
        // node:sqlite statements are GC-managed and have no finalize; the no-op
        // keeps mobile's try/finally cleanup working unchanged.
        finalizeSync: () => {},
      };
    },
    // expo's withTransactionSync rolls back if the callback throws. node:sqlite
    // has no wrapper, so drive the transaction explicitly — without the rollback
    // a failed migration would leave half-written rows, which is exactly the
    // durability property messagesDb's migration relies on.
    withTransactionSync: (fn) => {
      handle.exec('BEGIN');
      try {
        fn();
        handle.exec('COMMIT');
      } catch (err) {
        handle.exec('ROLLBACK');
        throw err;
      }
    },
    closeSync: () => {
      handle.close();
      open.delete(name);
    },
  };
}

export function deleteDatabaseSync(name: string): void {
  const db = open.get(name);
  if (db) {
    db.close();
    open.delete(name);
  }
}

/** Test helper — close and drop every database. Not part of the real API. */
export function __resetAllDatabases(): void {
  for (const [, db] of open) db.close();
  open.clear();
}

export default { openDatabaseSync, deleteDatabaseSync };
