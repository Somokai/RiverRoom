import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { NodeFS } from '@electric-sql/pglite/nodefs';
import pg from 'pg';

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const schema = `
CREATE TABLE IF NOT EXISTS rr_users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, recovery_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS rr_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES rr_users(id),
  csrf TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rr_sessions_user ON rr_sessions(user_id);
CREATE TABLE IF NOT EXISTS rr_rooms (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, state JSONB NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS rr_members (
  room_id TEXT NOT NULL REFERENCES rr_rooms(id), user_id TEXT NOT NULL,
  PRIMARY KEY(room_id, user_id)
);
CREATE INDEX IF NOT EXISTS rr_members_user ON rr_members(user_id);
CREATE TABLE IF NOT EXISTS rr_commands (
  room_id TEXT NOT NULL REFERENCES rr_rooms(id), actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL, digest TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(room_id, actor_id, command_id)
);
CREATE TABLE IF NOT EXISTS rr_audit (
  room_id TEXT NOT NULL REFERENCES rr_rooms(id), seq INTEGER NOT NULL,
  at TIMESTAMPTZ NOT NULL, actor_id TEXT NOT NULL, command TEXT NOT NULL,
  payload JSONB NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(room_id, seq)
);
CREATE TABLE IF NOT EXISTS rr_ledger (
  id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rr_rooms(id),
  transaction_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, entry JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS rr_ledger_room ON rr_ledger(room_id, id);
CREATE TABLE IF NOT EXISTS rr_hands (
  room_id TEXT NOT NULL REFERENCES rr_rooms(id), hand_id TEXT NOT NULL,
  hand_number INTEGER NOT NULL, summary JSONB NOT NULL,
  PRIMARY KEY(room_id, hand_id)
);
CREATE INDEX IF NOT EXISTS rr_hands_room ON rr_hands(room_id, hand_number);
CREATE TABLE IF NOT EXISTS rr_player_hand_stats (
  room_id TEXT NOT NULL REFERENCES rr_rooms(id), hand_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES rr_users(id),
  game TEXT NOT NULL CHECK (game IN ('holdem','omaha','omaha_bomb','indian')),
  started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
  preflop_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
  vpip BOOLEAN NOT NULL DEFAULT FALSE, pfr BOOLEAN NOT NULL DEFAULT FALSE,
  postflop_bets_raises INTEGER NOT NULL DEFAULT 0 CHECK (postflop_bets_raises >= 0),
  postflop_calls INTEGER NOT NULL DEFAULT 0 CHECK (postflop_calls >= 0),
  saw_flop BOOLEAN NOT NULL DEFAULT FALSE, showdown BOOLEAN NOT NULL DEFAULT FALSE,
  showdown_won BOOLEAN NOT NULL DEFAULT FALSE, hand_won BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(room_id, hand_id, user_id),
  CHECK (NOT pfr OR vpip), CHECK (NOT vpip OR preflop_opportunity),
  CHECK (NOT showdown_won OR showdown), CHECK (NOT showdown OR saw_flop)
);
CREATE INDEX IF NOT EXISTS rr_player_hand_stats_user ON rr_player_hand_stats(user_id, game)
  WHERE completed_at IS NOT NULL;
CREATE OR REPLACE FUNCTION rr_protect_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'River Room history is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rr_audit_immutable ON rr_audit;
CREATE TRIGGER rr_audit_immutable BEFORE UPDATE OR DELETE ON rr_audit
  FOR EACH ROW EXECUTE FUNCTION rr_protect_history();
DROP TRIGGER IF EXISTS rr_ledger_immutable ON rr_ledger;
CREATE TRIGGER rr_ledger_immutable BEFORE UPDATE OR DELETE ON rr_ledger
  FOR EACH ROW EXECUTE FUNCTION rr_protect_history();
DROP TRIGGER IF EXISTS rr_hands_immutable ON rr_hands;
CREATE TRIGGER rr_hands_immutable BEFORE UPDATE OR DELETE ON rr_hands
  FOR EACH ROW EXECUTE FUNCTION rr_protect_history();
`;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const lockAttempts = 40;
const waitForLock = (attempt: number) => delay(Math.min(10 * (attempt + 1), 50));
const windowsLockRace = (error: unknown) =>
  process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '');

async function removeOwnedLock(
  directory: string, owner: string,
  { attempts = lockAttempts, allowEmpty = false }: { attempts?: number; allowEmpty?: boolean } = {},
) {
  let removedOwner = allowEmpty;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const names = await readdir(directory);
      if (names.length) {
        if (names.length !== 1 || names[0] !== owner) return;
        await unlink(join(directory, owner));
        removedOwner = true;
      } else if (!removedOwner) return;
      await rmdir(directory);
      return;
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) return;
      if (!windowsLockRace(error) || attempts === 1) throw error;
      lastError = error;
      if (attempt + 1 < attempts) await waitForLock(attempt);
    }
  }
  throw new Error(`Could not release owned local database lock "${directory}" after bounded retries (${errorCode(lastError)}). Check DATA_DIR permissions and retry; no replacement owner's files were removed.`, { cause: lastError });
}

