import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { DEFAULT_SETTINGS, type Identity, type RoomView } from '../src/shared/model';
import { EMOTES, EMOTE_COOLDOWN_MS, EMOTE_DURATION_MS, type EmoteId, type EmoteResult, type TableEmote } from '../src/shared/emotes';
import { openDatabase, type Database } from '../src/server/database';
import { Store } from '../src/server/store';
import { makeApp } from '../src/server/app';

type Guest = { user: Identity; cookie: string };
type Subscription = { ok: boolean; error?: string };
const origin = 'http://localhost:8080';
const sockets: Socket[] = [];
let db: Database;
let store: Store;
let server: Awaited<ReturnType<typeof makeApp>>;
let base: string;

async function request(path: string, body?: unknown, guest?: Guest) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(guest ? { Cookie: guest.cookie, 'X-CSRF-Token': guest.user.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function guest(name: string): Promise<Guest> {
  const result = await request('/auth/guest', { name });
  expect(result.status).toBe(200);
  return { user: result.json.user, cookie: result.cookie! };
}
async function create(host: Guest): Promise<RoomView> {
  const result = await request('/rooms', {
    name: 'Emote table', settings: { ...DEFAULT_SETTINGS, autoDeal: false }, buyIn: 10000, commandId: randomUUID(),
  }, host);
  expect(result.status).toBe(201);
  return result.json.room;
}
async function enter(room: RoomView, player: Guest): Promise<RoomView> {
  const result = await request('/rooms/join', { code: room.code, commandId: randomUUID() }, player);
  expect(result.status).toBe(200);
  return result.json.room;
}
async function command(room: RoomView, player: Guest, command: object): Promise<RoomView> {
  const result = await request(`/rooms/${room.id}/commands`, { expectedVersion: room.version, commandId: randomUUID(), command }, player);
  expect(result.status).toBe(200);
  return result.json.room;
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Socket test timed out.')), 2500); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function socketFor(player: Guest): Promise<Socket> {
  const socket = connectSocket(base, {
    auth: { csrf: player.user.csrf }, extraHeaders: { Cookie: player.cookie, Origin: origin },
    forceNew: true, reconnection: false, transports: ['websocket'], autoConnect: false, timeout: 2000,
  });
  sockets.push(socket);
  await bounded(new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  }));
  return socket;
}
function subscribe(socket: Socket, roomId: string): Promise<Subscription> {
  return socket.timeout(2000).emitWithAck('subscribe', roomId);
}
async function subscribed(player: Guest, roomId: string): Promise<Socket> {
  const socket = await socketFor(player);
  expect(await subscribe(socket, roomId)).toEqual({ ok: true });
  return socket;
}
function emote(socket: Socket, request: unknown): Promise<EmoteResult> {
  return socket.timeout(2000).emitWithAck('emote', request);
}
function observe(socket: Socket): TableEmote[] {
  const events: TableEmote[] = [];
  socket.on('emote', (event: TableEmote) => events.push(event));
  return events;
}
function nextEmote(socket: Socket): Promise<TableEmote> {
  return bounded(new Promise<TableEmote>(resolve => socket.once('emote', resolve)));
}
function accepted(result: EmoteResult): TableEmote {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.event;
}
function rejected(result: EmoteResult, message: RegExp) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Unexpected accepted emote.');
  expect(result.error).toMatch(message);
  return result;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function persisted(roomId: string) {
  return Promise.all([store.getRoom(roomId), store.ledger(roomId), store.audit(roomId), store.hands(roomId)]);
}

beforeAll(async () => {
  db = await openDatabase({ directory: ':memory:' });
  store = new Store(db);
  server = await makeApp(store, { origin, production: false, trustProxy: false, scheduler: false });
  await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve));
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.disconnect());
  await delay(20);
});
afterAll(async () => { await server?.close(); await db?.close(); });

