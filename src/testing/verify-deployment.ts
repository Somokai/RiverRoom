import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_SETTINGS, defaultHandRules,
  type AuditRow, type Command, type HandHistory, type Identity, type LedgerRow, type RoomSummary, type RoomView,
} from '../shared/model.js';
import { canonical, digest } from '../server/store.js';
import { assertAccounting, assertPrivateView } from './run-bots.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const MAX_REQUESTS = 100;
const MAX_COMMANDS = 32;
const CLEANUP_REQUESTS = 6;
const MAX_CONNECTIONS = 6;
const MAX_SOCKET_VIEWS = 128;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 4;
const checks = {
  configuration: 'Explicit origin, bounded execution, environment-only host key, and verified TLS policy',
  readiness: 'Database readiness, not just HTTP liveness',
  client: 'River Room HTML, React mount, and its same-origin JavaScript entrypoint',
  authentication: 'Two synthetic identities, session cookie policy, and authenticated identity round trips',
  funding: 'One private two-seat room, 500-chip minimum, pending guest funding, and host approval',
  idempotency: 'Replayed approval changes neither version, funding, ledger, nor audit',
  afterFunding: 'Optional awaited caller hook followed by authenticated funding/persistence checks',
  nextHand: 'Host selects four-card PLO, a mandatory 25-chip round ante, and up to three runouts',
  livePrivacy: 'Actual private WebSocket deliveries, HTTP/export privacy, and a fresh socket reconnect',
  potLimit: '50/100 PLO with 25-chip antes rejects a raise above 350; raise 350, all-in 475, call',
  runouts: 'Two live participants consent up to two versus three; exactly two runouts result',
  settlement: 'Actual distinct boards, pot awards, and separate chip/bounty ledger reconciliation',
  cashOut: 'Both synthetic stacks fully cashed out and the session durably closed',
  records: 'Read-only stored history, independently recomputed audit chain, and JSON/CSV exports',
  logout: 'Both synthetic authentication sessions revoked after records are verified',
} as const;
type CheckId = keyof typeof checks;

class ProbeFailure extends Error {
  constructor(public code: string, message: string, public httpStatus?: number) { super(message); }
}
function failure(code: string, message: string): never { throw new ProbeFailure(code, message); }
function safeFailure(error: unknown): { code: string; message: string; httpStatus?: number } {
  // Assertion diffs, transport errors, server bodies, and caller hooks can contain secrets or private cards.
  return error instanceof ProbeFailure
    ? { code: error.code, message: error.message, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
    : { code: 'contract_mismatch', message: 'A response did not satisfy the deployment contract; sensitive diagnostic details were omitted.' };
}

export interface FundingHookContext {
  endpoint: string;
  roomId: string;
  signal: AbortSignal;
}
export interface DeploymentOptions {
  url: string;
  allowLocalHttp?: boolean;
  output?: string;
  requestTimeoutMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Caller must await any external restart/readiness and honor signal. No credentials are passed to the hook. */
  afterFunding?: (context: FundingHookContext) => Promise<void>;
}
interface NormalizedOptions extends DeploymentOptions {
  output: string;
  requestTimeoutMs: number;
  timeoutMs: number;
}
export interface DeploymentReport {
  status: 'passed' | 'failed';
  syntheticData: true;
  realPayments: false;
  endpoint: string;
  transport: 'https-and-wss' | 'explicit-loopback-http-and-ws';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limits: { requests: number; commands: number; socketConnections: number; socketViews: number; requestTimeoutMs: number; overallTimeoutMs: number; cleanupReserveMs: number };
  checks: Array<{ id: CheckId; description: string; status: 'not_run' | 'passed' | 'failed' | 'skipped' }>;
  completion: { passed: number; failed: number; skipped: number; notRun: number };
  counts: {
    httpRequests: number; httpResponses: number; commandAttempts: number; commandsAccepted: number; expectedRejections: number;
    authenticatedPlayers: number; roomsCreated: number; privateHttpViews: number; socketConnections: number; socketSubscriptions: number;
    socketViews: number; reconnects: number; duplicateReplays: number; runoutVotes: number; handsCompleted: number;
    ledgerCheckpoints: number; ledgerEntries: number; auditRecords: number; jsonExports: number; csvExports: number;
    chipsFunded: number; chipsCashedOut: number; bountyTransfers: number; revokedSessions: number;
  };
  session: {
    roomId?: string;
    status: 'not_created' | 'creation_unconfirmed' | 'open' | 'paused' | 'closed' | 'unknown';
    pauseAttempted: boolean;
    pauseVerified: boolean;
    cleanupFailure?: ReturnType<typeof safeFailure>;
  };
  persistenceHook: { requested: boolean; completed: boolean; stateRechecked: boolean; restartPerformedByVerifier: false };
  error?: ReturnType<typeof safeFailure> & { check: CheckId };
}

export function validateDeploymentOrigin(input: string, allowLocalHttp = false): string {
  if (typeof input !== 'string' || input.length > 2048 || !/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(input))
    failure('invalid_url', 'Supply --url as an explicit HTTPS origin without credentials, path, query, or fragment.');
  let url: URL;
  try { url = new URL(input); }
  catch { return failure('invalid_url', 'Supply a valid HTTPS origin.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    failure('invalid_url', 'The deployment URL must contain only an origin.');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalHttp === true && url.protocol === 'http:' && loopback))
    failure('insecure_origin', 'HTTPS is required; --allow-local-http permits only an explicit loopback HTTP origin.');
  return url.origin;
}
function normalizeOptions(options: DeploymentOptions): NormalizedOptions {
  const allowed = ['url', 'allowLocalHttp', 'output', 'requestTimeoutMs', 'timeoutMs', 'signal', 'afterFunding'];
  if (Object.keys(options).some(key => !allowed.includes(key)))
    failure('invalid_options', 'Unsupported verifier option. Host keys are accepted only through RIVER_ROOM_HOST_KEY.');
  const url = validateDeploymentOrigin(options.url, options.allowLocalHttp);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30_000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000 || requestTimeoutMs >= timeoutMs)
    failure('invalid_timeouts', 'Request timeout must be 100–30000 ms and less than an overall timeout of 1000–600000 ms.');
  const output = resolve(project, options.output ?? join('.artifacts', 'azure-verification.json'));
  if (!output.toLowerCase().endsWith('.json') || output.split(/[\\/]/).some(part => /^(?:\.data|\.env.*|backups?|dist)$/i.test(part)) ||
      ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json'].some(name => output === resolve(project, name)))
    failure('invalid_output', 'Choose a .json report path outside application data, backups, build output, and configuration files.');
  return { ...options, url, requestTimeoutMs, timeoutMs, output };
}
export function deploymentOptionsFrom(args: string[]): DeploymentOptions {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      url: { type: 'string' }, 'allow-local-http': { type: 'boolean', default: false },
      output: { type: 'string' }, 'request-timeout-seconds': { type: 'string', default: '10' },
      'timeout-seconds': { type: 'string', default: '180' },
    } }));
  } catch {
    return failure('invalid_arguments', 'Use --url, --output, --allow-local-http, --request-timeout-seconds, or --timeout-seconds. Supply the host key only through RIVER_ROOM_HOST_KEY.');
  }
  return normalizeOptions({
    url: values.url ?? '', output: values.output, allowLocalHttp: values['allow-local-http'],
    requestTimeoutMs: Number(values['request-timeout-seconds']) * 1000, timeoutMs: Number(values['timeout-seconds']) * 1000,
  });
}

