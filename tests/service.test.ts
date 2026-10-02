import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { DEFAULT_SETTINGS, type Identity, type RoomView } from '../src/shared/model';
import { openDatabase, type Database } from '../src/server/database';
import { Store, canonical, digest } from '../src/server/store';
import { csvCell, makeApp } from '../src/server/app';

let db: Database;
let store: Store;
let server: Awaited<ReturnType<typeof makeApp>>;
let base: string;
const origin = 'http://localhost:8080';
type Guest = { user: Identity; cookie: string; recoveryCode: string };
async function request(path: string, body?: unknown, guest?: Guest, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(guest ? { Cookie: guest.cookie, 'X-CSRF-Token': guest.user.csrf } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  return { response, text: content, json: content ? JSON.parse(content) : null };
}
async function guest(name: string): Promise<Guest> {
  const result = await request('/auth/guest', { name });
  expect(result.response.status).toBe(200);
  return { ...result.json, cookie: result.response.headers.get('set-cookie')!.split(';')[0]! };
}
async function create(host: Guest) {
  const result = await request('/rooms', {
    name: 'Integration table', settings: { ...DEFAULT_SETTINGS, autoDeal: false }, buyIn: 10000, commandId: randomUUID(),
  }, host);
  expect(result.response.status).toBe(201);
  return result.json.room as RoomView;
}
async function command(room: RoomView, user: Guest, action: object, commandId = randomUUID()) {
  return request(`/rooms/${room.id}/commands`, { expectedVersion: room.version, commandId, command: action }, user);
}
async function enter(room: RoomView, player: Guest) {
  const result = await request('/rooms/join', { code: room.code, commandId: randomUUID() }, player);
  expect(result.response.status).toBe(200);
  return result.json.room as RoomView;
}
async function get(id: string, player: Guest) {
  const result = await request(`/rooms/${id}`, undefined, player);
  expect(result.response.status).toBe(200);
  return result.json.room as RoomView;
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
afterAll(async () => { await server?.close(); await db?.close(); });

describe('persistent multiplayer service', () => {
  test('connection-string SSL options cannot override certificate verification', async () => {
    for (const option of ['sslmode=no-verify', 'sslmode=disable', 'ssl=false', 'sslrootcert=other.pem']) {
      await expect(openDatabase({ url: `postgresql://fixture:fixture@localhost/riverroom?${option}`, ssl: true })).rejects.toThrow('Configure TLS with DATABASE_SSL');
    }
    await expect(openDatabase({ url: 'not a URL', ssl: true })).rejects.toThrow('valid PostgreSQL URL');
  });
  test('table creation retries are idempotent and reject reused keys with different inputs', async () => {
    const host = await guest('Create retry');
    const input = { name: 'One session', settings: DEFAULT_SETTINGS, buyIn: 10000, commandId: randomUUID() };
    const first = await request('/rooms', input, host);
    const retry = await request('/rooms', input, host);
    expect(first.response.status).toBe(201);
    expect(retry.response.status).toBe(201);
    expect(retry.json.room.id).toBe(first.json.room.id);
    expect((await store.ledger(first.json.room.id)).entries).toHaveLength(1);
    expect((await request('/rooms', { ...input, buyIn: 5000 }, host)).response.status).toBe(409);
  });
  test('opaque HttpOnly sessions, membership, CSRF, and origin checks protect the table', async () => {
    const host = await guest('Host');
    const outsider = await guest('Outsider');
    const created = await create(host);
    expect(host.cookie).toMatch(/^river-session=/);
    expect((await request(`/rooms/${created.id}`, undefined, outsider)).response.status).toBe(403);
    expect((await request(`/rooms/${created.id}/ledger`, undefined, outsider)).response.status).toBe(403);
    expect((await request('/rooms')).response.status).toBe(401);
    const payload = { expectedVersion: created.version, commandId: randomUUID(), command: { type: 'add_bot' } };
    expect((await request(`/rooms/${created.id}/commands`, payload, host, { Origin: 'https://not-your-table.example' })).response.status).toBe(403);
    expect((await request(`/rooms/${created.id}/commands`, payload, host, { 'X-CSRF-Token': 'wrong' })).response.status).toBe(403);
    expect((await request(`/rooms/${created.id}/commands`, { ...payload, command: { type: 'join', name: 'Forged' } }, host)).response.status).toBe(400);
  });
  test('guest funding, duplicate retries, complete hands, and exports reconcile with snapshots', async () => {
    const host = await guest('Alice');
    const player = await guest('Bob');
    let room = await create(host);
    room = await enter(room, player);
    let result = await command(room, player, { type: 'fund', amount: 10000 });
    expect(result.response.status).toBe(200); room = result.json.room;
    expect(room.players.find(item => item.id === player.user.id)?.stack).toBe(0);
    const approvalId = randomUUID();
    const approve = { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true };
    const oldRoom = room;
    result = await command(room, host, approve, approvalId);
    expect(result.response.status).toBe(200); room = result.json.room;
    const repeated = await command(oldRoom, host, approve, approvalId);
    expect(repeated.response.status).toBe(200);
    expect(repeated.json.duplicate).toBe(true);
    expect(repeated.json.room.version).toBe(room.version);
    expect(repeated.json.room.players.find((item: { id: string }) => item.id === player.user.id).stack).toBe(10000);
    const collision = await command(room, host, { type: 'fund', amount: 5000 }, approvalId);
    expect(collision.response.status).toBe(409);
    expect((await command(oldRoom, host, { type: 'deal' })).response.status).toBe(409);
    result = await command(room, host, { type: 'deal' }); room = result.json.room;
    expect(result.response.status).toBe(200);
    const hostCards = room.players.find(item => item.id === host.user.id)!.cards;
    const otherView = await get(room.id, player);
    expect(otherView.players.find(item => item.id === host.user.id)!.cards).toEqual([null, null]);
    expect(JSON.stringify(otherView)).not.toContain('"deck"');
    for (const card of hostCards) expect(JSON.stringify(otherView)).not.toContain(`"${card}"`);
    let guard = 0;
    while (room.hand?.street !== 'complete') {
      expect(++guard).toBeLessThan(20);
      const actor = room.hand?.actorId === host.user.id ? host : player;
      const view = await get(room.id, actor);
      result = await command(view, actor, { type: 'act', action: view.legal.canCheck ? 'check' : 'call' });
      expect(result.response.status).toBe(200); room = result.json.room;
    }
    expect(room.players.reduce((sum, item) => sum + item.stack, 0)).toBe(20000);
    expect((await request(`/rooms/${room.id}/hands`, undefined, host)).json.entries).toHaveLength(1);
    expect((await request(`/rooms/${room.id}/integrity`, undefined, host)).json.valid).toBe(true);
    const ledger = (await request(`/rooms/${room.id}/ledger`, undefined, host)).json.entries;
    const balances = new Map<string, number>();
    for (const entry of ledger) {
      balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.chips);
      balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.chips);
    }
    for (const item of room.players) expect(balances.get(`player:${item.id}`)).toBe(item.stack);
    expect(balances.get(`pot:${room.hand?.id}`)).toBe(0);
    const audit = await request(`/rooms/${room.id}/export.json`, undefined, host);
    expect(audit.json.audit.length).toBeGreaterThan(10);
    expect(audit.text).not.toContain('"deck"');
    const csv = await fetch(`${base}/api/rooms/${room.id}/export.csv`, { headers: { Cookie: host.cookie } });
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    expect(await csv.text()).toContain('"buy_in"');
    await expect(db.query('DELETE FROM rr_ledger WHERE room_id=$1', [room.id])).rejects.toThrow('append-only');
    await expect(db.query("UPDATE rr_audit SET command='fake' WHERE room_id=$1", [room.id])).rejects.toThrow('append-only');
  });
  test('row locking prevents concurrent commands from changing the same old version twice', async () => {
    const host = await guest('Concurrency host');
    const room = await create(host);
    const [one, two] = await Promise.all([command(room, host, { type: 'fund', amount: 1000 }), command(room, host, { type: 'fund', amount: 2000 })]);
    expect([one.response.status, two.response.status].sort()).toEqual([200, 409]);
    const latest = await get(room.id, host);
    expect([11000, 12000]).toContain(latest.players[0]?.stack);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });
  test('emoji changes are per-table, idempotent, and delivered live to other members', async () => {
    const host = await guest('Emoji host');
    const player = await guest('Emoji guest');
    const outsider = await guest('Emoji outsider');
    let room = await enter(await create(host), player);
    const otherRoom = await create(player);
    const before = room;
    const socket = connectSocket(base, {
      auth: { csrf: host.user.csrf }, extraHeaders: { Cookie: host.cookie, Origin: origin },
      forceNew: true, reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect_error', reject);
        socket.once('connect', () => socket.emit('subscribe', room.id, (ack: { ok: boolean }) =>
          ack.ok ? resolve() : reject(new Error('Emoji subscription failed'))));
      });
      const update = new Promise<RoomView>(resolve => {
        socket.on('room', (view: RoomView) => {
          if (view.players.find(item => item.id === player.user.id)?.emoji === '\u{1F60E}') resolve(view);
        });
      });
      const commandId = randomUUID();
      const input = { type: 'emoji', emoji: '\u{1F60E}' };
      const result = await command(room, player, input, commandId);
      expect(result.response.status).toBe(200);
      room = result.json.room;
      expect((await update).players.find(item => item.id === player.user.id)?.emoji).toBe('\u{1F60E}');
      expect(room.players.find(item => item.id === host.user.id)?.emoji).toBeNull();
      expect((await get(otherRoom.id, player)).players[0]?.emoji).toBeNull();
      const retry = await command(before, player, input, commandId);
      expect(retry.json.duplicate).toBe(true);
      expect(retry.json.room.version).toBe(room.version);
      expect((await command(before, player, { type: 'emoji', emoji: null })).response.status).toBe(409);
      expect((await command(room, outsider, input)).response.status).toBe(403);
      for (const emoji of ['', 'hello', '\u{1F600}\u{1F600}', 123, undefined])
        expect((await command(room, player, { type: 'emoji', emoji })).response.status).toBe(400);
      const cleared = await command(room, player, { type: 'emoji', emoji: null });
      expect(cleared.response.status).toBe(200);
      expect(cleared.json.room.players.find((item: { id: string }) => item.id === player.user.id).emoji).toBeNull();
      expect((await store.ledger(room.id)).entries).toHaveLength(1);
      expect((await store.audit(room.id)).entries.filter(entry => entry.command === 'emoji')).toHaveLength(2);
      expect((await store.verifyAudit(room.id)).valid).toBe(true);
    } finally { socket.disconnect(); }
  });
  test('recovery restores the same player and revokes old browser sessions', async () => {
    const host = await guest('Recover me');
    const room = await create(host);
    const recovered = await request('/auth/recover', { recoveryCode: host.recoveryCode });
    expect(recovered.response.status).toBe(200);
    expect(recovered.json.user.id).toBe(host.user.id);
    expect((await request(`/rooms/${room.id}`, undefined, host)).response.status).toBe(401);
    const replacement: Guest = { ...host, user: recovered.json.user, cookie: recovered.response.headers.get('set-cookie')!.split(';')[0]! };
    expect((await get(room.id, replacement)).players[0]?.stack).toBe(10000);
    expect((await request('/auth/recover', { recoveryCode: 'RR-not-a-valid-recovery-key' })).response.status).toBe(401);
    expect((await request('/auth/logout', {}, replacement)).response.status).toBe(200);
    expect((await request('/rooms', undefined, replacement)).response.status).toBe(401);
  });
  test('WebSocket subscriptions are authenticated, membership-checked, and privately serialized', async () => {
    const host = await guest('Socket host');
    const player = await guest('Socket guest');
    const outsider = await guest('Socket outsider');
    let room = await create(host); room = await enter(room, player);
    let result = await command(room, player, { type: 'fund', amount: 10000 }); room = result.json.room;
    result = await command(room, host, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true }); room = result.json.room;
    result = await command(room, host, { type: 'deal' }); room = result.json.room;
    const sockets: Socket[] = [];
    function socketFor(who: Guest) {
      const socket = connectSocket(base, { auth: { csrf: who.user.csrf }, extraHeaders: { Cookie: who.cookie, Origin: origin }, forceNew: true, reconnection: false });
      sockets.push(socket); return socket;
    }
    try {
      const hostSocket = socketFor(host);
      const hostView = await new Promise<RoomView>((resolve, reject) => {
        hostSocket.on('connect_error', reject); hostSocket.on('room', resolve);
        hostSocket.on('connect', () => hostSocket.emit('subscribe', room.id, (ack: { ok: boolean }) => { if (!ack.ok) reject(new Error('Host subscribe failed')); }));
      });
      expect(hostView.players.find(item => item.id === host.user.id)?.cards).toEqual(room.players.find(item => item.id === host.user.id)?.cards);
      expect(hostView.players.find(item => item.id === player.user.id)?.cards).toEqual([null, null]);
      const otherSocket = socketFor(outsider);
      const result = await new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        otherSocket.on('connect_error', reject); otherSocket.on('connect', () => otherSocket.emit('subscribe', room.id, resolve));
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Join');
    } finally { sockets.forEach(socket => socket.disconnect()); }
  });
  test('startup conservatively pauses active play without moving chips', async () => {
    const host = await guest('Restart host');
    let room = await create(host);
    let result = await command(room, host, { type: 'add_bot' }); room = result.json.room;
    result = await command(room, host, { type: 'deal' }); room = result.json.room;
    const pot = room.hand?.pot;
    const balances = room.players.map(item => item.stack);
    await store.pauseAfterRestart();
    room = await get(room.id, host);
    expect(room.paused).toBe(true);
    expect(room.hand?.deadline).toBeNull();
    expect(room.hand?.pot).toBe(pot);
    expect(room.players.map(item => item.stack)).toEqual(balances);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });
  test('local PostgreSQL actually survives closing and reopening its files', async () => {
    const path = await mkdtemp(join(tmpdir(), 'river-room-test-'));
    let local: Database | null = null;
    try {
      local = await openDatabase({ directory: join(path, 'postgres') });
      const firstStore = new Store(local);
      const person = await firstStore.createIdentity('Persistent person');
      const saved = await firstStore.create(person.user, { name: 'Persistent table', settings: DEFAULT_SETTINGS, buyIn: 10000, commandId: randomUUID() });
      await firstStore.execute(saved.id, person.user.id, randomUUID(), { type: 'emoji', emoji: '\u{1F988}' }, saved.version);
      await local.close(); local = null;
      local = await openDatabase({ directory: join(path, 'postgres') });
      const next = new Store(local);
      expect((await next.getRoom(saved.id)).players[0]?.stack).toBe(10000);
      expect((await next.getRoom(saved.id)).players[0]?.emoji).toBe('\u{1F988}');
      expect((await next.identity(person.token))?.id).toBe(person.user.id);
      expect((await next.verifyAudit(saved.id)).valid).toBe(true);
      expect((await next.ledger(saved.id)).entries).toHaveLength(1);
    } finally { await local?.close(); await rm(path, { recursive: true, force: true }); }
  });
  test('canonical hashes ignore key ordering and CSV quotes block spreadsheet formulas', () => {
    expect(digest(canonical({ z: 1, a: { c: 3, b: 2 } }))).toBe(digest(canonical({ a: { b: 2, c: 3 }, z: 1 })));
    for (const text of ['=HYPERLINK("bad")', '+SUM(1,2)', '-1+2', '@SUM(A1)', '\t=evil']) expect(csvCell(text)).toMatch(/^"'/);
    expect(csvCell('Sam "Ace"')).toBe('"Sam ""Ace"""');
  });
  test('export cursors freeze the ledger and audit at their captured room snapshot', async () => {
    const host = await guest('Export snapshot');
    const room = await create(host);
    const snapshot = await store.exportSnapshot(room.id, host.user.id);
    await command(room, host, { type: 'fund', amount: 1000 });
    expect(snapshot.room.players[0]?.stack).toBe(10000);
    expect((await store.ledger(room.id, snapshot.ledgerBefore)).entries).toHaveLength(1);
    expect((await store.audit(room.id, snapshot.auditBefore)).entries).toHaveLength(1);
    expect((await store.ledger(room.id)).entries).toHaveLength(2);
  });
});
