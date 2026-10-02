import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { openDatabase, type Database } from '../src/server/database';
import { DEFAULT_SETTINGS, type Identity, type RoomView } from '../src/shared/model';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = join(root, 'tests', `.local-runtime-${randomUUID()}`);
const children: Runtime[] = [];
const databases: Database[] = [];
const listeners: Server[] = [];
const links: string[] = [];
const staleLockRaces = Number(process.env.RIVER_ROOM_LOCK_STRESS_RUNS ?? '1');
if (!Number.isInteger(staleLockRaces) || staleLockRaces < 1 || staleLockRaces > 50) {
  throw new Error('RIVER_ROOM_LOCK_STRESS_RUNS must be an integer from 1 to 50.');
}
type Exit = { code: number | null; signal: NodeJS.Signals | null };
interface Runtime {
  child: ChildProcess; port: number; directory: string;
  output: () => string;
  started: Promise<'ready' | 'exited'>;
  exited: Promise<Exit>;
  serverPid?: () => number | undefined;
}
type Guest = { user: Identity; cookie: string };

async function within<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Runtime operation exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function exists(path: string) {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Runtime condition did not become true within 15000ms');
    await delay(25);
  }
}
function alive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function listen(server: Server) {
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an isolated TCP port');
  return address.port;
}
async function closeListener(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await closeListener(server);
  return port;
}
async function launch(directory: string, options: { port?: number; env?: NodeJS.ProcessEnv; fixture?: boolean; preload?: string } = {}): Promise<Runtime> {
  const port = options.port ?? await unusedPort();
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'DATABASE_SSL', 'HOST_KEY', 'DATA_DIR', 'PORT', 'APP_ORIGIN', 'HOST', 'TRUST_PROXY', 'NODE_OPTIONS', 'RIVER_ROOM_PARENT_STDIN']) delete env[key];
  Object.assign(env, {
    NODE_ENV: 'test', NODE_USE_SYSTEM_CA: '1', TSX_DISABLE_CACHE: '1', DATA_DIR: directory, PORT: String(port),
    HOST: '127.0.0.1', APP_ORIGIN: `http://localhost:${port}`, DISABLE_SCHEDULER: 'true',
  }, options.env);
  const child = fork(join(root, ...(options.fixture ? ['tests', 'fixtures', 'local-runtime.ts'] : ['src', 'server', 'index.ts'])), [], {
    cwd: root,
    execArgv: ['--import', 'tsx', ...(options.preload ? ['--import', `data:text/javascript,${encodeURIComponent(options.preload)}`] : [])],
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  let started!: (status: 'ready' | 'exited') => void;
  const startup = new Promise<'ready' | 'exited'>(resolve => { started = resolve; });
  child.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready') started('ready');
  });
  const exited = new Promise<Exit>(resolve => {
    child.on('error', error => { output += error.message; });
    child.once('exit', (code, signal) => { started('exited'); resolve({ code, signal }); });
  });
  const runtime = { child, port, directory, output: () => output, started: startup, exited };
  children.push(runtime);
  return runtime;
}
async function launcherFixture() {
  const fixture = join(workspace, `launcher-${randomUUID()}`);
  await mkdir(join(fixture, 'dist', 'server'), { recursive: true });
  await mkdir(join(fixture, 'dist', 'client'));
  await copyFile(join(root, 'Start-Local.ps1'), join(fixture, 'Start-Local.ps1'));
  const modules = join(fixture, 'node_modules');
  await symlink(join(root, 'node_modules'), modules, 'junction');
  links.push(modules);
  await writeFile(join(fixture, 'dist', 'client', 'index.html'), '<!doctype html><title>Isolated launcher test</title>');
  await writeFile(join(fixture, 'dist', 'server', 'index.js'),
    `console.log('RUNTIME_SERVER_PID:' + process.pid);\nawait import(${JSON.stringify(pathToFileURL(join(root, 'src', 'server', 'index.ts')).href)});\n`);
  return fixture;
}
async function launchScript(fixture: string, directory: string, options: { port?: number; checkOnly?: boolean } = {}): Promise<Runtime> {
  const port = options.port ?? await unusedPort();
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'DATABASE_SSL', 'HOST_KEY', 'RIVER_ROOM_PARENT_STDIN']) delete env[key];
  Object.assign(env, { NODE_ENV: 'test', NODE_OPTIONS: '--import=tsx', TSX_DISABLE_CACHE: '1', DATA_DIR: directory, DISABLE_SCHEDULER: 'true' });
  const child = spawn(process.env.RIVER_ROOM_TEST_PWSH ?? 'pwsh.exe',
    ['-NoProfile', '-NonInteractive', '-File', join(fixture, 'Start-Local.ps1'), '-SkipBuild', '-Port', String(port),
      ...(options.checkOnly ? ['-CheckOnly'] : [])],
    { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let started!: (status: 'ready' | 'exited') => void;
  const startup = new Promise<'ready' | 'exited'>(resolve => { started = resolve; });
  child.stdout!.on('data', data => {
    output += String(data);
    if (output.includes('River Room is ready')) started('ready');
  });
  child.stderr!.on('data', data => { output += String(data); });
  const exited = new Promise<Exit>(resolve => {
    child.once('error', error => { output += error.message; started('exited'); resolve({ code: -1, signal: null }); });
    child.once('exit', (code, signal) => { started('exited'); resolve({ code, signal }); });
  });
  const runtime: Runtime = {
    child, port, directory, output: () => output, started: startup, exited,
    serverPid: () => { const match = /RUNTIME_SERVER_PID:(\d+)/.exec(output); return match ? Number(match[1]) : undefined; },
  };
  children.push(runtime);
  return runtime;
}
async function ready(runtime: Runtime) {
  expect(await within(runtime.started), runtime.output()).toBe('ready');
  const response = await fetch(`http://127.0.0.1:${runtime.port}/health/ready`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
}
async function stop(runtime: Runtime, message = 'shutdown') {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null && runtime.child.connected) {
    runtime.child.send({ type: message }, () => {});
  } else if (runtime.serverPid && runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGKILL');
  }
  const result = await within(runtime.exited, 20000);
  if (runtime.serverPid) await until(async () => !alive(runtime.serverPid!()));
  return result;
}
async function expectStopped(runtime: Runtime, code = 0) {
  expect(await stop(runtime), runtime.output()).toEqual({ code, signal: null });
  await expect(fetch(`http://127.0.0.1:${runtime.port}/health/live`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}
async function request(runtime: Runtime, path: string, body?: unknown, guest?: Guest) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: `http://localhost:${runtime.port}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(guest ? { Cookie: guest.cookie, 'X-CSRF-Token': guest.user.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const content = await response.text();
  expect(response.ok, `${response.status}: ${content}`).toBe(true);
  return { response, json: JSON.parse(content) };
}
async function guest(runtime: Runtime, name: string): Promise<Guest> {
  const result = await request(runtime, '/auth/guest', { name });
  return { user: result.json.user, cookie: result.response.headers.get('set-cookie')!.split(';')[0]! };
}
async function table(runtime: Runtime, host: Guest): Promise<RoomView> {
  return (await request(runtime, '/rooms', {
    name: 'Process persistence', settings: { ...DEFAULT_SETTINGS, autoDeal: false },
    buyIn: 10000, commandId: randomUUID(),
  }, host)).json.room as RoomView;
}
async function command(runtime: Runtime, room: RoomView, user: Guest, action: object): Promise<RoomView> {
  return (await request(runtime, `/rooms/${room.id}/commands`, {
    expectedVersion: room.version, commandId: randomUUID(), command: action,
  }, user)).json.room as RoomView;
}
async function roomFor(runtime: Runtime, room: RoomView, user: Guest): Promise<RoomView> {
  return (await request(runtime, `/rooms/${room.id}`, undefined, user)).json.room as RoomView;
}
async function local(directory: string) {
  const db = await openDatabase({ directory });
  databases.push(db);
  return db;
}

function lockFault(options: {
  directory: string; owner?: string; operation: 'readFile' | 'unlink' | 'rmdir';
  failures?: number; replacement?: { name: string; record: string };
}) {
  return `
    import fs from 'node:fs/promises';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const options = ${JSON.stringify(options)};
    const directory = options.directory + '.river-room.lock';
    const target = options.operation === 'rmdir' ? directory : join(directory, options.owner);
    const originals = { readFile: fs.readFile, unlink: fs.unlink, rmdir: fs.rmdir,
      mkdir: fs.mkdir, writeFile: fs.writeFile, rename: fs.rename };
    let attempts = 0;
    let replaced = false;
    for (const operation of ['readFile', 'unlink', 'rmdir']) {
      fs[operation] = async (path, ...args) => {
        if (replaced && ((operation === 'unlink' && path === join(directory, options.replacement.name)) ||
            (operation === 'rmdir' && path === directory))) {
          process.stderr.write('TEST_REPLACEMENT_MUTATION\\n');
        }
        if (operation === options.operation && path === target) {
          attempts++;
          process.stderr.write('TEST_LOCK_ATTEMPT:' + attempts + '\\n');
          if (options.replacement && !replaced) {
            const candidate = directory + '.fixture-replacement';
            await originals.mkdir(candidate);
            await originals.writeFile(join(candidate, options.replacement.name), options.replacement.record);
            try { await originals.unlink(join(directory, options.owner)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            await originals.rmdir(directory);
            await originals.rename(candidate, directory);
            replaced = true;
            throw Object.assign(new Error('Injected Windows replacement race'), { code: 'EPERM', path, syscall: operation });
          }
          if (!options.replacement && (options.failures === undefined || attempts <= options.failures)) {
            throw Object.assign(new Error('Injected Windows lock contention'), { code: 'EPERM', path, syscall: operation });
          }
        }
        return originals[operation](path, ...args);
      };
    }
    syncBuiltinESMExports();
  `;
}
async function crashedLock(label: string) {
  const directory = join(workspace, label);
  const original = await launch(directory);
  await ready(original);
  const owner = (await readdir(`${directory}.river-room.lock`))[0]!;
  original.child.kill('SIGKILL');
  await within(original.exited);
  return { directory, owner };
}

beforeAll(async () => { await mkdir(workspace); });
afterEach(async () => {
  await Promise.all(children.splice(0).map(async runtime => {
    try { await within(stop(runtime), 5000); }
    catch {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGKILL');
      if (runtime.serverPid && alive(runtime.serverPid())) process.kill(runtime.serverPid()!, 'SIGKILL');
      await within(runtime.exited);
      if (runtime.serverPid) await until(async () => !alive(runtime.serverPid!()));
    }
  }));
  for (const database of databases.splice(0)) await database.close();
  for (const listener of listeners.splice(0)) await closeListener(listener);
});
afterAll(async () => {
  for (const link of links) await unlink(link);
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('real local process lifecycle', () => {
  test('persists identities, completed history, ledger and active hands across graceful process restarts', async () => {
    const directory = join(workspace, 'restart');
    const first = await launch(directory);
    await ready(first);
    const host = await guest(first, 'Restart host');
    const player = await guest(first, 'Restart player');
    let room = await table(first, host);
    room = (await request(first, '/rooms/join', { code: room.code, commandId: randomUUID() }, player)).json.room;
    room = await command(first, room, player, { type: 'fund', amount: 10000 });
    room = await command(first, room, host, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    room = await command(first, room, host, { type: 'deal' });
    for (let turn = 0; room.hand?.street !== 'complete'; turn++) {
      expect(turn).toBeLessThan(30);
      const actor = room.hand?.actorId === host.user.id ? host : player;
      room = await roomFor(first, room, actor);
      room = await command(first, room, actor, { type: 'act', action: room.legal.canCheck ? 'check' : 'call' });
    }
    room = await command(first, room, host, { type: 'deal' });
    const snapshot = structuredClone(room);
    const ledger = (await request(first, `/rooms/${room.id}/ledger`, undefined, host)).json;
    const history = (await request(first, `/rooms/${room.id}/hands`, undefined, host)).json;
    const audit = (await request(first, `/rooms/${room.id}/audit`, undefined, host)).json;
    expect(history.entries).toHaveLength(1);
    await expectStopped(first);
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);

    const second = await launch(directory, { port: first.port, env: { DISABLE_SCHEDULER: 'false' } });
    await ready(second);
    expect((await request(second, '/me', undefined, host)).json.user).toEqual(host.user);
    room = await roomFor(second, room, host);
    expect(room.paused).toBe(true);
    expect(room.hand?.deadline).toBeNull();
    expect(room.hand?.id).toBe(snapshot.hand?.id);
    expect(room.hand?.pot).toBe(snapshot.hand?.pot);
    expect(room.hand?.board).toEqual(snapshot.hand?.board);
    expect(room.players.map(item => [item.id, item.stack, item.cards])).toEqual(snapshot.players.map(item => [item.id, item.stack, item.cards]));
    expect((await request(second, `/rooms/${room.id}/ledger`, undefined, host)).json).toEqual(ledger);
    expect((await request(second, `/rooms/${room.id}/hands`, undefined, host)).json).toEqual(history);
    const pausedAudit = (await request(second, `/rooms/${room.id}/audit`, undefined, host)).json;
    expect(pausedAudit.entries.slice(1)).toEqual(audit.entries);
    expect(pausedAudit.entries[0].command).toBe('pause');
    expect((await request(second, `/rooms/${room.id}/integrity`, undefined, host)).json.valid).toBe(true);
    await delay(1500);
    expect((await roomFor(second, room, host)).version).toBe(room.version);
    await expectStopped(second);

    const third = await launch(directory, { port: first.port });
    await ready(third);
    expect((await roomFor(third, room, host)).version).toBe(room.version);
    room = await command(third, room, host, { type: 'pause', value: false });
    expect(room.paused).toBe(false);
    const actor = room.hand?.actorId === host.user.id ? host : player;
    room = await roomFor(third, room, actor);
    room = await command(third, room, actor, { type: 'act', action: room.legal.canCheck ? 'check' : 'call' });
    expect(room.version).toBeGreaterThan(snapshot.version);
    await expectStopped(third);
  }, 60000);

  test('refuses duplicate servers even on different ports and directory aliases without disturbing the owner', async () => {
    const directory = join(workspace, 'duplicate');
    const owner = await launch(directory);
    await ready(owner);
    const lock = await readdir(`${directory}.river-room.lock`);
    const host = await guest(owner, 'Exclusive owner');
    const room = await table(owner, host);
    const alias = join(workspace, 'duplicate-alias');
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(alias);
    const duplicate = await launch(alias);
    expect((await within(duplicate.exited)).code, duplicate.output()).toBe(1);
    expect(duplicate.output()).toContain(`already in use by process ${owner.child.pid}`);
    expect(duplicate.output()).toContain('Changing PORT alone');
    expect(duplicate.output()).not.toContain('River Room is ready');
    expect(await readdir(`${directory}.river-room.lock`)).toEqual(lock);
    expect((await roomFor(owner, room, host)).version).toBe(room.version);
    await expectStopped(owner);
    const replacement = await launch(directory, { port: duplicate.port });
    await ready(replacement);
    expect((await roomFor(replacement, room, host)).id).toBe(room.id);
  });

  test.each(Array.from({ length: staleLockRaces }, (_, index) => index + 1))(
    'recovers a killed owner safely when several new processes race for its data (race %i)', async iteration => {
    const directory = join(workspace, `stale-${iteration}`);
    const original = await launch(directory);
    await ready(original);
    const host = await guest(original, 'Crash survivor');
    const room = await table(original, host);
    const ledger = (await request(original, `/rooms/${room.id}/ledger`, undefined, host)).json;
    const audit = (await request(original, `/rooms/${room.id}/audit`, undefined, host)).json;
    const oldLock = await readdir(`${directory}.river-room.lock`);
    expect(oldLock).toHaveLength(1);
    expect(oldLock[0]).toContain(`owner-${original.child.pid}-`);
    original.child.kill('SIGKILL');
    await within(original.exited);
    expect(await readdir(`${directory}.river-room.lock`)).toEqual(oldLock);
    const contenders = await Promise.all(Array.from({ length: 4 }, () => launch(directory)));
    const results = await Promise.all(contenders.map(runtime => within(runtime.started)));
    expect(results.filter(result => result === 'ready')).toHaveLength(1);
    const winner = contenders[results.indexOf('ready')]!;
    await ready(winner);
    const winningLock = await readdir(`${directory}.river-room.lock`);
    expect(winningLock).toHaveLength(1);
    expect(winningLock[0]).toContain(`owner-${winner.child.pid}-`);
    for (const loser of contenders.filter(runtime => runtime !== winner)) {
      expect((await within(loser.exited)).code, loser.output()).toBe(1);
      expect(loser.output(), `Dead owner ${oldLock[0]}; live winner ${winningLock[0]}`)
        .toContain(`already in use by process ${winner.child.pid}`);
    }
    expect(await readdir(`${directory}.river-room.lock`)).toEqual(winningLock);
    expect(winningLock).not.toEqual(oldLock);
    expect((await request(winner, '/me', undefined, host)).json.user).toEqual(host.user);
    expect((await roomFor(winner, room, host)).players[0]?.stack).toBe(10000);
    expect((await request(winner, `/rooms/${room.id}/ledger`, undefined, host)).json).toEqual(ledger);
    expect((await request(winner, `/rooms/${room.id}/audit`, undefined, host)).json).toEqual(audit);
    expect((await request(winner, `/rooms/${room.id}/integrity`, undefined, host)).json.valid).toBe(true);
    await expectStopped(winner);
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    expect((await readdir(workspace)).filter(name => name.startsWith(`stale-${iteration}.river-room.lock.`))).toEqual([]);
  });

  test('occupied ports produce an actionable failure, close storage, and leave the existing listener alone', async () => {
    const directory = join(workspace, 'occupied');
    const blocker = createServer((_req, res) => { res.end('existing listener'); });
    const port = await listen(blocker);
    const failed = await launch(directory, { port });
    expect((await within(failed.exited)).code, failed.output()).toBe(1);
    expect(failed.output()).toContain(`Port ${port} on 127.0.0.1 is already in use`);
    expect(failed.output()).toContain('Start-Local.ps1 -Port');
    expect(failed.output()).not.toContain('River Room is ready');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('existing listener');
    await closeListener(blocker);
    const retry = await launch(directory, { port });
    await ready(retry);
    await expectStopped(retry);
  });

  test('a graceful stop during initialization cannot leave a listener or a data lock behind', async () => {
    const directory = join(workspace, 'early-stop');
    const runtime = await launch(directory);
    await until(() => exists(`${directory}.river-room.lock`));
    await expectStopped(runtime);
    expect(runtime.output()).not.toContain('River Room is ready');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    const next = await launch(directory, { port: runtime.port });
    await ready(next);
  });

  test('parent IPC disconnect shuts the server down rather than leaving an orphan', async () => {
    const directory = join(workspace, 'parent-exit');
    const runtime = await launch(directory);
    await ready(runtime);
    runtime.child.disconnect();
    expect(await within(runtime.exited), runtime.output()).toEqual({ code: 0, signal: null });
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    const early = await launch(join(workspace, 'early-parent-exit'));
    early.child.disconnect();
    expect(await within(early.exited), early.output()).toEqual({ code: 0, signal: null });
    expect(early.output()).not.toContain('River Room is ready');
  });

  test('accepts namespaced parent shutdown messages for the isolated Windows harness', async () => {
    const runtime = await launch(':memory:', { env: { NODE_ENV: 'development', HOST_KEY: '' } });
    await ready(runtime);
    expect(await stop(runtime, 'river-room:shutdown'), runtime.output()).toEqual({ code: 0, signal: null });
    await expect(fetch(`http://127.0.0.1:${runtime.port}/health/live`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  test('the interrupt handler and fatal-error path both drain the real process and release storage', async () => {
    const directory = join(workspace, 'signals');
    const interrupted = await launch(directory, { fixture: true });
    await ready(interrupted);
    expect(await stop(interrupted, 'test:interrupt'), interrupted.output()).toEqual({ code: 0, signal: null });
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    const failed = await launch(directory, { fixture: true });
    await ready(failed);
    expect(await stop(failed, 'test:fatal'), failed.output()).toEqual({ code: 1, signal: null });
    expect(failed.output()).toContain('Injected local runtime failure');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
  });

  test('invalid configuration never starts a server or silently selects a new local store', async () => {
    const cases = [
      { env: { PORT: 'invalid' }, message: 'PORT must be a valid TCP port' },
      { env: { APP_ORIGIN: 'not a URL' }, message: 'APP_ORIGIN must be a valid' },
      { env: { DATA_DIR: '' }, message: 'DATA_DIR must be a directory path' },
      { env: { DATABASE_URL: '   ' }, message: 'whitespace-only values are not valid' },
      { env: { DATABASE_URL: 'not a URL' }, message: 'DATABASE_URL must be a valid PostgreSQL URL' },
      { env: { NODE_ENV: 'production', DATABASE_URL: '' }, message: 'Production requires DATABASE_URL, DATABASE_SSL=true' },
      { env: { DATABASE_URL: 'postgresql://localhost/riverroom?sslmode=disable', DATABASE_SSL: 'true' }, message: 'Configure TLS with DATABASE_SSL' },
    ];
    for (const [index, item] of cases.entries()) {
      const directory = join(workspace, `bad-config-${index}`);
      const runtime = await launch(directory, { env: item.env });
      expect((await within(runtime.exited)).code, runtime.output()).toBe(1);
      expect(runtime.output()).toContain(item.message);
      expect(runtime.output()).not.toContain('River Room is ready');
      expect(await exists(directory)).toBe(false);
    }
  });

  test('explicit in-memory startup remains supported and clearly announces nonpersistence', async () => {
    const runtime = await launch(':memory:', { env: { DATABASE_URL: '' } });
    await ready(runtime);
    expect(runtime.output()).toContain('In-memory development database: records will not persist.');
    const host = await guest(runtime, 'Memory-only player');
    await table(runtime, host);
    await expectStopped(runtime);
    const replacement = await launch(':memory:', { port: runtime.port, env: { DATABASE_URL: '' } });
    await ready(replacement);
    expect((await request(replacement, '/me', undefined, host)).json.user).toBeNull();
  });

  test('explicitly cleared database URLs preserve the local harness contract without losing persistence', async () => {
    const directory = join(workspace, 'cleared-database-url');
    const env = { DATABASE_URL: '', HOST_KEY: '', NODE_ENV: 'development' };
    const runtime = await launch(directory, { env });
    await ready(runtime);
    expect(runtime.output()).toContain(`Local PostgreSQL store: ${directory}`);
    const host = await guest(runtime, 'Cleared URL player');
    const room = await table(runtime, host);
    expect(await stop(runtime, 'river-room:shutdown'), runtime.output()).toEqual({ code: 0, signal: null });
    const replacement = await launch(directory, { port: runtime.port, env });
    await ready(replacement);
    expect((await roomFor(replacement, room, host)).players[0]?.stack).toBe(10000);
  });
});

describe('Windows foreground launcher', () => {
  const windowsTest = process.platform === 'win32' ? test : test.skip;

  windowsTest('a terminated PowerShell launcher gracefully stops its owned server instead of leaving an orphan', async () => {
    const fixture = await launcherFixture();
    const directory = join(fixture, 'postgres');
    const runtime = await launchScript(fixture, directory);
    await ready(runtime);
    const host = await guest(runtime, 'Launcher survivor');
    const room = await table(runtime, host);
    expect(alive(runtime.serverPid?.())).toBe(true);
    runtime.child.kill('SIGKILL');
    await within(runtime.exited);
    await until(async () => !alive(runtime.serverPid?.()));
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${runtime.port}/health/live`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    const replacement = await launch(directory, { port: runtime.port });
    await ready(replacement);
    expect((await roomFor(replacement, room, host)).players[0]?.stack).toBe(10000);
  }, 60000);

  windowsTest('CheckOnly never serves, missing builds fail early, and occupied ports leave no server child behind', async () => {
    const fixture = await launcherFixture();
    const directory = join(fixture, 'postgres');
    const check = await launchScript(fixture, directory, { checkOnly: true });
    expect((await within(check.exited)).code, check.output()).toBe(0);
    expect(check.output()).toContain('Local application is built and ready');
    expect(check.serverPid?.()).toBeUndefined();
    expect(await exists(directory)).toBe(false);
    const index = join(fixture, 'dist', 'client', 'index.html');
    await rename(index, `${index}.saved`);
    const missing = await launchScript(fixture, directory);
    expect((await within(missing.exited)).code, missing.output()).toBe(1);
    expect(missing.output()).toContain('production build is missing');
    expect(missing.serverPid?.()).toBeUndefined();
    await rename(`${index}.saved`, index);
    const blocker = createServer((_req, res) => { res.end('still the original listener'); });
    const port = await listen(blocker);
    const failed = await launchScript(fixture, directory, { port });
    expect((await within(failed.exited)).code, failed.output()).toBe(1);
    expect(failed.output()).toContain('is already in use');
    await until(async () => !alive(failed.serverPid?.()));
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('still the original listener');
  }, 60000);
});

describe('Windows lock reconciliation', () => {
  const windowsTest = process.platform === 'win32' ? test : test.skip;

  windowsTest.each(['readFile', 'unlink', 'rmdir'] as const)(
    'rereads ownership after %s EPERM without deleting a replacement owner', async operation => {
    const { directory, owner } = await crashedLock(`replacement-${operation}`);
    const replacement = {
      name: `owner-${process.pid}-${randomUUID()}.json`,
      record: JSON.stringify({ pid: process.pid, host: hostname() }),
    };
    const contender = await launch(directory, { preload: lockFault({ directory, owner, operation, replacement }) });
    expect((await within(contender.exited)).code, contender.output()).toBe(1);
    expect(contender.output()).toContain('TEST_LOCK_ATTEMPT:1');
    expect(contender.output()).toContain(`already in use by process ${process.pid}`);
    expect(contender.output()).not.toContain('TEST_REPLACEMENT_MUTATION');
    expect(contender.output()).not.toContain('River Room is ready');
    expect(await readdir(`${directory}.river-room.lock`)).toEqual([replacement.name]);
    expect(await readFile(join(`${directory}.river-room.lock`, replacement.name), 'utf8')).toBe(replacement.record);
    expect((await readdir(workspace)).filter(name => name.startsWith(`${basename(directory)}.river-room.lock.`))).toEqual([]);
  });

  windowsTest.each(['foreign', 'malformed'] as const)(
    'keeps %s replacement ownership protected after a transient unlink denial', async kind => {
    const { directory, owner } = await crashedLock(`unverified-${kind}`);
    const replacement = {
      name: `owner-${process.pid}-${randomUUID()}.json`,
      record: kind === 'foreign' ? JSON.stringify({ pid: process.pid, host: `${hostname()}-another-host` }) : '{invalid',
    };
    const contender = await launch(directory, {
      preload: lockFault({ directory, owner, operation: 'unlink', replacement }),
    });
    expect((await within(contender.exited)).code, contender.output()).toBe(1);
    expect(contender.output()).toContain('TEST_LOCK_ATTEMPT:1');
    expect(contender.output()).toContain('Cannot verify');
    expect(contender.output()).not.toContain('TEST_REPLACEMENT_MUTATION');
    expect(await readdir(`${directory}.river-room.lock`)).toEqual([replacement.name]);
    expect(await readFile(join(`${directory}.river-room.lock`, replacement.name), 'utf8')).toBe(replacement.record);
  });

  windowsTest('persistent unlink denial fails after bounded retries without discarding the owner record', async () => {
    const { directory, owner } = await crashedLock('persistent-lock-denial');
    const record = await readFile(join(`${directory}.river-room.lock`, owner), 'utf8');
    const contender = await launch(directory, { preload: lockFault({ directory, owner, operation: 'unlink' }) });
    expect((await within(contender.exited)).code, contender.output()).toBe(1);
    const attempts = [...contender.output().matchAll(/TEST_LOCK_ATTEMPT:(\d+)/g)].map(match => Number(match[1]));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.at(-1)).toBeLessThanOrEqual(40);
    expect(contender.output()).toContain('after bounded retries (EPERM)');
    expect(contender.output()).toContain('check DATA_DIR permissions');
    expect(contender.output()).not.toContain('River Room is ready');
    expect(await readdir(`${directory}.river-room.lock`)).toEqual([owner]);
    expect(await readFile(join(`${directory}.river-room.lock`, owner), 'utf8')).toBe(record);
    expect((await readdir(workspace)).filter(name => name.startsWith('persistent-lock-denial.river-room.lock.'))).toEqual([]);
  });

  windowsTest('graceful close retries a transient owned-directory denial and removes only its own lock', async () => {
    const directory = join(workspace, 'release-lock-denial');
    const runtime = await launch(directory, { preload: lockFault({ directory, operation: 'rmdir', failures: 2 }) });
    await ready(runtime);
    await expectStopped(runtime);
    expect(runtime.output()).toContain('TEST_LOCK_ATTEMPT:3');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
  });
});

describe('local database ownership and failure cleanup', () => {
  test('same-process duplicate opens fail; close is idempotent and permits reopening', async () => {
    const directory = join(workspace, 'same-process');
    const first = await local(directory);
    await first.query('CREATE TABLE persistence_marker(value text)');
    await first.query('INSERT INTO persistence_marker VALUES ($1)', ['saved']);
    await expect(openDatabase({ directory })).rejects.toThrow('already in use by process');
    await Promise.all([first.close(), first.close()]);
    const second = await local(directory);
    expect((await second.query('SELECT value FROM persistence_marker')).rows).toEqual([{ value: 'saved' }]);
  });

  test('nonempty data without PG_VERSION is refused without overwriting saved records', async () => {
    const directory = join(workspace, 'missing-version');
    const first = await local(directory);
    await first.query('CREATE TABLE persistence_marker(value text)');
    await first.query('INSERT INTO persistence_marker VALUES ($1)', ['not discarded']);
    await first.close();
    await rename(join(directory, 'PG_VERSION'), join(directory, 'PG_VERSION.backup'));
    await expect(openDatabase({ directory })).rejects.toThrow('Refusing to initialize over existing or damaged data');
    expect(await exists(join(directory, 'PG_VERSION'))).toBe(false);
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    await rename(join(directory, 'PG_VERSION.backup'), join(directory, 'PG_VERSION'));
    const restored = await local(directory);
    expect((await restored.query('SELECT value FROM persistence_marker')).rows).toEqual([{ value: 'not discarded' }]);
    await expect(openDatabase({ directory: '' })).rejects.toThrow('DATA_DIR must be');
  });

  test('schema initialization failure cleans up handles and its lock and can be corrected in place', async () => {
    const directory = join(workspace, 'schema-failure');
    const raw = new PGlite(directory);
    await raw.exec('CREATE TABLE rr_members(wrong_column TEXT)');
    await raw.close();
    const failed = await launch(directory);
    expect((await within(failed.exited)).code, failed.output()).toBe(1);
    expect(failed.output()).toContain('Unable to open local database');
    expect(failed.output()).toContain('user_id');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    const repair = new PGlite(directory);
    await repair.exec('DROP TABLE rr_members');
    await repair.close();
    const next = await launch(directory, { port: failed.port });
    await ready(next);
  });

  test('engine initialization errors release the owned lock without replacing a damaged database', async () => {
    const directory = join(workspace, 'engine-failure');
    const first = await local(directory);
    await first.query('CREATE TABLE persistence_marker(value text)');
    await first.query('INSERT INTO persistence_marker VALUES ($1)', ['recoverable']);
    await first.close();
    const version = await readFile(join(directory, 'PG_VERSION'), 'utf8');
    await writeFile(join(directory, 'PG_VERSION'), '999\n');
    const failed = await launch(directory);
    expect((await within(failed.exited)).code, failed.output()).toBe(1);
    expect(failed.output()).toContain('Unable to open local database');
    expect(failed.output()).not.toContain('River Room is ready');
    expect(await readFile(join(directory, 'PG_VERSION'), 'utf8')).toBe('999\n');
    expect(await exists(`${directory}.river-room.lock`)).toBe(false);
    await writeFile(join(directory, 'PG_VERSION'), version);
    const restored = await local(directory);
    expect((await restored.query('SELECT value FROM persistence_marker')).rows).toEqual([{ value: 'recoverable' }]);
  });

  test('a data path that is a file is rejected, and an empty abandoned lock can be recovered', async () => {
    const file = join(workspace, 'not-a-directory');
    await writeFile(file, 'Do not overwrite');
    await expect(openDatabase({ directory: file })).rejects.toThrow('Unable to open local database');
    expect(await readFile(file, 'utf8')).toBe('Do not overwrite');
    const directory = join(workspace, 'empty-lock');
    await mkdir(directory);
    await mkdir(`${directory}.river-room.lock`);
    const db = await local(directory);
    expect((await db.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
  });

  test('unknown or foreign lock ownership is never reclaimed, and close never removes a replacement lock', async () => {
    const directory = join(workspace, 'ownership');
    await mkdir(directory);
    const lock = `${directory}.river-room.lock`;
    await mkdir(lock);
    const foreign = `owner-${process.pid}-${randomUUID()}.json`;
    await writeFile(join(lock, foreign), JSON.stringify({ pid: process.pid, host: `${hostname()}-another-host` }));
    await expect(openDatabase({ directory })).rejects.toThrow('Cannot verify the owner');
    expect(await readdir(lock)).toEqual([foreign]);
    expect(await readdir(directory)).toEqual([]);
    await rm(lock, { recursive: true });
    const db = await local(directory);
    await rename(lock, `${lock}.original`);
    await mkdir(lock);
    const replacement = `owner-${process.pid}-${randomUUID()}.json`;
    const metadata = JSON.stringify({ pid: process.pid, host: hostname() });
    await writeFile(join(lock, replacement), metadata);
    await db.close();
    expect(await readdir(lock)).toEqual([replacement]);
    expect(await readFile(join(lock, replacement), 'utf8')).toBe(metadata);
  });
});
