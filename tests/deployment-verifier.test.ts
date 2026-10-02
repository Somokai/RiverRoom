import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket as ServerSocket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { makeApp } from '../src/server/app';
import { openDatabase, type Database } from '../src/server/database';
import { Store } from '../src/server/store';
import type { Command, Room, RoomView } from '../src/shared/model';
import {
  OriginCookieJar, deploymentOptionsFrom, validateDeploymentOrigin, verifyDeployment,
  type DeploymentOptions,
} from '../src/testing/verify-deployment';

const project = fileURLToPath(new URL('../', import.meta.url));
const directory = join(project, '.artifacts', `deployment-verifier-tests-${randomUUID()}`);
const hostKey = `synthetic-test-only-${randomUUID()}`;
const fakeToken = 's'.repeat(43);
const productionSession = `__Host-river-session=${fakeToken}; Path=/; Secure; HttpOnly; SameSite=Lax`;
function headers(...cookies: string[]) {
  const result = new Headers();
  for (const cookie of cookies) result.append('set-cookie', cookie);
  return result;
}
let reportNumber = 0;
function options(url: string, overrides: Partial<DeploymentOptions> = {}): DeploymentOptions {
  return {
    url, allowLocalHttp: true, output: join(directory, `${++reportNumber}.json`),
    requestTimeoutMs: 4000, timeoutMs: 25_000, ...overrides,
  };
}
beforeAll(async () => { await mkdir(directory, { recursive: true }); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('explicit deployment destination and secret contract', () => {
  test.each([
    '', 'https://', 'not a URL', 'https://user:password@example.test', 'https://user@example.test',
    'https://example.test/rooms', 'https://example.test/?secret=value', 'https://example.test#secret',
    'https://example.test?', 'https://example.test/#', 'https://example.test/a/..', 'https://example.test\\evil',
    ' https://example.test', 'https://example.test/\n', 'ftp://example.test', '//example.test',
  ])('rejects a non-origin without reflecting its contents: %j', value => {
    expect(() => validateDeploymentOrigin(value)).toThrow();
    let error = '';
    try { validateDeploymentOrigin(value); } catch (caught) { error = String(caught); }
    if (value.includes('secret') || value.includes('password')) {
      expect(error).not.toContain('secret=value'); expect(error).not.toContain('user:password');
    }
  });
  test('normalizes HTTPS, allows only explicitly opted-in loopback HTTP, and rejects remote HTTP', () => {
    expect(validateDeploymentOrigin('https://RIVER.example.test:443/')).toBe('https://river.example.test');
    for (const host of ['127.0.0.1', '127.3.2.1', 'localhost', '[::1]']) {
      expect(() => validateDeploymentOrigin(`http://${host}:1234`)).toThrow('HTTPS is required');
      expect(validateDeploymentOrigin(`http://${host}:1234`, true)).toBe(`http://${host}:1234`);
    }
    for (const host of ['example.test', 'localhost.example.test', '128.0.0.1', '0.0.0.0', '10.0.0.1', '[::]', '[::ffff:10.0.0.1]'])
      expect(() => validateDeploymentOrigin(`http://${host}:1234`, true)).toThrow('HTTPS is required');
  });
  test('has no endpoint or command-line secret fallback, and bounds timeouts/output', () => {
    expect(() => deploymentOptionsFrom([])).toThrow('explicit HTTPS origin');
    const secret = 'do-not-echo-this-secret';
    for (const arg of [`--host-key=${secret}`, `--url=${secret}`, `--unknown-${secret}`, secret]) {
      let error = '';
      try { deploymentOptionsFrom(['--url=https://example.test', arg]); } catch (caught) { error = String(caught); }
      expect(error).not.toBe(''); expect(error).not.toContain(secret);
    }
    const parsed = deploymentOptionsFrom(['--url', 'https://example.test']);
    expect(parsed.output).toBe(resolve(project, '.artifacts', 'azure-verification.json'));
    expect(parsed).not.toHaveProperty('hostKey');
    expect(() => deploymentOptionsFrom(['--url=https://example.test', '--timeout-seconds=0'])).toThrow('timeout');
    expect(() => deploymentOptionsFrom(['--url=https://example.test', '--timeout-seconds=601'])).toThrow('timeout');
    expect(() => deploymentOptionsFrom(['--url=https://example.test', '--request-timeout-seconds=31'])).toThrow('timeout');
    for (const path of ['.data\\unowned.json', 'backups\\unowned.json', 'dist\\unowned.json', '.env', 'package.json'])
      expect(() => deploymentOptionsFrom(['--url=https://example.test', '--output', path])).toThrow('report path');
  });
  test('fails with a non-secret persistent report before networking if the env key is absent/invalid', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Networking must not happen.'));
    for (const value of ['', 'too-short', 's'.repeat(257)]) {
      vi.stubEnv('RIVER_ROOM_HOST_KEY', value);
      const input = options('https://invalid.example.test');
      const report = await verifyDeployment(input);
      expect(report).toMatchObject({
        status: 'failed', counts: { httpRequests: 0 }, error: { code: 'host_key_required', check: 'configuration' },
        session: { status: 'not_created', pauseAttempted: false },
      });
      expect(JSON.parse(await readFile(input.output!, 'utf8'))).toEqual(report);
      expect(JSON.stringify(report)).not.toContain(value || 'nonexistent-secret');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  test('rejects secret API options and ambient TLS bypass without networking', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Networking must not happen.'));
    vi.stubEnv('RIVER_ROOM_HOST_KEY', hostKey);
    await expect(verifyDeployment({ ...options('https://example.test'), hostKey: 'secret-in-options' } as DeploymentOptions))
      .rejects.toThrow('only through RIVER_ROOM_HOST_KEY');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const report = await verifyDeployment(options('https://example.test'));
    expect(report.error?.code).toBe('unsafe_tls_environment');
    expect(JSON.stringify(report)).not.toContain(hostKey);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('single-origin session and proxy-affinity cookie handling', () => {
  test('finds the secure session after proxy cookies, retains all appropriate HTTP/WSS cookies, and never serializes values', () => {
    const jar = new OriginCookieJar('https://example.test');
    jar.accept(headers(
      'ARRAffinity=first-proxy-secret; Path=/; Secure; HttpOnly',
      'ARRAffinitySameSite=second-proxy-secret; Path=/; Secure; SameSite=None',
      productionSession,
      'api-only=value; Path=/api; Secure',
    ), 'https://example.test/api/auth/guest');
    expect(() => jar.assertSession()).not.toThrow();
    const api = jar.header('https://example.test/api/rooms');
    expect(api).toContain('ARRAffinity=first-proxy-secret');
    expect(api).toContain('ARRAffinitySameSite=second-proxy-secret');
    expect(api).toContain(`__Host-river-session=${fakeToken}`);
    expect(api).toContain('api-only=value');
    expect(jar.header('wss://example.test/socket.io/?EIO=4')).not.toContain('api-only=');
    expect(jar.header('https://example.test/apiculture')).not.toContain('api-only=');
    expect(jar.header('wss://example.test/socket.io/')).toContain('ARRAffinity=first-proxy-secret');
    expect(JSON.stringify(jar)).toBe('{}');
    expect(() => jar.header('https://other.test/api/rooms')).toThrow('configured origin');
    expect(() => jar.header('https://example.test:8443/api/rooms')).toThrow('configured origin');
    expect(() => jar.header('http://example.test/api/rooms')).toThrow('configured origin');
  });
  test.each([
    productionSession.replace('; Secure', ''),
    productionSession.replace('; HttpOnly', ''),
    productionSession.replace('; SameSite=Lax', ''),
    productionSession.replace('SameSite=Lax', 'SameSite=None'),
    productionSession.replace('Path=/', 'Path=/api'),
    `${productionSession}; Domain=example.test`,
    productionSession.replace('__Host-river-session', 'river-session'),
    productionSession.replace(fakeToken, 'not-an-opaque-token'),
  ])('rejects unsafe production session attributes, case %#: %s', cookie => {
    const jar = new OriginCookieJar('https://example.test');
    expect(() => {
      jar.accept(headers('ARRAffinity=first; Path=/; Secure', cookie), 'https://example.test/api/auth/guest');
      jar.assertSession();
    }).toThrow();
  });
  test('respects update, deletion, expiry, secure transport, default paths, and mismatched domains', () => {
    const jar = new OriginCookieJar('http://127.0.0.1:1234');
    jar.accept(headers(
      `river-session=${fakeToken}; Path=/; HttpOnly; SameSite=Strict`,
      'route=one; Path=/api', 'fallback=one', 'ignored=one; Secure; Path=/',
      'foreign=one; Domain=other.test; Path=/', 'gone=one; Max-Age=0; Path=/',
    ), 'http://127.0.0.1:1234/api/auth/guest');
    expect(jar.header('http://127.0.0.1:1234/api/rooms')).toContain('route=one');
    expect(jar.header('http://127.0.0.1:1234/api/rooms')).not.toMatch(/fallback|ignored|foreign|gone/);
    expect(jar.header('http://127.0.0.1:1234/api/auth/me')).toContain('fallback=one');
    jar.accept(headers('route=two; Path=/api', 'fallback=; Path=/api/auth; Max-Age=0'), 'http://127.0.0.1:1234/api/auth/guest');
    expect(jar.header('http://127.0.0.1:1234/api/rooms')).toContain('route=two');
    expect(jar.header('http://127.0.0.1:1234/api/auth/me')).not.toContain('fallback=');
    jar.accept(headers('river-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'), 'http://127.0.0.1:1234/api/auth/logout');
    expect(() => jar.assertSession()).toThrow('expected opaque session');
  });
  test('bounds cookie storage and refuses cross-origin response injection', () => {
    const jar = new OriginCookieJar('https://example.test');
    expect(() => jar.accept(headers(productionSession), 'https://other.test/api/auth/guest')).toThrow('configured origin');
    expect(() => jar.accept(headers(`huge=${'x'.repeat(5000)}`), 'https://example.test/')).toThrow('limit');
    expect(() => jar.accept(headers(...Array.from({ length: 33 }, (_, i) => `c${i}=value; Path=/`)), 'https://example.test/')).toThrow('Too many');
  });
});

type Intercept = (request: IncomingMessage, response: ServerResponse) => boolean;
describe('real isolated HTTP/Socket.IO/PGlite deployment smoke', () => {
  let database: Database;
  let store: Store;
  let server: Awaited<ReturnType<typeof makeApp>>;
  let base: string;
  let intercept: Intercept | null = null;
  let socketRedirect: string | null = null;
  const requests: Array<{ path: string; cookie: string; origin?: string; method?: string }> = [];
  const upgrades: Array<{ cookie: string; origin?: string }> = [];
  const secrets = new Set<string>([hostKey]);

  beforeAll(async () => {
    database = await openDatabase({ directory: ':memory:' }); store = new Store(database);
    const reservation = createNetServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address(); assert(address && typeof address !== 'string'); assert.notEqual(address.port, 8080);
    base = `http://127.0.0.1:${address.port}`;
    try {
      server = await makeApp(store, { origin: base, hostKey, production: true, trustProxy: false, scheduler: false,
        staticDirectory: join(project, 'dist', 'client') });
    } finally { await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve())); }
    const listeners = server.http.listeners('request');
    server.http.removeAllListeners('request');
    server.http.on('request', (request, response) => {
      requests.push({ path: request.url!, cookie: request.headers.cookie ?? '', origin: request.headers.origin, method: request.method });
      // Affinity arrives before Express appends its session. This catches first-Set-Cookie shortcuts.
      response.setHeader('Set-Cookie', ['ARRAffinity=owned-http-affinity; Path=/; HttpOnly; SameSite=Lax']);
      if (intercept?.(request, response)) return;
      for (const listener of listeners) listener.call(server.http, request, response);
    });
    const upgradeListeners = server.http.listeners('upgrade');
    server.http.removeAllListeners('upgrade');
    server.http.on('upgrade', (request, socket, head) => {
      upgrades.push({ cookie: request.headers.cookie ?? '', origin: request.headers.origin });
      if (socketRedirect) {
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${socketRedirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      for (const listener of upgradeListeners) listener.call(server.http, request, socket, head);
    });
    server.io.engine.on('headers', outgoing => { outgoing['set-cookie'] = ['WSRoute=owned-websocket-affinity; Path=/; HttpOnly; SameSite=Lax']; });
    await new Promise<void>((resolve, reject) => {
      server.http.once('error', reject); server.http.listen(address.port, '127.0.0.1', resolve);
    });
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  }, 30_000);
  afterAll(async () => { await server?.close(); await database?.close(); });
  afterEach(() => { intercept = null; socketRedirect = null; });
  function setup() {
    vi.stubEnv('RIVER_ROOM_HOST_KEY', hostKey);
    requests.length = 0; upgrades.length = 0;
    const identity = store.createIdentity.bind(store);
    vi.spyOn(store, 'createIdentity').mockImplementation(async name => {
      const result = await identity(name);
      secrets.add(result.token); secrets.add(result.user.csrf); secrets.add(result.recoveryCode);
      return result;
    });
    return options(base);
  }
  async function secretFreeReport(output: string) {
    const text = await readFile(output, 'utf8');
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"recoveryCode"|"csrf"|"hostKey"|"revealed"|"cards"|"code"\s*:\s*"[A-Z2-9]{8}"/);
    return JSON.parse(text);
  }

  test('completes two-player PLO, private live/reconnected views, split runouts, idempotency, cash-out, audit and exports', async () => {
    const input = setup();
    const hook = vi.fn(async (context: { endpoint: string; roomId: string; signal: AbortSignal }) => {
      expect(context.endpoint).toBe(base);
      expect(context.signal.aborted).toBe(false);
      const saved = await store.getRoom(context.roomId);
      expect(saved.hand).toBeNull(); expect(saved.players.map(player => player.stack)).toEqual([500, 500]);
      expect(Object.keys(context).sort()).toEqual(['endpoint', 'roomId', 'signal']);
    });
    const report = await verifyDeployment({ ...input, afterFunding: hook });
    expect(report.error).toBeUndefined();
    expect(report).toMatchObject({
      status: 'passed', syntheticData: true, realPayments: false, endpoint: base,
      transport: 'explicit-loopback-http-and-ws',
      counts: { authenticatedPlayers: 2, roomsCreated: 1, duplicateReplays: 1, reconnects: 1, runoutVotes: 2, handsCompleted: 1,
        chipsFunded: 1000, chipsCashedOut: 1000, bountyTransfers: 0, jsonExports: 2, csvExports: 1, revokedSessions: 2,
        socketConnections: 3, socketSubscriptions: 3 },
      session: { status: 'closed', pauseAttempted: false },
      completion: { failed: 0, skipped: 0, notRun: 0 },
      persistenceHook: { requested: true, completed: true, stateRechecked: true, restartPerformedByVerifier: false },
    });
    expect(report.completion.passed).toBe(report.checks.length);
    expect(report.counts.httpRequests).toBeLessThanOrEqual(report.limits.requests);
    expect(report.counts.commandAttempts).toBeLessThanOrEqual(report.limits.commands);
    expect(report.counts.socketViews).toBeGreaterThanOrEqual(10);
    expect(hook).toHaveBeenCalledOnce();
    expect(requests.filter(request => request.path === '/api/auth/guest')).toHaveLength(2);
    expect(requests.every(request => request.origin === base)).toBe(true);
    expect(upgrades).toHaveLength(3);
    for (const upgrade of upgrades) {
      expect(upgrade.origin).toBe(base);
      expect(upgrade.cookie).toContain('ARRAffinity=owned-http-affinity');
      expect(upgrade.cookie).toMatch(/(?:^|; )river-session=[A-Za-z0-9_-]{43}/);
    }
    expect(upgrades[2]!.cookie).toContain('WSRoute=owned-websocket-affinity');
    expect(requests.some(request => request.path.endsWith('/commands') && request.cookie.includes('WSRoute=owned-websocket-affinity'))).toBe(true);
    const saved = await store.getRoom(report.session.roomId!);
    expect(saved).toMatchObject({ status: 'closed', handNumber: 1, hand: { runoutCount: 2, rules: { game: 'omaha', maxRunouts: 3 } } });
    expect(saved.players.every(player => player.stack === 0)).toBe(true);
    expect(saved.players.reduce((sum, player) => sum + player.cashOuts, 0)).toBe(1000);
    expect((await store.hands(saved.id)).entries).toHaveLength(1);
    expect((await store.verifyAudit(saved.id)).valid).toBe(true);
    expect(await secretFreeReport(input.output!)).toEqual(report);
    expect(await readFile(input.output!, 'utf8')).not.toContain(saved.code);
  }, 30_000);

  test('a failed awaited hook reports failure, preserves funding/history, and only pauses its own room', async () => {
    const input = setup();
    const executed: Command[] = [];
    const execute = store.execute.bind(store);
    vi.spyOn(store, 'execute').mockImplementation(async (...args) => { executed.push(args[3]); return execute(...args); });
    let fundedId = '';
    const sensitiveError = `secret=${hostKey}; recoveryCode=RR-private; Cookie=opaque; private cards=Ac,As`;
    const report = await verifyDeployment({ ...input, afterFunding: async context => {
      fundedId = context.roomId; executed.length = 0; throw new Error(sensitiveError);
    } });
    expect(report).toMatchObject({
      status: 'failed', error: { code: 'hook_failed', check: 'afterFunding' },
      session: { roomId: fundedId, status: 'paused', pauseAttempted: true, pauseVerified: true },
      completion: { failed: 1 },
      persistenceHook: { requested: true, completed: false, restartPerformedByVerifier: false },
    });
    expect(executed).toEqual([{ type: 'pause', value: true }]);
    const saved = await store.getRoom(fundedId);
    expect(saved).toMatchObject({ status: 'open', paused: true, hand: null });
    expect(saved.players.map(player => [player.stack, player.cashOuts])).toEqual([[500, 0], [500, 0]]);
    expect((await store.ledger(fundedId)).entries).toHaveLength(2);
    expect((await store.verifyAudit(fundedId)).valid).toBe(true);
    expect(await secretFreeReport(input.output!)).toEqual(report);
    expect(await readFile(input.output!, 'utf8')).not.toContain(sensitiveError);
  });

  test('the complete basic smoke needs no hook and never claims a restart was tested', async () => {
    const input = setup();
    const report = await verifyDeployment(input);
    expect(report.error).toBeUndefined();
    expect(report).toMatchObject({
      status: 'passed', session: { status: 'closed' },
      completion: { failed: 0, skipped: 1, notRun: 0 },
      persistenceHook: { requested: false, completed: false, stateRechecked: false, restartPerformedByVerifier: false },
      counts: { authenticatedPlayers: 2, handsCompleted: 1, chipsFunded: 1000, chipsCashedOut: 1000, revokedSessions: 2 },
    });
    expect(report.checks.find(check => check.id === 'afterFunding')?.status).toBe('skipped');
    expect(report.counts.httpRequests).toBeLessThan(100);
    expect(await secretFreeReport(input.output!)).toEqual(report);
  });

  test('an actual opposing-card socket leak fails privately and pauses rather than continuing to play', async () => {
    const input = setup();
    let dealt: Room | null = null;
    const execute = store.execute.bind(store);
    vi.spyOn(store, 'execute').mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[3].type === 'deal') dealt = structuredClone(result.room);
      return result;
    });
    const corrupt = (socket: ServerSocket) => socket.onAnyOutgoing((event: string, view: RoomView) => {
      if (event !== 'room' || !dealt?.hand) return;
      const opponent = view.players.find(player => player.id !== view.youId)!;
      opponent.cards = [...dealt.hand.holeCards[opponent.id]!];
    });
    server.io.on('connection', corrupt);
    try {
      const report = await verifyDeployment(input);
      expect(report).toMatchObject({
        status: 'failed', error: { code: 'contract_mismatch', check: 'livePrivacy' },
        session: { status: 'paused', pauseVerified: true }, counts: { runoutVotes: 0, handsCompleted: 0 },
      });
      const saved = await store.getRoom(report.session.roomId!);
      expect(saved.hand?.street).toBe('preflop'); expect(saved.hand?.deadline).toBeNull();
      const text = await readFile(input.output!, 'utf8');
      for (const cards of Object.values(saved.hand!.holeCards))
        for (const card of cards) expect(text).not.toContain(JSON.stringify(card));
      expect(await secretFreeReport(input.output!)).toEqual(report);
    } finally { server.io.off('connection', corrupt); }
  });

  test('an overall timeout cancels the hook and reserves enough time for a verified safe pause', async () => {
    const input = setup();
    let entered = false;
    const started = performance.now();
    const report = await verifyDeployment({
      ...input, timeoutMs: 3000, requestTimeoutMs: 500,
      afterFunding: async ({ signal }) => {
        entered = true;
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    expect(entered).toBe(true);
    expect(report).toMatchObject({
      status: 'failed', error: { code: 'overall_timeout', check: 'afterFunding' },
      session: { status: 'paused', pauseVerified: true },
      persistenceHook: { requested: true, completed: false, stateRechecked: false },
    });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(await secretFreeReport(input.output!)).toEqual(report);
  });

  test('unexpected WebSocket redirects are not followed and cause a safe pause with null active timers', async () => {
    const input = setup();
    let reached = 0;
    const target = createHttpServer((_request, response) => { reached++; response.end('must never be reached'); });
    target.on('upgrade', (_request, socket) => { reached++; socket.end(); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const address = target.address(); assert(address && typeof address !== 'string');
    socketRedirect = `ws://127.0.0.1:${address.port}/socket.io/`;
    try {
      const report = await verifyDeployment(input);
      expect(report).toMatchObject({
        status: 'failed', error: { code: 'socket_connect_failed', check: 'livePrivacy' },
        session: { status: 'paused', pauseVerified: true },
      });
      expect(reached).toBe(0);
      const saved = await store.getRoom(report.session.roomId!);
      expect(saved.hand).toMatchObject({ street: 'preflop', deadline: null, pot: 200 });
      expect(saved.paused).toBe(true); expect(saved.nextHandAt).toBeNull();
      expect((await store.ledger(saved.id)).entries.filter(entry => entry.kind === 'cash_out')).toHaveLength(0);
      expect(await secretFreeReport(input.output!)).toEqual(report);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
    }
  });

  test('redirects on host creation never resend the host key, cookies, or CSRF to another origin', async () => {
    const input = setup();
    let reached = 0;
    const target = createHttpServer((_request, response) => { reached++; response.end('must never be reached'); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const address = target.address(); assert(address && typeof address !== 'string');
    intercept = (request, response) => {
      if (request.url !== '/api/rooms' || request.method !== 'POST') return false;
      response.statusCode = 307; response.setHeader('Location', `http://127.0.0.1:${address.port}/capture`);
      response.end(); return true;
    };
    try {
      const report = await verifyDeployment(input);
      expect(report).toMatchObject({
        status: 'failed', error: { code: 'redirect_rejected', check: 'funding' },
        session: { status: 'creation_unconfirmed', pauseAttempted: false }, counts: { authenticatedPlayers: 2, roomsCreated: 0 },
      });
      expect(reached).toBe(0);
      expect(await secretFreeReport(input.output!)).toEqual(report);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
    }
  });

  test('a health 200 never masks missing UI, and body failures/timeouts stay bounded without auth churn', async () => {
    vi.stubEnv('RIVER_ROOM_HOST_KEY', hostKey);
    for (const scenario of ['html', 'body', 'timeout'] as const) {
      requests.length = 0;
      intercept = (request, response) => {
        if (scenario === 'html' && request.url === '/') {
          response.setHeader('Content-Type', 'text/html'); response.end('<title>River Room</title>not an application'); return true;
        }
        if (scenario !== 'html' && request.url === '/health/ready') {
          response.setHeader('Content-Type', 'application/json');
          response.write(scenario === 'body' ? 'x'.repeat(2 * 1024 * 1024 + 1) : '{"status":');
          if (scenario === 'body') response.end();
          else {
            const timer = setTimeout(() => response.end(), 2000);
            response.on('close', () => clearTimeout(timer));
          }
          return true;
        }
        return false;
      };
      const input = options(base, { requestTimeoutMs: 200, timeoutMs: 2000 });
      const before = performance.now();
      const report = await verifyDeployment(input);
      expect(report.status).toBe('failed');
      expect(report.error?.code).toBe(scenario === 'html' ? 'contract_mismatch' : scenario === 'body' ? 'response_limit' : 'request_timeout');
      expect(report.counts.authenticatedPlayers).toBe(0);
      expect(report.session.status).toBe('not_created');
      expect(requests.some(request => request.path === '/api/auth/guest')).toBe(false);
      expect(performance.now() - before).toBeLessThan(2000);
    }
  });

  test('CLI rejects secret arguments and returns a nonzero status with a sanitized report on real HTTP failure', async () => {
    const output = join(directory, 'cli-failure.json');
    const run = (args: string[]) => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(project, 'src', 'testing', 'verify-deployment.ts'), ...args], {
        cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RIVER_ROOM_HOST_KEY: hostKey },
      });
      let text = ''; child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Owned verifier CLI exceeded its test timeout.')); }, 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, text }); });
    });
    const invalid = await run([`--host-key=${hostKey}`]);
    expect(invalid.code).toBe(1); expect(invalid.text).not.toContain(hostKey);
    intercept = (request, response) => {
      if (request.url !== '/health/ready') return false;
      response.statusCode = 503; response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: `server accidentally echoed ${hostKey}` })); return true;
    };
    const failed = await run(['--url', base, '--allow-local-http', '--output', output]);
    expect(failed.code).toBe(1); expect(failed.text).toContain(output); expect(failed.text).not.toContain(hostKey);
    expect(await secretFreeReport(output)).toMatchObject({ status: 'failed', error: { code: 'unexpected_http_status', httpStatus: 503 } });
  });
});