interface Cookie {
  name: string; value: string; path: string; domain: string; hostOnly: boolean;
  secure: boolean; httpOnly: boolean; sameSite: string; expires: number | null;
}
/** A bounded, single-origin jar, including proxy affinity cookies; values are never serializable. */
export class OriginCookieJar {
  #cookies = new Map<string, Cookie>();
  #origin: URL;
  constructor(origin: string) { this.#origin = new URL(validateDeploymentOrigin(origin, true)); }
  private target(input: string): URL {
    const target = new URL(input);
    if (target.protocol === 'wss:') target.protocol = 'https:';
    if (target.protocol === 'ws:') target.protocol = 'http:';
    if (target.origin !== this.#origin.origin || target.username || target.password)
      failure('cookie_origin', 'Credentials cannot be used outside the configured origin.');
    return target;
  }
  accept(headers: Headers, requestUrl: string) {
    const target = this.target(requestUrl);
    for (const line of headers.getSetCookie()) {
      if (Buffer.byteLength(line) > 4096) failure('cookie_limit', 'A response cookie exceeded the verifier limit.');
      const parts = line.split(';').map(part => part.trim());
      const pair = parts.shift() ?? '';
      const equals = pair.indexOf('=');
      const name = pair.slice(0, equals); const value = pair.slice(equals + 1);
      if (equals < 1 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
          !/^(?:"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"|[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*)$/.test(value))
        failure('invalid_cookie', 'A response contained a malformed cookie.');
      const attributes = new Map(parts.map(part => {
        const i = part.indexOf('=');
        return [part.slice(0, i < 0 ? undefined : i).toLowerCase(), i < 0 ? '' : part.slice(i + 1)] as const;
      }));
      const hostOnly = !attributes.has('domain');
      const domain = (attributes.get('domain') ?? target.hostname).replace(/^\./, '').toLowerCase();
      const matchesDomain = domain === target.hostname || target.hostname.endsWith(`.${domain}`);
      const defaultPath = target.pathname.slice(0, target.pathname.lastIndexOf('/')) || '/';
      const path = attributes.get('path')?.startsWith('/') ? attributes.get('path')! : defaultPath;
      const secure = attributes.has('secure'); const httpOnly = attributes.has('httponly');
      const sameSite = (attributes.get('samesite') ?? '').toLowerCase();
      if (name.startsWith('__Host-') && (!secure || !hostOnly || attributes.get('path') !== '/'))
        failure('unsafe_cookie', 'A __Host cookie must be Secure, host-only, and explicitly scoped to /.');
      if (!matchesDomain || (secure && target.protocol !== 'https:')) continue;
      let expires: number | null = null;
      const age = attributes.get('max-age');
      if (age !== undefined && /^-?\d+$/.test(age)) expires = Date.now() + Number(age) * 1000;
      else if (attributes.has('expires')) {
        const date = Date.parse(attributes.get('expires')!);
        if (Number.isFinite(date)) expires = date;
      }
      const key = `${name}\n${domain}\n${path}`;
      if (expires !== null && expires <= Date.now()) { this.#cookies.delete(key); continue; }
      this.#cookies.set(key, { name, value, path, domain, hostOnly, secure, httpOnly, sameSite, expires });
      if (this.#cookies.size > 32) failure('cookie_limit', 'Too many response cookies were returned.');
      if (name === '__Host-river-session' || name === 'river-session') this.assertSession();
    }
  }
  header(input: string): string {
    const target = this.target(input);
    for (const [key, cookie] of this.#cookies)
      if (cookie.expires !== null && cookie.expires <= Date.now()) this.#cookies.delete(key);
    const result = [...this.#cookies.values()].filter(cookie =>
      (!cookie.secure || target.protocol === 'https:') &&
      (target.pathname === cookie.path || (target.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || target.pathname[cookie.path.length] === '/'))),
    ).sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (Buffer.byteLength(result) > 16_384) failure('cookie_limit', 'The cookie header exceeded the verifier limit.');
    return result;
  }
  assertSession() {
    this.header(this.#origin.href);
    const secure = this.#origin.protocol === 'https:';
    const name = secure ? '__Host-river-session' : 'river-session';
    const sessions = [...this.#cookies.values()].filter(cookie => cookie.name === name);
    const session = sessions[0];
    if (sessions.length !== 1 || !session || !/^[A-Za-z0-9_-]{43}$/.test(session.value))
      failure('missing_session', 'Guest authentication did not issue the expected opaque session cookie.');
    if (!session.httpOnly || !['lax', 'strict'].includes(session.sameSite) || session.path !== '/' ||
        !session.hostOnly || (secure && !session.secure))
      failure('unsafe_session', 'The session cookie must be HttpOnly, SameSite=Lax/Strict, host-only, and scoped to /; HTTPS also requires Secure.');
  }
  clear() { this.#cookies.clear(); }
}

type RequestMode = 'work' | 'cleanup';
class RunContext {
  fault: ProbeFailure | null = null;
  cleanupSignal: AbortSignal | null = null;
  constructor(
    public options: NormalizedOptions, public report: DeploymentReport, public signal: AbortSignal,
    private abort: AbortController,
  ) {}
  healthy(mode: RequestMode = 'work') {
    if (mode === 'work' && this.fault) throw this.fault;
    if ((mode === 'work' ? this.signal : this.cleanupSignal)?.aborted)
      failure('overall_timeout', mode === 'work' ? 'Verification was cancelled or reached its overall time budget.' : 'The bounded cleanup time budget expired.');
  }
  fail(error: unknown) {
    const safe = safeFailure(error);
    this.fault ??= new ProbeFailure(safe.code, safe.message, safe.httpStatus);
    this.abort.abort();
  }
  async wait<T>(read: () => T | undefined, listen: (notify: () => void) => () => void): Promise<T> {
    this.healthy();
    return new Promise<T>((done, reject) => {
      let unlisten = () => {};
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer); unlisten(); this.signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else done(value!);
      };
      const cancelled = () => finish(this.fault ?? new ProbeFailure('overall_timeout', 'Verification was cancelled or reached its overall time budget.'));
      const inspect = () => {
        try { this.healthy(); const value = read(); if (value !== undefined) finish(undefined, value); }
        catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new ProbeFailure('socket_timeout', 'A real WebSocket connection, subscription, or room delivery timed out.')), this.options.requestTimeoutMs);
      this.signal.addEventListener('abort', cancelled, { once: true });
      unlisten = listen(inspect);
      inspect();
    });
  }
}

class ProbeClient {
  user: Identity | null = null;
  readonly jar: OriginCookieJar;
  private socket: Socket | null = null;
  private last: RoomView | null = null;
  private roomId = '';
  private listeners = new Set<() => void>();
  constructor(private context: RunContext) { this.jar = new OriginCookieJar(context.options.url); }
  async request(path: string, body?: object, expectedStatus = 200, mode: RequestMode = 'work'): Promise<{ text: string; headers: Headers }> {
    const ctx = this.context; ctx.healthy(mode);
    const url = new URL(path, ctx.options.url);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== ctx.options.url || url.username || url.password)
      failure('request_origin', 'A request attempted to leave the configured origin.');
    const counts = ctx.report.counts;
    if (counts.httpRequests >= MAX_REQUESTS - (mode === 'work' ? CLEANUP_REQUESTS : 0))
      failure('request_limit', 'The bounded HTTP request limit was reached.');
    const command = body !== undefined && !path.startsWith('/api/auth/');
    if (command && counts.commandAttempts >= MAX_COMMANDS - (mode === 'work' ? 2 : 0))
      failure('command_limit', 'The bounded command limit was reached.');
    counts.httpRequests++;
    if (command) counts.commandAttempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.options.requestTimeoutMs);
    const signal = AbortSignal.any([mode === 'work' ? ctx.signal : ctx.cleanupSignal!, controller.signal]);
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal,
        headers: {
          Origin: ctx.options.url, Cookie: this.jar.header(url.href),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.user ? { 'X-CSRF-Token': this.user.csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      counts.httpResponses++;
      if (response.status >= 300 && response.status < 400)
        failure('redirect_rejected', 'Redirects are forbidden; no redirected request or credentials were sent.');
      this.jar.accept(response.headers, url.href);
      if (response.status !== expectedStatus)
        throw new ProbeFailure('unexpected_http_status', 'An endpoint returned an unexpected HTTP status; its body was not reported.', response.status);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) failure('response_limit', 'A response exceeded the bounded body size.');
        chunks.push(value);
      }
      ctx.healthy(mode);
      if (expectedStatus >= 400) counts.expectedRejections++;
      else if (command) counts.commandsAccepted++;
      return { text: Buffer.concat(chunks).toString('utf8'), headers: response.headers };
    } catch (error) {
      ctx.healthy(mode);
      if (error instanceof ProbeFailure) throw error;
      if (controller.signal.aborted) failure('request_timeout', 'An HTTP request or response body exceeded its timeout.');
      return failure('network_error', 'An HTTP/TLS request failed; transport details were omitted to protect credentials.');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async json<T>(path: string, body?: object, expectedStatus = 200, mode: RequestMode = 'work'): Promise<T> {
    const result = await this.request(path, body, expectedStatus, mode);
    if (!result.headers.get('content-type')?.toLowerCase().includes('application/json'))
      failure('invalid_json', 'An API response was not JSON.');
    try { return JSON.parse(result.text) as T; }
    catch { return failure('invalid_json', 'An API response contained malformed JSON.'); }
  }
  checked(room: RoomView): RoomView {
    assertPrivateView(room, this.user!.id);
    if (this.roomId) assert.equal(room.id, this.roomId, 'A private view belongs to another room.');
    this.context.report.counts.privateHttpViews++;
    return room;
  }
  async register(name: string) {
    const result = await this.json<{ user: Identity }>('/api/auth/guest', { name });
    assert(result.user && /^[0-9a-f-]{36}$/.test(result.user.id) && /^[A-Za-z0-9_-]{32}$/.test(result.user.csrf));
    assert.equal(result.user.name, name);
    this.user = { id: result.user.id, name: result.user.name, csrf: result.user.csrf };
    this.jar.assertSession();
    await this.identity();
    this.context.report.counts.authenticatedPlayers++;
  }
  async identity() {
    const result = await this.json<{ user: Identity | null; hostKeyRequired: boolean }>('/api/me');
    assert.deepEqual(result.user, this.user);
    assert.equal(result.hostKeyRequired, true, 'The deployment must require a host-creation key.');
    this.jar.assertSession();
  }
  async room(id: string) { return this.checked((await this.json<{ room: RoomView }>(`/api/rooms/${id}`)).room); }
  async command(room: RoomView, command: Command, commandId = randomUUID()) {
    const result = await this.json<{ room: RoomView; duplicate: boolean }>(`/api/rooms/${room.id}/commands`,
      { commandId, expectedVersion: room.version, command });
    this.checked(result.room);
    assert.equal(typeof result.duplicate, 'boolean');
    return result;
  }
  async rejectCommand(room: RoomView, command: Command, status: number) {
    await this.request(`/api/rooms/${room.id}/commands`, { commandId: randomUUID(), expectedVersion: room.version, command }, status);
  }
  private notify() { for (const listener of [...this.listeners]) listener(); }
  async connect(id: string): Promise<RoomView> {
    const ctx = this.context; ctx.healthy();
    this.disconnect(); this.roomId = id;
    if (++ctx.report.counts.socketConnections > MAX_CONNECTIONS) failure('socket_limit', 'The bounded socket connection limit was reached.');
    const socketUrl = new URL('/socket.io/', ctx.options.url);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    // The Node websocket-only transport uses ws's non-following redirect policy, with no polling fallback.
    const socket = io(ctx.options.url, {
      forceNew: true, autoConnect: false, transports: ['websocket'], reconnection: false,
      timeout: ctx.options.requestTimeoutMs, rejectUnauthorized: true,
      transportOptions: { websocket: { maxPayload: MAX_BODY_BYTES } },
      auth: { csrf: this.user!.csrf }, extraHeaders: { Cookie: this.jar.header(socketUrl.href), Origin: ctx.options.url },
    });
    this.socket = socket; let subscribed = false;
    socket.on('room', (room: RoomView) => {
      try {
        assert.equal(room.id, id);
        assertPrivateView(room, this.user!.id);
        if (++ctx.report.counts.socketViews > MAX_SOCKET_VIEWS) failure('socket_limit', 'The bounded socket delivery limit was reached.');
        if (!this.last || room.version >= this.last.version) this.last = room;
        this.notify();
      } catch (error) { ctx.fail(error); }
    });
    socket.on('connect_error', () => ctx.fail(new ProbeFailure('socket_connect_failed', 'The authenticated WebSocket connection failed; server details were omitted.')));
    socket.on('server_error', () => ctx.fail(new ProbeFailure('socket_server_error', 'The server reported a live-delivery failure.')));
    socket.on('disconnect', () => ctx.fail(new ProbeFailure('socket_disconnected', 'An established probe socket disconnected unexpectedly.')));
    socket.on('connect', () => {
      if (socket.io.engine.transport.name !== 'websocket') {
        ctx.fail(new ProbeFailure('socket_transport', 'The probe did not establish the required WebSocket transport.')); return;
      }
      socket.emit('subscribe', id, (ack: { ok: boolean }) => {
        if (ack?.ok !== true) { ctx.fail(new ProbeFailure('socket_subscription', 'The authenticated room subscription was rejected.')); return; }
        subscribed = true; ctx.report.counts.socketSubscriptions++; this.notify();
      });
    });
    try {
      socket.connect();
      const transport = socket.io.engine.transport as unknown as {
        ws: { url: string; once: (event: 'upgrade', handler: (response: IncomingMessage) => void) => void };
      };
      assert.equal(new URL(transport.ws.url).origin, socketUrl.origin);
      transport.ws.once('upgrade', response => {
        try {
          const headers = new Headers();
          for (const cookie of response.headers['set-cookie'] ?? []) headers.append('set-cookie', cookie);
          this.jar.accept(headers, socketUrl.href);
        } catch (error) { ctx.fail(error); }
      });
      return await ctx.wait(
        () => subscribed && socket.connected && this.last ? this.last : undefined,
        notify => { this.listeners.add(notify); return () => this.listeners.delete(notify); },
      );
    } catch (error) { this.disconnect(); throw error; }
  }
  async viewAt(version: number): Promise<RoomView> {
    return this.context.wait(() => this.last && this.last.version >= version ? this.last : undefined,
      notify => { this.listeners.add(notify); return () => this.listeners.delete(notify); });
  }
  connectionId() { return this.socket?.id; }
  disconnect() {
    this.socket?.removeAllListeners(); this.socket?.disconnect(); this.socket = null; this.last = null;
  }
  discard() { this.disconnect(); this.jar.clear(); this.user = null; }
}

async function pages<T>(client: ProbeClient, roomId: string, kind: 'ledger' | 'audit' | 'hands'): Promise<T[]> {
  const result: T[] = []; let cursor: number | null = null;
  const seen = new Set<number>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const response: { entries: T[]; nextCursor: number | null } = await client.json(
      `/api/rooms/${roomId}/${kind}${cursor === null ? '' : `?before=${cursor}`}`,
    );
    assert(Array.isArray(response.entries) && response.entries.length <= 100);
    result.push(...response.entries);
    if (response.nextCursor === null) return result;
    assert(Number.isSafeInteger(response.nextCursor) && response.nextCursor > 0 &&
      !seen.has(response.nextCursor) && (cursor === null || response.nextCursor < cursor));
    seen.add(response.nextCursor); cursor = response.nextCursor;
  }
  return failure('pagination_limit', 'A synthetic room exceeded the bounded records pagination limit.');
}
function hiddenViews(left: RoomView, right: RoomView) {
  assert.notEqual(left.youId, right.youId);
  for (const [own, other] of [[left, right], [right, left]] as const) {
    assert(own.hand && own.hand.street !== 'complete');
    assert.deepEqual(own.hand.revealed, {});
    const cards = own.players.find(player => player.id === own.youId)!.cards;
    assert.equal(cards.length, 4);
    assert(cards.every(card => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card)));
    for (const card of cards) assert(!JSON.stringify(other).includes(JSON.stringify(card)), 'An opposing private card appeared outside the allowed viewer projection.');
  }
}
function noSecretState(value: unknown) {
  const text = JSON.stringify(value);
  for (const key of ['deck', 'burned', 'holeCards', 'csrf', 'recoveryCode', 'token', 'hostKey'])
    assert(!text.includes(`"${key}":`), 'An export contains private server or authentication state.');
}
function historyOf(room: RoomView): HandHistory {
  const hand = room.hand!;
  return {
    id: hand.id, number: hand.number, board: hand.board, rules: hand.rules, boards: hand.boards,
    runoutBoards: hand.runoutBoards, runoutCount: hand.runoutCount, bounty: hand.bounty, showdown: hand.showdown,
    buttonSeat: hand.buttonSeat, pot: hand.awardedPot, completedAt: hand.completedAt!, results: hand.results,
    revealed: hand.revealed, balanceAfter: hand.balanceAfter, bountyAfter: hand.bountyAfter,
  };
}
function assertSettlement(room: RoomView) {
  const hand = room.hand!;
  assert.equal(hand.street, 'complete'); assert.equal(hand.showdown, true);
  assert.equal(hand.rules.game, 'omaha'); assert.equal(hand.rules.maxRunouts, 3);
  assert.equal(hand.runoutCount, 2); assert.equal(hand.runoutVote, null); assert.equal(hand.pot, 0);
  assert.equal(hand.awardedPot, 1000); assert.deepEqual(hand.runoutPrefix, [[]]);
  assert.equal(hand.runoutBoards.length, 2); assert.deepEqual(hand.boards, hand.runoutBoards[0]);
  assert.deepEqual(hand.board, hand.boards[0]);
  const cards: string[] = [];
  for (const boards of hand.runoutBoards) {
    assert.equal(boards.length, 1); assert.equal(boards[0]!.length, 5); cards.push(...boards[0]!);
  }
  assert.deepEqual(Object.keys(hand.revealed).sort(), room.players.map(player => player.id).sort());
  for (const player of room.players) {
    assert.equal(hand.revealed[player.id]!.length, 4); cards.push(...hand.revealed[player.id]!);
    assert.equal(hand.balanceAfter[player.id], player.stack);
    assert.equal(player.bountyNet, 0); assert.equal(hand.bountyAfter[player.id], 0);
    assert.equal(player.chipNet, player.stack - 500); assert.equal(player.net, player.chipNet);
  }
  assert(cards.every(card => /^[2-9TJQKA][cdhs]$/.test(card)));
  assert.equal(new Set(cards).size, 18, 'Runouts reused community or private cards.');
  assert.equal(hand.bounty, null, 'PLO must not award a Holdem seven-deuce bounty.');
  assert.deepEqual(hand.players.map(player => player.committed), [500, 500]);
  assert.equal(hand.results.length, 2);
  for (let index = 0; index < 2; index++) {
    const result = hand.results[index]!;
    assert.equal(result.runoutIndex, index); assert.equal(result.boardIndex, 0); assert.equal(result.potIndex, 0);
    assert.equal(result.amount, 500);
    assert.deepEqual([...result.eligible].sort(), room.players.map(player => player.id).sort());
    assert.deepEqual(Object.keys(result.shares).sort(), [...result.winners].sort());
    assert(result.winners.every(id => result.eligible.includes(id)));
    assert(Object.values(result.shares).every(amount => Number.isSafeInteger(amount) && amount > 0));
    assert.equal(Object.values(result.shares).reduce((a, b) => a + b, 0), 500);
  }
  for (const player of room.players)
    assert.equal(hand.results.reduce((sum, result) => sum + (result.shares[player.id] ?? 0), 0), player.stack);
}
function assertAudit(roomId: string, audit: AuditRow[], entries: LedgerRow[], integrity: { valid: boolean; count: number; head: string }) {
  assert.equal(integrity.valid, true); assert.equal(integrity.count, audit.length); assert(audit.length > 0);
  let previousHash = '0'.repeat(64); let seq = 0;
  const transfers: Array<Omit<LedgerRow, 'id'>> = [];
  for (const row of [...audit].sort((a, b) => a.seq - b.seq)) {
    assert.equal(row.seq, ++seq); assert.equal(row.previousHash, previousHash);
    const expected = digest(canonical({ roomId, seq: row.seq, at: row.at, actorId: row.actorId, command: row.command,
      previousHash, events: row.events, transfers: row.transfers }));
    assert.equal(row.hash, expected, 'The exported audit chain does not recompute.');
    previousHash = expected;
    transfers.push(...row.transfers.map(entry => ({ ...entry, at: row.at, transactionId: `${roomId}:${row.seq}` })));
  }
  assert.equal(integrity.head, previousHash);
  assert.deepEqual([...entries].sort((a, b) => a.id - b.id).map(({ id: _id, ...entry }) => entry), transfers);
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else { assert(quoted || cell === ''); quoted = !quoted; }
    } else if (!quoted && (character === ',' || character === '\n' || character === '\r')) {
      row.push(cell); cell = '';
      if (character !== ',') {
        if (character === '\r' && text[index + 1] === '\n') index++;
        rows.push(row); row = [];
      }
    } else cell += character;
  }
  assert(!quoted);
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function writeReport(output: string, report: DeploymentReport) {
  const staging = `${output}.${randomUUID()}.part`;
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(staging, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(staging, output);
  } catch { failure('report_write_failed', 'The non-secret report could not be persisted to the selected output path.'); }
  finally { await rm(staging, { force: true }).catch(() => failure('report_cleanup_failed', 'The owned report staging file could not be removed.')); }
}

/**
 * Explicit opt-in remote smoke test; never loads .env or starts a server/database.
 * RIVER_ROOM_HOST_KEY is the only host-key source. Failed runs return status=failed
 * and attempt only a bounded, authenticated pause of their own synthetic room.
 */
export async function verifyDeployment(input: DeploymentOptions): Promise<DeploymentReport> {
  const options = normalizeOptions(input);
  const started = performance.now(); const deadline = Date.now() + options.timeoutMs;
  const cleanupReserveMs = Math.min(10_000, Math.floor(options.timeoutMs / 5));
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  const timer = setTimeout(() => abort.abort(), options.timeoutMs - cleanupReserveMs);
  const report: DeploymentReport = {
    status: 'failed', syntheticData: true, realPayments: false, endpoint: options.url,
    transport: options.url.startsWith('https:') ? 'https-and-wss' : 'explicit-loopback-http-and-ws',
    startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0,
    limits: { requests: MAX_REQUESTS, commands: MAX_COMMANDS, socketConnections: MAX_CONNECTIONS, socketViews: MAX_SOCKET_VIEWS,
      requestTimeoutMs: options.requestTimeoutMs, overallTimeoutMs: options.timeoutMs, cleanupReserveMs },
    checks: Object.entries(checks).map(([id, description]) => ({ id: id as CheckId, description, status: 'not_run' })),
    completion: { passed: 0, failed: 0, skipped: 0, notRun: 0 },
    counts: { httpRequests: 0, httpResponses: 0, commandAttempts: 0, commandsAccepted: 0, expectedRejections: 0,
      authenticatedPlayers: 0, roomsCreated: 0, privateHttpViews: 0, socketConnections: 0, socketSubscriptions: 0,
      socketViews: 0, reconnects: 0, duplicateReplays: 0, runoutVotes: 0, handsCompleted: 0, ledgerCheckpoints: 0,
      ledgerEntries: 0, auditRecords: 0, jsonExports: 0, csvExports: 0, chipsFunded: 0, chipsCashedOut: 0, bountyTransfers: 0, revokedSessions: 0 },
    session: { status: 'not_created', pauseAttempted: false, pauseVerified: false },
    persistenceHook: { requested: Boolean(options.afterFunding), completed: false, stateRechecked: false, restartPerformedByVerifier: false },
  };
  const ctx = new RunContext(options, report, signal, abort);
  const host = new ProbeClient(ctx); const guest = new ProbeClient(ctx); const clients = [host, guest];
  const suffix = randomUUID().slice(0, 8);
  const roomName = `River Room synthetic deployment probe ${suffix}`;
  let active: CheckId = 'configuration'; let hostKey = ''; let room: RoomView;
  let approval: Extract<Command, { type: 'approve' }>; let approvalBase: RoomView; const approvalId = randomUUID();
  let completedHistory: HandHistory;
  const check = async (id: CheckId, action: () => Promise<void> | void) => {
    active = id; const entry = report.checks.find(item => item.id === id)!;
    try { ctx.healthy(); await action(); ctx.healthy(); entry.status = 'passed'; }
    catch (error) { entry.status = 'failed'; throw error; }
  };
  const checkpoint = async (view: RoomView) => {
    const entries = await pages<LedgerRow>(host, view.id, 'ledger');
    assertAccounting(view, entries); report.counts.ledgerCheckpoints++; return entries;
  };
  const ownRoom = (value: RoomView) => {
    assert(value && /^[a-f0-9]{32}$/.test(value.id) && value.name === roomName && value.hostId === host.user?.id);
    assert(Number.isSafeInteger(value.version));
    return value;
  };
  const pauseOnFailure = async () => {
    if (report.session.status === 'not_created' || report.session.status === 'closed' || !host.user) return;
    ctx.cleanupSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      let id = report.session.roomId;
      if (!id) {
        const result = await host.json<{ rooms: RoomSummary[] }>('/api/rooms', undefined, 200, 'cleanup');
        const matching = result.rooms.filter(item => item.name === roomName && item.host === true && /^[a-f0-9]{32}$/.test(item.id));
        assert(matching.length <= 1);
        id = matching[0]?.id;
        if (!id) return;
        report.session.roomId = id;
      }
      let saved = ownRoom((await host.json<{ room: RoomView }>(`/api/rooms/${id}`, undefined, 200, 'cleanup')).room);
      if (saved.status === 'closed') { report.session.status = 'closed'; return; }
      report.session.pauseAttempted = true;
      if (!saved.paused) await host.json(`/api/rooms/${id}/commands`, {
        expectedVersion: saved.version, commandId: randomUUID(), command: { type: 'pause', value: true },
      }, 200, 'cleanup');
      saved = ownRoom((await host.json<{ room: RoomView }>(`/api/rooms/${id}`, undefined, 200, 'cleanup')).room);
      assert.equal(saved.paused, true); assert.equal(saved.nextHandAt, null);
      assert.equal(saved.hand?.deadline ?? null, null); assert.equal(saved.hand?.runoutVote?.deadline ?? null, null);
      report.session.status = 'paused'; report.session.pauseVerified = true;
    } catch (error) {
      report.session.status = 'unknown'; report.session.cleanupFailure = safeFailure(error);
    }
  };
  try {
    await check('configuration', () => {
      hostKey = process.env.RIVER_ROOM_HOST_KEY ?? '';
      if (hostKey.length < 24 || hostKey.length > 256 || /[\r\n\u0000]/.test(hostKey))
        failure('host_key_required', 'Set RIVER_ROOM_HOST_KEY to the deployment host key (24–256 characters); no key was printed or read from a file.');
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
        failure('unsafe_tls_environment', 'Remove NODE_TLS_REJECT_UNAUTHORIZED=0; TLS verification cannot be disabled.');
    });
    await check('readiness', async () => {
      assert.deepEqual(await host.json('/health/ready'), { status: 'ready' });
    });
    await check('client', async () => {
      const result = await host.request('/');
      assert(result.headers.get('content-type')?.includes('text/html'));
      assert(/<title\b[^>]*>[^<]*River Room[^<]*<\/title>/i.test(result.text));
      assert(/<div\b[^>]*\bid=["']root["'][^>]*>/i.test(result.text));
      const scripts = result.text.match(/<script\b[^>]*>/gi) ?? [];
      const module = scripts.find(script => /\btype=["']module["']/i.test(script));
      const source = module?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
      assert(source && !/[?#\\]/.test(source));
      const entrypoint = new URL(source, options.url);
      assert.equal(entrypoint.origin, options.url); assert.equal(entrypoint.username, ''); assert.equal(entrypoint.password, '');
      assert(/\.m?js$/i.test(entrypoint.pathname));
      const script = await host.request(entrypoint.pathname);
      assert(/(?:java|ecma)script/i.test(script.headers.get('content-type') ?? ''));
      assert(script.text.trim().length > 0 && !/^\s*</.test(script.text));
    });
    await check('authentication', async () => {
      await host.register(`RR probe host ${suffix}`); await guest.register(`RR probe guest ${suffix}`);
      assert.notEqual(host.user!.id, guest.user!.id);
    });
    await check('funding', async () => {
      report.session.status = 'creation_unconfirmed';
      const created = await host.json<{ room: RoomView }>('/api/rooms', {
        name: roomName, hostKey, buyIn: 500, commandId: randomUUID(),
        settings: { ...DEFAULT_SETTINGS, maxSeats: 2, minBuyIn: 500, maxBuyIn: 500, autoDeal: false, turnSeconds: 120 },
      }, 201);
      room = ownRoom(created.room); report.session.roomId = room.id; report.session.status = 'open'; report.counts.roomsCreated++;
      host.checked(room);
      assert.equal(room.settings.minBuyIn, 500); assert.equal(room.settings.autoDeal, false);
      assert.equal(room.players.length, 1); assert.equal(room.players[0]!.stack, 500);
      room = guest.checked((await guest.json<{ room: RoomView }>('/api/rooms/join', { code: room.code, commandId: randomUUID() })).room);
      assert.equal(room.players.length, 2);
      await guest.rejectCommand(room, { type: 'fund', amount: 499 }, 400);
      room = (await guest.command(room, { type: 'fund', amount: 500 })).room;
      const request = room.requests.find(item => item.playerId === guest.user!.id && item.status === 'pending');
      assert(request && request.amount === 500 && request.kind === 'buy_in');
      assert.equal(room.players.find(player => player.id === guest.user!.id)!.stack, 0);
      approval = { type: 'approve', requestId: request.id, approve: true };
      await guest.rejectCommand(room, approval, 403);
      approvalBase = room; room = (await host.command(room, approval, approvalId)).room;
      assert.deepEqual(room.players.map(player => [player.stack, player.buyIns, player.bountyNet]), [[500, 500, 0], [500, 500, 0]]);
      const entries = await checkpoint(room);
      assert.equal(entries.length, 2); assert(entries.every(entry => entry.kind === 'buy_in' && entry.chips === 500));
      report.counts.chipsFunded = 1000;
    });
    await check('idempotency', async () => {
      const before = await pages<AuditRow>(host, room.id, 'audit');
      const entries = await checkpoint(room);
      const replay = await host.command(approvalBase, approval, approvalId);
      assert.equal(replay.duplicate, true); assert.equal(replay.room.version, room.version);
      assert.deepEqual(replay.room.requests, room.requests); assert.deepEqual(replay.room.players, room.players);
      assert.deepEqual(await checkpoint(replay.room), entries);
      assert.deepEqual(await pages<AuditRow>(host, room.id, 'audit'), before);
      report.counts.duplicateReplays++;
    });
    if (options.afterFunding) {
      await check('afterFunding', async () => {
        const before = await checkpoint(room); const version = room.version; const players = room.players;
        let cancel = () => {};
        try {
          await Promise.race([
            Promise.resolve().then(() => options.afterFunding!({ endpoint: options.url, roomId: room.id, signal })),
            new Promise<never>((_resolve, reject) => {
              cancel = () => reject(new ProbeFailure('overall_timeout', 'The caller hook exceeded the overall time budget or was cancelled.'));
              signal.addEventListener('abort', cancel, { once: true });
              if (signal.aborted) cancel();
            }),
          ]);
        } catch (error) {
          ctx.healthy();
          if (error instanceof ProbeFailure) throw error;
          failure('hook_failed', 'The caller hook failed; its diagnostic details were omitted to protect secrets.');
        } finally { signal.removeEventListener('abort', cancel); }
        report.persistenceHook.completed = true;
        assert.deepEqual(await host.json('/health/ready'), { status: 'ready' });
        await host.identity(); await guest.identity();
        room = await host.room(room.id);
        assert.equal(room.version, version); assert.deepEqual(room.players, players); assert.equal(room.hand, null);
        assert.deepEqual(await checkpoint(room), before);
        report.persistenceHook.stateRechecked = true;
      });
    } else report.checks.find(entry => entry.id === 'afterFunding')!.status = 'skipped';
    await check('nextHand', async () => {
      const rules = { ...defaultHandRules(room.settings), game: 'omaha' as const, omahaAnte: 25, maxRunouts: 3 as const, sevenDeuceBounty: 25 };
      await guest.rejectCommand(room, { type: 'next_hand', rules }, 403);
      room = (await host.command(room, { type: 'next_hand', rules })).room;
      assert.deepEqual(room.nextHandRules, rules); assert.equal(room.hand, null);
      room = (await host.command(room, { type: 'deal' })).room;
      assert.equal(room.handNumber, 1); assert.equal(room.hand!.street, 'preflop'); assert.deepEqual(room.hand!.rules, rules);
      assert.equal(room.hand!.pot, 200); assert.equal(room.hand!.currentBet, 100);
      const antes = (await checkpoint(room)).filter(entry => entry.kind === 'ante');
      assert.equal(antes.length, 2); assert(antes.every(entry => entry.chips === 25 && entry.handId === room.hand!.id));
    });
    await check('livePrivacy', async () => {
      const hostHttp = await host.room(room.id); const guestHttp = await guest.room(room.id);
      hiddenViews(hostHttp, guestHttp);
      await host.connect(room.id); await guest.connect(room.id);
      const [left, right] = await Promise.all(clients.map(client => client.viewAt(room.version)));
      hiddenViews(left!, right!);
      assert.deepEqual(left!.players.find(player => player.id === host.user!.id)!.cards, hostHttp.players.find(player => player.id === host.user!.id)!.cards);
      assert.deepEqual(right!.players.find(player => player.id === guest.user!.id)!.cards, guestHttp.players.find(player => player.id === guest.user!.id)!.cards);
      const exported = await guest.json<{ room: RoomView; audit: AuditRow[] }>(`/api/rooms/${room.id}/export.json`);
      guest.checked(exported.room); noSecretState(exported); hiddenViews(hostHttp, exported.room);
      for (const card of hostHttp.players.find(player => player.id === host.user!.id)!.cards)
        assert(!JSON.stringify(exported).includes(JSON.stringify(card)));
      report.counts.jsonExports++;
      const previous = guest.connectionId(); assert(previous);
      const returned = await guest.connect(room.id);
      assert(guest.connectionId() && guest.connectionId() !== previous);
      hiddenViews(await host.viewAt(room.version), returned);
      assert.deepEqual(returned.players.find(player => player.id === guest.user!.id)!.cards, guestHttp.players.find(player => player.id === guest.user!.id)!.cards);
      report.counts.reconnects++;
    });
    await check('potLimit', async () => {
      const first = clients.find(client => client.user!.id === room.hand!.actorId)!; assert(first);
      const second = clients.find(client => client !== first)!;
      let view = await first.room(room.id);
      assert.equal(view.legal.bettingLimit, 'pot_limit'); assert.equal(view.legal.maxRaiseTo, 350);
      assert.equal(view.legal.potLimitTo, 350); assert.equal(view.legal.allInTo, 475); assert.equal(view.legal.canAllIn, false);
      const before = await checkpoint(view);
      await first.rejectCommand(view, { type: 'act', action: 'raise', amount: 351 }, 400);
      const unchanged = await first.room(room.id);
      assert.equal(unchanged.version, view.version); assert.deepEqual(await checkpoint(unchanged), before);
      room = (await first.command(view, { type: 'act', action: 'raise', amount: 350 })).room;
      view = await second.room(room.id);
      assert.equal(view.legal.maxRaiseTo, 475); assert.equal(view.legal.canAllIn, true);
      room = (await second.command(view, { type: 'act', action: 'raise', amount: 475 })).room;
      view = await first.room(room.id);
      assert.equal(view.legal.callAmount, 125);
      room = (await first.command(view, { type: 'act', action: 'call' })).room;
      assert.equal(room.hand!.pot, 1000); assert(room.players.every(player => player.stack === 0));
      const [left, right] = await Promise.all(clients.map(client => client.viewAt(room.version)));
      hiddenViews(left!, right!);
    });
    await check('runouts', async () => {
      const handId = room.hand!.id; const vote = room.hand!.runoutVote;
      assert(vote && vote.maxRuns === 3);
      assert.deepEqual([...vote.eligible].sort(), clients.map(client => client.user!.id).sort()); assert.deepEqual(vote.votes, {});
      room = (await host.command(room, { type: 'runouts', handId, count: 2 })).room; report.counts.runoutVotes++;
      assert.deepEqual(room.hand!.runoutVote!.votes, { [host.user!.id]: 2 }); assert.deepEqual(room.hand!.board, []);
      room = (await guest.command(room, { type: 'runouts', handId, count: 3 })).room; report.counts.runoutVotes++;
      assertSettlement(room);
      for (const view of await Promise.all(clients.map(client => client.viewAt(room.version)))) assertSettlement(view);
      report.counts.handsCompleted = 1;
    });
    await check('settlement', async () => {
      const entries = await checkpoint(room);
      assert.equal(entries.filter(entry => entry.kind === 'payout').reduce((sum, entry) => sum + entry.chips, 0), 1000);
      assert.equal(entries.filter(entry => entry.kind === 'bounty').length, 0);
      completedHistory = historyOf(room);
      assert.deepEqual(await pages<HandHistory>(host, room.id, 'hands'), [completedHistory]);
    });
    await check('cashOut', async () => {
      for (const client of clients) room = (await client.command(room, { type: 'cash_out' })).room;
      assert(room.players.every(player => player.stack === 0 && player.seat === null));
      room = (await host.command(room, { type: 'close' })).room;
      assert.equal(room.status, 'closed'); assert(room.closedAt);
      for (const view of await Promise.all(clients.map(client => client.viewAt(room.version)))) assert.equal(view.status, 'closed');
      room = await host.room(room.id); assert.equal(room.status, 'closed');
      report.session.status = 'closed';
      report.counts.chipsCashedOut = room.players.reduce((sum, player) => sum + player.cashOuts, 0);
      assert.equal(report.counts.chipsCashedOut, 1000); await checkpoint(room);
      for (const client of clients) client.disconnect();
    });
    await check('records', async () => {
      const entries = await checkpoint(room);
      const version = room.version;
      await host.rejectCommand(room, { type: 'deal' }, 409);
      await guest.rejectCommand(room, { type: 'fund', amount: 500 }, 409);
      assert.equal((await guest.room(room.id)).version, version); assert.deepEqual(await checkpoint(room), entries);
      for (const client of clients) assert.deepEqual(await pages<HandHistory>(client, room.id, 'hands'), [completedHistory]);
      const audit = await pages<AuditRow>(host, room.id, 'audit');
      const integrity = await host.json<{ valid: boolean; count: number; head: string }>(`/api/rooms/${room.id}/integrity`);
      assertAudit(room.id, audit, entries, integrity);
      const exported = await guest.json<{ room: RoomView; audit: AuditRow[] }>(`/api/rooms/${room.id}/export.json`);
      guest.checked(exported.room); noSecretState(exported);
      assert.equal(exported.room.status, 'closed'); assert.equal(exported.room.version, version);
      assert.deepEqual(exported.room.players.map(({ connected: _connected, ...player }) => player),
        room.players.map(({ connected: _connected, ...player }) => player));
      assert.deepEqual(exported.audit, audit);
      assert.deepEqual(historyOf(exported.room), completedHistory);
      assertAudit(room.id, exported.audit, entries, integrity); report.counts.jsonExports++;
      const csv = await host.request(`/api/rooms/${room.id}/export.csv`);
      assert(csv.headers.get('content-type')?.includes('text/csv')); assert(csv.headers.get('content-disposition')?.startsWith('attachment;'));
      const expected = entries.map(entry => [String(entry.id), entry.at, entry.transactionId, entry.kind,
        room.players.find(player => player.id === entry.playerId)!.name, entry.from, entry.to, String(entry.chips),
        (entry.cashCents / 100).toFixed(2), room.settings.currency, entry.note]);
      assert.deepEqual(parseCsv(csv.text), [['id', 'utc', 'transaction', 'type', 'player', 'from', 'to', 'chips', 'cash_amount', 'currency', 'note'], ...expected]);
      report.counts.csvExports++; report.counts.ledgerEntries = entries.length; report.counts.auditRecords = audit.length;
      report.counts.bountyTransfers = entries.filter(entry => entry.kind === 'bounty').length;
    });
    await check('logout', async () => {
      for (const client of clients) {
        assert.deepEqual(await client.json('/api/auth/logout', {}), { ok: true });
        assert.equal((await client.json<{ user: Identity | null }>('/api/me')).user, null);
        report.counts.revokedSessions++;
      }
    });
    report.status = 'passed';
  } catch (error) {
    report.error = { ...safeFailure(error), check: active };
    for (const client of clients) client.disconnect();
    await pauseOnFailure();
  } finally {
    clearTimeout(timer); abort.abort();
    for (const client of clients) client.discard();
    hostKey = '';
    report.finishedAt = new Date().toISOString(); report.durationMs = Math.round(performance.now() - started);
    for (const entry of report.checks) report.completion[entry.status === 'not_run' ? 'notRun' : entry.status]++;
    await writeReport(options.output, report);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    const options = normalizeOptions(deploymentOptionsFrom(process.argv.slice(2)));
    const report = await verifyDeployment({ ...options, signal: controller.signal });
    console.log(`Synthetic deployment verification ${report.status}; session ${report.session.status}. Report: ${options.output}`);
    if (report.status !== 'passed') {
      console.error(`${report.error?.code ?? 'verification_failed'} (${report.error?.check ?? 'unknown'}).`);
      process.exitCode = 1;
    }
  } catch (error) {
    const safe = safeFailure(error);
    console.error(`${safe.code}: ${safe.message}`); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
}