describe('transient seat emotes', () => {
  test('fixed labels reach only room subscribers, with no private data, persistence, or replay', async () => {
    expect(EMOTES).toEqual({ hello: 'Hello', nice_hand: 'Nice hand!', sorry: 'Sorry...', well_played: 'Well played' });
    expect(EMOTE_COOLDOWN_MS).toBe(3000);
    expect(EMOTE_DURATION_MS).toBe(4000);
    const host = await guest('Emote host');
    const player = await guest('Emote guest');
    let room = await enter(await create(host), player);
    room = await command(room, host, { type: 'add_bot' });
    room = await command(room, host, { type: 'deal' });
    const otherRoom = await create(host);
    const sender = await subscribed(host, room.id);
    const receiver = await subscribed(player, room.id);
    const otherTable = await subscribed(host, otherRoom.id);
    const unsubscribed = await socketFor(player);
    const senderEvents = observe(sender);
    const receiverEvents = observe(receiver);
    const otherEvents = observe(otherTable);
    const unsubscribedEvents = observe(unsubscribed);
    const roomUpdates: RoomView[] = [];
    receiver.on('room', (view: RoomView) => roomUpdates.push(view));
    const before = await persisted(room.id);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const phrase of Object.keys(EMOTES) as EmoteId[]) {
        const delivery = Promise.all([nextEmote(sender), nextEmote(receiver)]);
        const event = accepted(await emote(sender, { roomId: room.id, emote: phrase }));
        expect(event).toEqual({ id: expect.any(String), roomId: room.id, playerId: host.user.id, emote: phrase, at: now });
        expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(Object.keys(event).sort()).toEqual(['at', 'emote', 'id', 'playerId', 'roomId']);
        expect(await delivery).toEqual([event, event]);
        now += 3000;
      }
      expect(senderEvents).toHaveLength(4);
      expect(receiverEvents).toEqual(senderEvents);
      expect(new Set(senderEvents.map(event => event.id)).size).toBe(4);
      expect(otherEvents).toEqual([]);
      expect(unsubscribedEvents).toEqual([]);
      expect(roomUpdates).toEqual([]);
      expect(await persisted(room.id)).toEqual(before);
      sender.disconnect();
      const reconnected = await socketFor(host);
      const replay = observe(reconnected);
      expect(await subscribe(reconnected, room.id)).toEqual({ ok: true });
      expect(await subscribe(receiver, room.id)).toEqual({ ok: true });
      await delay(40);
      expect(replay).toEqual([]);
      expect(receiverEvents).toHaveLength(4);
    } finally { clock.mockRestore(); }
  });

  test('strict payloads reject free text and forged identity/time before querying the database', async () => {
    const host = await guest('Strict host');
    const room = await create(host);
    const socket = await subscribed(host, room.id);
    const events = observe(socket);
    const identity = vi.spyOn(store, 'identity');
    const getRoom = vi.spyOn(store, 'getRoom');
    try {
      const valid = { roomId: room.id, emote: 'hello' };
      const invalid: unknown[] = [
        null, undefined, [], 'Hello', {}, { roomId: room.id }, { emote: 'hello' },
        { ...valid, roomId: '' }, { ...valid, roomId: 4 }, { ...valid, roomId: 'x'.repeat(81) },
        ...['Hello', 'Nice hand!', 'Sorry...', 'Well played', 'free text', 'hello ', 'constructor', 'toString', '__proto__', '', 7, null, {}]
          .map(emote => ({ ...valid, emote })),
        { ...valid, playerId: randomUUID() }, { ...valid, at: 0 }, { ...valid, id: randomUUID() },
        { ...valid, phrase: 'anything' }, { ...valid, message: 'anything' },
      ];
      for (const payload of invalid) rejected(await emote(socket, payload), /valid table emote/i);
      expect(identity).not.toHaveBeenCalled();
      expect(getRoom).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(accepted(await emote(socket, valid)).playerId).toBe(host.user.id);
    } finally { identity.mockRestore(); getRoom.mockRestore(); }
    const persistedCommand = await request(`/rooms/${room.id}/commands`, {
      expectedVersion: room.version, commandId: randomUUID(), command: { type: 'emote', emote: 'hello' },
    }, host);
    expect(persistedCommand.status).toBe(400);
  });

  test('missing or non-function acknowledgements are safe for valid and invalid requests', async () => {
    const host = await guest('No ack host');
    const room = await create(host);
    const socket = await subscribed(host, room.id);
    const delivery = nextEmote(socket);
    socket.emit('emote', null);
    socket.emit('emote', { roomId: room.id, emote: 'arbitrary' }, 'not an acknowledgement');
    socket.emit('emote', { roomId: room.id, emote: 'hello' });
    expect((await delivery).playerId).toBe(host.user.id);
    rejected(await emote(socket, { roomId: room.id, emote: 'hello' }), /wait/i);
    expect(socket.connected).toBe(true);
  });

  test('unsubscribed, mismatched-room, outsider, unauthenticated, and bad-CSRF sockets cannot send', async () => {
    const host = await guest('Auth host');
    const outsider = await guest('Auth outsider');
    const room = await create(host);
    const otherRoom = await create(host);
    const sender = await socketFor(host);
    const stranger = await socketFor(outsider);
    const payload = { roomId: room.id, emote: 'hello' };
    rejected(await emote(sender, payload), /subscribe/i);
    expect(await subscribe(stranger, room.id)).toMatchObject({ ok: false, error: expect.stringMatching(/join/i) });
    rejected(await emote(stranger, payload), /subscribe/i);
    expect(await subscribe(sender, otherRoom.id)).toEqual({ ok: true });
    rejected(await emote(sender, payload), /subscribe/i);
    await expect(socketFor({ ...host, cookie: '' })).rejects.toThrow('Session expired.');
    await expect(socketFor({ ...host, user: { ...host.user, csrf: 'forged' } })).rejects.toThrow('Session expired.');
  });

  test('sessions and membership are revalidated rather than trusting the subscription', async () => {
    const host = await guest('Revoked host');
    const peer = await guest('Revoked peer');
    const room = await enter(await create(host), peer);
    const sender = await subscribed(host, room.id);
    const receiver = await subscribed(peer, room.id);
    const events = observe(receiver);
    const current = await store.getRoom(room.id);
    const getRoom = vi.spyOn(store, 'getRoom').mockResolvedValueOnce({ ...current, players: current.players.filter(player => player.id !== host.user.id) });
    try {
      rejected(await emote(sender, { roomId: room.id, emote: 'hello' }), /join/i);
      expect(getRoom).toHaveBeenCalledWith(room.id);
    } finally { getRoom.mockRestore(); }
    await store.logout(host.cookie.slice('river-session='.length));
    expect(sender.connected).toBe(true);
    rejected(await emote(sender, { roomId: room.id, emote: 'hello' }), /session expired/i);
    await delay(30);
    expect(events).toEqual([]);
  });

  test('paused rooms allow seated players; cash-outs and closed rooms reject fresh attempts', async () => {
    const host = await guest('Paused host');
    const player = await guest('Paused peer');
    let room = await enter(await create(host), player);
    const sender = await subscribed(host, room.id);
    const peer = await subscribed(player, room.id);
    room = await command(room, host, { type: 'pause', value: true });
    expect(room.paused).toBe(true);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      accepted(await emote(peer, { roomId: room.id, emote: 'sorry' }));
      room = await command(room, player, { type: 'cash_out' });
      now += 3000;
      rejected(await emote(peer, { roomId: room.id, emote: 'hello' }), /seat/i);
      const delivery = nextEmote(peer);
      accepted(await emote(sender, { roomId: room.id, emote: 'well_played' }));
      expect((await delivery).emote).toBe('well_played');
      room = await command(room, host, { type: 'close' });
      expect(room.status).toBe('closed');
      now += 3000;
      rejected(await emote(sender, { roomId: room.id, emote: 'nice_hand' }), /closed/i);
    } finally { clock.mockRestore(); }
  });

  test('cooldown is atomic across tabs/reconnects, exactly 3000ms, and independent by player and room', async () => {
    const host = await guest('Cooldown host');
    const player = await guest('Cooldown peer');
    const room = await enter(await create(host), player);
    const otherRoom = await create(host);
    const one = await subscribed(host, room.id);
    const two = await subscribed(host, room.id);
    const peer = await subscribed(player, room.id);
    const otherTable = await subscribed(host, otherRoom.id);
    const payload = { roomId: room.id, emote: 'hello' };
    let now = Date.now();
    const start = now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const identity = vi.spyOn(store, 'identity');
    const getRoom = vi.spyOn(store, 'getRoom');
    try {
      const results = await Promise.all([emote(one, payload), emote(two, payload)]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      const first = accepted(results.find(result => result.ok)!);
      rejected(results.find(result => !result.ok)!, /wait/i);
      for (let attempt = 0; attempt < 20; attempt++) {
        expect(rejected(await emote(attempt % 2 ? one : two, payload), /wait/i).retryAfterMs).toBe(3000);
      }
      expect(identity).toHaveBeenCalledTimes(1);
      expect(getRoom).toHaveBeenCalledTimes(1);
      expect(accepted(await emote(peer, payload)).playerId).toBe(player.user.id);
      expect(accepted(await emote(otherTable, { ...payload, roomId: otherRoom.id })).roomId).toBe(otherRoom.id);
      one.disconnect();
      two.disconnect();
      const reconnected = await subscribed(host, room.id);
      expect(rejected(await emote(reconnected, payload), /wait/i).retryAfterMs).toBe(3000);
      now = start + 2999;
      expect(rejected(await emote(reconnected, payload), /wait/i).retryAfterMs).toBe(1);
      now = start + 3000;
      const next = accepted(await emote(reconnected, payload));
      expect(next.at).toBe(start + 3000);
      expect(next.id).not.toBe(first.id);
    } finally { identity.mockRestore(); getRoom.mockRestore(); clock.mockRestore(); }
  });

  test('rejected requests have a bounded shared database-query budget without a successful emote', async () => {
    const host = await guest('Budget host');
    let room = await create(host);
    room = await command(room, host, { type: 'cash_out' });
    const one = await subscribed(host, room.id);
    const two = await subscribed(host, room.id);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const identity = vi.spyOn(store, 'identity');
    const getRoom = vi.spyOn(store, 'getRoom');
    try {
      for (let attempt = 0; attempt < 24; attempt++) {
        const result = await emote(attempt % 2 ? one : two, { roomId: room.id, emote: 'hello' });
        rejected(result, attempt < 12 ? /seat/i : /too many/i);
      }
      expect(identity).toHaveBeenCalledTimes(12);
      expect(getRoom).toHaveBeenCalledTimes(12);
      now += 3000;
      rejected(await emote(one, { roomId: room.id, emote: 'hello' }), /seat/i);
      expect(identity).toHaveBeenCalledTimes(13);
    } finally { identity.mockRestore(); getRoom.mockRestore(); clock.mockRestore(); }
  });

  test('unexpected errors have sanitized logging/acks and release the in-flight reservation', async () => {
    const host = await guest('Failure host');
    const room = await create(host);
    const socket = await subscribed(host, room.id);
    const secret = 'private database credentials and cards';
    const identity = vi.spyOn(store, 'identity').mockRejectedValueOnce(new Error(secret));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = rejected(await emote(socket, { roomId: room.id, emote: 'hello' }), /unable to send/i);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(log).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('emote_error');
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(host.cookie);
      accepted(await emote(socket, { roomId: room.id, emote: 'hello' }));
    } finally { identity.mockRestore(); log.mockRestore(); }
  });

  test.each([
    ['identity', 'disconnect'], ['getRoom', 'disconnect'],
    ['identity', 'same-room'], ['getRoom', 'same-room'],
    ['identity', 'other-room'], ['getRoom', 'other-room'],
  ] as const)('drops in-flight events if %s returns after %s, without consuming cooldown', async (method, change) => {
    const host = await guest('Race host');
    const player = await guest('Race peer');
    const room = await enter(await create(host), player);
    const otherRoom = await create(host);
    const sender = await subscribed(host, room.id);
    const backup = await subscribed(host, room.id);
    const receiver = await subscribed(player, room.id);
    const events = observe(receiver);
    const started = deferred();
    const release = deferred();
    const identity = store.identity.bind(store);
    const getRoom = store.getRoom.bind(store);
    const spy = method === 'identity'
      ? vi.spyOn(store, 'identity').mockImplementationOnce(async token => {
        const result = await identity(token);
        started.resolve(); await release.promise;
        return result;
      })
      : vi.spyOn(store, 'getRoom').mockImplementationOnce(async id => {
        const result = await getRoom(id);
        started.resolve(); await release.promise;
        return result;
      });
    try {
      const pending = emote(sender, { roomId: room.id, emote: 'hello' }).catch(() => null);
      await bounded(started.promise);
      if (change === 'disconnect') {
        const serverSocket = server.io.sockets.sockets.get(sender.id!);
        expect(serverSocket).toBeDefined();
        const disconnected = bounded(new Promise<void>(resolve => serverSocket!.once('disconnect', () => resolve())));
        sender.disconnect();
        await disconnected;
      } else expect(await subscribe(sender, change === 'same-room' ? room.id : otherRoom.id)).toEqual({ ok: true });
      release.resolve();
      const result = await pending;
      if (change !== 'disconnect') {
        expect(result).not.toBeNull();
        rejected(result!, /subscribe/i);
      }
      await delay(30);
      expect(events).toEqual([]);
      accepted(await emote(backup, { roomId: room.id, emote: 'hello' }));
    } finally { release.resolve(); spy.mockRestore(); }
  });

  test('an older asynchronous subscription cannot restore a room after a newer subscription wins', async () => {
    const host = await guest('Subscribe race');
    const oldRoom = await create(host);
    const newRoom = await create(host);
    const socket = await subscribed(host, oldRoom.id);
    const started = deferred();
    const release = deferred();
    const original = store.getRoom.bind(store);
    const getRoom = vi.spyOn(store, 'getRoom').mockImplementationOnce(async id => {
      const result = await original(id);
      started.resolve(); await release.promise;
      return result;
    });
    try {
      const oldSubscription = subscribe(socket, oldRoom.id);
      await bounded(started.promise);
      expect(await subscribe(socket, newRoom.id)).toEqual({ ok: true });
      release.resolve();
      expect(await oldSubscription).toMatchObject({ ok: false });
      expect(accepted(await emote(socket, { roomId: newRoom.id, emote: 'hello' })).roomId).toBe(newRoom.id);
      rejected(await emote(socket, { roomId: oldRoom.id, emote: 'hello' }), /subscribe/i);
    } finally { release.resolve(); getRoom.mockRestore(); }
  });
});
