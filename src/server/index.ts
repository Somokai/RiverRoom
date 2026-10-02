import { resolve } from 'node:path';
import { openDatabase, type Database } from './database.js';
import { Store } from './store.js';
import { makeApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
const supervisedInput = process.env.RIVER_ROOM_PARENT_STDIN === '1';
let db: Database | undefined;
let server: Awaited<ReturnType<typeof makeApp>> | undefined;
let stopping = false;
let shutdownTask: Promise<void> | undefined;
let startupTask: Promise<void>;

function reportFailure(error: unknown) {
  process.exitCode = 1;
  console.error(`River Room failed: ${error instanceof Error ? error.message : String(error)}`);
}

function listenError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') return new Error(`Port ${port} on ${host} is already in use. Stop the existing listener or choose another port with Start-Local.ps1 -Port <port> (or PORT). The existing listener was not stopped.`, { cause: error });
  if (code === 'EACCES') return new Error(`Permission denied listening on ${host}:${port}. Choose another PORT or check the local networking policy.`, { cause: error });
  return error;
}

function shutdown(): Promise<void> {
  stopping = true;
  return shutdownTask ??= (async () => {
    const timeout = setTimeout(() => {
      console.error('River Room shutdown exceeded 15 seconds. Exiting with an error; the next launch will recover the local database lock.');
      process.exit(1);
    }, 15000);
    try {
      // A stop during initialization must not let that initialization later start an orphan listener.
      await startupTask;
      try { await server?.close(); }
      catch (error) { reportFailure(error); }
      try { await db?.close(); }
      catch (error) { reportFailure(error); }
      if (process.connected) process.disconnect();
      if (supervisedInput) process.stdin.destroy();
    } finally { clearTimeout(timeout); }
  })();
}

const stop = () => { void shutdown(); };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);
if (process.platform === 'win32') process.on('SIGBREAK', stop);
const fatal = (error: unknown) => { reportFailure(error); void shutdown(); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
if (supervisedInput) {
  process.stdin.on('error', fatal);
  process.stdin.once('end', stop);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) stopping = true;
}
if (process.send) {
  // Parent-only IPC also permits graceful shutdown on Windows, where child.kill() is forceful.
  process.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message &&
        (message.type === 'river-room:shutdown' || message.type === 'shutdown')) stop();
  });
  process.on('disconnect', stop);
  if (!process.connected) stopping = true;
}

async function start() {
  if (stopping) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (production && (!process.env.DATABASE_URL || !process.env.HOST_KEY || process.env.HOST_KEY.length < 24 ||
      !process.env.APP_ORIGIN?.startsWith('https://') || process.env.DATABASE_SSL !== 'true')) {
    throw new Error('Production requires DATABASE_URL, DATABASE_SSL=true, a HOST_KEY of at least 24 characters, and an HTTPS APP_ORIGIN.');
  }
  try {
    if (!['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error();
  } catch { throw new Error('APP_ORIGIN must be a valid http:// or https:// URL.'); }
  db = await openDatabase({
    url: process.env.DATABASE_URL,
    directory: process.env.DATA_DIR ?? '.data/postgres',
    ssl: process.env.DATABASE_SSL === 'true',
  });
  if (stopping) return;
  const store = new Store(db);
  await store.pauseAfterRestart();
  if (stopping) return;
  server = await makeApp(store, {
    origin, hostKey: process.env.HOST_KEY, production,
    trustProxy: process.env.TRUST_PROXY === '1',
    scheduler: process.env.DISABLE_SCHEDULER !== 'true',
    staticDirectory: process.env.RIVER_ROOM_CLIENT_DIR ? resolve(process.env.RIVER_ROOM_CLIENT_DIR) : resolve('dist', 'client'),
  });
  if (stopping) return;
  const http = server.http;
  await new Promise<void>((ready, reject) => {
    const failed = (error: unknown) => { http.off('listening', listening); reject(listenError(error)); };
    const listening = () => { http.off('error', failed); ready(); };
    http.once('error', failed);
    http.once('listening', listening);
    try { http.listen(port, host); }
    catch (error) { http.off('error', failed); failed(error); }
  });
  http.on('error', fatal);
  if (stopping) return;
  console.log(`River Room is ready at ${origin}`);
  if (!process.env.DATABASE_URL) console.log(process.env.DATA_DIR === ':memory:'
    ? 'In-memory development database: records will not persist.'
    : 'Local PostgreSQL store: ' + resolve(process.env.DATA_DIR ?? '.data/postgres'));
  if (process.connected) process.send?.({ type: 'ready', port, host }, error => { if (error) fatal(error); });
}

startupTask = start().catch(error => { reportFailure(error); stopping = true; });
await startupTask;
if (stopping) await shutdown();