async function lockDirectory(path: string): Promise<() => Promise<void>> {
  const directory = `${path}.river-room.lock`;
  const token = randomUUID();
  const owner = `owner-${process.pid}-${token}.json`;
  const candidate = `${directory}.${process.pid}-${token}`;
  await mkdir(candidate);
  try {
    await writeFile(join(candidate, owner), JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx' });
    let lastError: unknown;
    for (let attempt = 0; attempt < lockAttempts; attempt++) {
      try {
        // Publish a populated directory atomically: no incomplete owner record is ever a live lock.
        await rename(candidate, directory);
        return () => removeOwnedLock(directory, owner);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '') && !windowsLockRace(error)) throw error;
        lastError = error;
      }
      try {
        const names = await readdir(directory);
        if (!names.length) {
          await rmdir(directory);
        } else {
          const name = names[0]!;
          const match = /^owner-([1-9]\d*)-[0-9a-f-]{36}\.json$/.exec(name);
          if (names.length !== 1 || !match) {
            throw new Error(`Cannot verify the owner of local database lock "${directory}". Do not delete it while River Room may be running.`);
          }
          const text = await readFile(join(directory, name), 'utf8');
          let record: { pid?: unknown; host?: unknown };
          try { record = JSON.parse(text) as typeof record; }
          catch (error) {
            throw new Error(`Cannot verify the local database lock "${directory}". Do not delete it while River Room may be running.`, { cause: error });
          }
          const pid = Number(match[1]);
          if (!Number.isSafeInteger(pid) || !record || record.pid !== pid || record.host !== hostname()) {
            throw new Error(`Cannot verify the owner of local database lock "${directory}". Check that DATA_DIR is local and that no other River Room instance uses it; use a different empty DATA_DIR if needed.`);
          }
          let alive = true;
          try { process.kill(pid, 0); }
          catch (error) {
            if (errorCode(error) === 'ESRCH') alive = false;
            else if (errorCode(error) !== 'EPERM') throw error;
          }
          if (alive) {
            throw new Error(`Local database "${path}" is already in use by process ${pid}, or that PID has been reused. Verify and stop the original River Room instance first, or use a different DATA_DIR. Changing PORT alone does not isolate stored data.`);
          }
          // A failed reclamation returns to the full owner/liveness check, never a blind unlink retry.
          await removeOwnedLock(directory, name, { attempts: 1 });
        }
      } catch (error) {
        // Windows can deny access briefly while another contender removes or replaces the directory.
        // Reread its exact filename, record and PID after a bounded wait before attempting any mutation.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '') && !windowsLockRace(error)) throw error;
        lastError = error;
      }
      if (attempt + 1 < lockAttempts) await waitForLock(attempt);
    }
    throw new Error(`Could not acquire local database lock "${directory}" after bounded retries (${errorCode(lastError)}). Wait for the other launch to finish and check DATA_DIR permissions before retrying. Do not delete a live or unverified owner's lock.`, { cause: lastError });
  } catch (error) {
    await removeOwnedLock(candidate, owner, { allowEmpty: true });
    throw error;
  }
}

export async function openDatabase(options: { url?: string; directory?: string; ssl?: boolean }): Promise<Database> {
  if (options.url !== undefined && options.url !== '') {
    if (!options.url.trim()) throw new Error('DATABASE_URL must be a valid PostgreSQL URL, or explicitly empty for local storage; whitespace-only values are not valid.');
    let connection: URL;
    try { connection = new URL(options.url); }
    catch (error) {
      if (error instanceof TypeError) throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
      throw error;
    }
    if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
    if (['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some(key => connection.searchParams.has(key)))
      throw new Error('Configure TLS with DATABASE_SSL, not SSL parameters inside DATABASE_URL; connection-string SSL options can override certificate verification.');
    const pool = new pg.Pool({
      connectionString: connection.toString(),
      ssl: options.ssl ? { rejectUnauthorized: true } : false,
      max: 8, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000,
    });
    pool.on('error', error => console.error('Database connection error:', error.message));
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(743201)');
        await client.query(schema);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        ({ rows: (await pool.query<T>(sql, params)).rows }),
      transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          const result = await fn({ query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
            ({ rows: (await connection.query<R>(sql, params)).rows }) });
          await connection.query('COMMIT');
          return result;
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
      },
      close: () => pool.end(),
    };
  }
  if (options.directory !== undefined && !options.directory.trim()) throw new Error('DATA_DIR must be a directory path, or :memory: for explicitly nonpersistent development.');
  let path = options.directory === ':memory:' ? undefined : resolve(options.directory ?? '.data/postgres');
  let release: (() => Promise<void>) | undefined;
  let fs: NodeFS | undefined;
  let db: PGlite | undefined;
  try {
    if (path) {
      await mkdir(path, { recursive: true });
      path = await realpath(path);
      release = await lockDirectory(path);
      const files = await readdir(path);
      if (files.length && !files.includes('PG_VERSION')) {
        throw new Error('DATA_DIR contains files but no PG_VERSION. Refusing to initialize over existing or damaged data. Verify the directory or restore a backup; use an empty directory for a new database.');
      }
      fs = new NodeFS(path);
    }
    db = new PGlite(fs ? { fs } : undefined);
    await db.waitReady;
    await db.transaction(async tx => { await tx.exec(schema); });
  } catch (error) {
    try {
      if (db?.ready) await db.close();
      else if (fs) await fs.closeFs();
    } catch (cleanupError) {
      console.error('Local database initialization cleanup failed:', cleanupError instanceof Error ? cleanupError.message : 'unknown error');
    } finally { await release?.(); }
    throw new Error(`Unable to open ${path ? `local database "${path}"` : 'in-memory database'}: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
  }
  const local = db;
  let closing: Promise<void> | undefined;
  return {
    query: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => local.query<T>(sql, params),
    transaction: fn => local.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    close: () => closing ??= (async () => { await local.close(); await release?.(); })(),
  };
}
