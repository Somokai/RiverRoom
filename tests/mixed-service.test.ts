import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { io as connectSocket } from 'socket.io-client';
import {
  defaultHandRules,
  type AuditRow, type Card, type Command, type HandRules, type Identity, type LedgerRow,
  type Room, type RoomSettings, type RoomView,
} from '../src/shared/model';
import * as cardEngine from '../src/server/cards';
import { openDatabase, type Database } from '../src/server/database';
import { Store, verifyTransfers } from '../src/server/store';
import { makeApp } from '../src/server/app';

const PACK = [...'23456789TJQKA'].flatMap(rank => [...'cdhs'].map(suit => rank + suit));
const origin = 'http://river-room-tests.invalid';
type Guest = { user: Identity; cookie: string };
let database: Database;
let store: Store;
let server: Awaited<ReturnType<typeof makeApp>>;
let base: string;
let tableNumber = 0;

async function api(path: string, who?: Guest, body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.user.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

async function guest(name: string): Promise<Guest> {
  const result = await api('/auth/guest', undefined, { name });
  expect(result.response.status, result.text).toBe(200);
  return { user: result.json.user as Identity, cookie: result.response.headers.get('set-cookie')!.split(';')[0]! };
}

async function create(who: Guest, buyIn = 500, settings: Partial<RoomSettings> = {}) {
  const result = await api('/rooms', who, {
    name: `Mixed integration ${++tableNumber}`, buyIn,
    settings: { autoDeal: false, ...settings }, commandId: randomUUID(),
  });
  expect(result.response.status, result.text).toBe(201);
  return result.json.room as RoomView;
}

async function join(room: RoomView, who: Guest) {
  const result = await api('/rooms/join', who, { code: room.code, commandId: randomUUID() });
  expect(result.response.status, result.text).toBe(200);
  return result.json.room as RoomView;
}

async function get(roomId: string, who: Guest) {
  const result = await api(`/rooms/${roomId}`, who);
  expect(result.response.status, result.text).toBe(200);
  return result.json.room as RoomView;
}

function command(room: RoomView, who: Guest, value: unknown, commandId: string = randomUUID()) {
  return api(`/rooms/${room.id}/commands`, who, { expectedVersion: room.version, commandId, command: value });
}

async function accepted(room: RoomView, who: Guest, value: Command, commandId?: string) {
  const result = await command(room, who, value, commandId);
  expect(result.response.status, result.text).toBe(200);
  return result.json.room as RoomView;
}

async function funded(stacks = [500, 500], settings: Partial<RoomSettings> = {}) {
  const people = [await guest('Mixed host')];
  let room = await create(people[0]!, stacks[0]!, settings);
  for (let index = 1; index < stacks.length; index++) {
    const who = await guest(`Mixed guest ${index}`); people.push(who);
    room = await join(room, who);
    room = await accepted(room, who, { type: 'fund', amount: stacks[index]! });
    room = await accepted(room, people[0]!, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return { room, people };
}

function rig(prefix: Card[]) {
  expect(new Set(prefix).size).toBe(prefix.length);
  expect(prefix.every(card => PACK.includes(card))).toBe(true);
  return [...prefix, ...PACK.filter(card => !prefix.includes(card))];
}

async function deal(room: RoomView, host: Guest, deck?: Card[]) {
  if (!deck) return accepted(room, host, { type: 'deal' });
  // Replace only entropy, not dealing, persistence, accounting, validation, or private serialization.
  const shuffle = vi.spyOn(cardEngine, 'shuffleDeck').mockImplementation(() => [...deck]);
  try {
    const next = await accepted(room, host, { type: 'deal' });
    expect(shuffle).toHaveBeenCalledOnce();
    return next;
  } finally { shuffle.mockRestore(); }
}

async function checkDown(initial: RoomView, people: Guest[]) {
  let room = initial;
  for (let turn = 0; room.hand!.street !== 'complete'; turn++) {
    if (turn >= 80) throw new Error('HTTP check-down did not terminate');
    expect(room.hand!.runoutVote).toBeNull();
    const actor = people.find(who => who.user.id === room.hand!.actorId);
    expect(actor, 'The test must be able to act for every dealt player').toBeDefined();
    const view = await get(room.id, actor!);
    room = await accepted(view, actor!, { type: 'act', action: view.legal.canCheck ? 'check' : 'call' });
  }
  return room;
}

async function socketView(roomId: string, who: Guest): Promise<RoomView> {
  const socket = connectSocket(base, {
    forceNew: true, reconnection: false, auth: { csrf: who.user.csrf },
    extraHeaders: { Cookie: who.cookie, Origin: origin },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RoomView>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned integration socket did not receive its private room view')), 4000);
      socket.once('connect_error', reject);
      socket.once('room', resolve);
      socket.once('connect', () => socket.emit('subscribe', roomId, (ack: { ok: boolean; error?: string }) => {
        if (!ack.ok) reject(new Error(ack.error ?? 'Socket subscription rejected'));
      }));
    });
  } finally {
    clearTimeout(timer);
    socket.disconnect();
  }
}

async function allLedger(roomId: string) {
  const page = await store.ledger(roomId);
  expect(page.nextCursor, 'These fixtures must inspect every ledger entry, not just a truncated page').toBeNull();
  return [...page.entries].sort((a, b) => a.id - b.id);
}

function book(entries: LedgerRow[]) {
  const balances = new Map<string, number>();
  for (const entry of entries) {
    expect(Number.isSafeInteger(entry.chips) && entry.chips > 0).toBe(true);
    balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.chips);
    balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.chips);
    if (entry.kind !== 'bounty' && entry.from !== 'bank') expect(balances.get(entry.from)).toBeGreaterThanOrEqual(0);
  }
  expect([...balances.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
  return balances;
}

beforeAll(async () => {
  database = await openDatabase({ directory: ':memory:' });
  store = new Store(database);
  server = await makeApp(store, { origin, production: false, trustProxy: false, scheduler: false });
  await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve));
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('The owned integration server has no TCP address');
  expect(address.port).not.toBe(8080);
  base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/health/ready`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ready' });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await database?.close();
});

describe('mixed-game HTTP commands against real, isolated in-memory PostgreSQL', () => {
  test('omitted minimum defaults to 500, guest funding is approved once, and minimum edits move no money', async () => {
    const host = await guest('Five hundred host');
    const other = await guest('Five hundred guest');
    let room = await create(host);
    expect(room.settings.minBuyIn).toBe(500);
    expect(room.players[0]).toMatchObject({ stack: 500, buyIns: 500, chipNet: 0, bountyNet: 0, net: 0 });
    room = await join(room, other);
    expect((await command(room, other, { type: 'fund', amount: 499 })).response.status).toBe(400);
    const fundingId = randomUUID();
    const fundingBase = room;
    room = await accepted(room, other, { type: 'fund', amount: 500 }, fundingId);
    const retriedFund = await command(fundingBase, other, { type: 'fund', amount: 500 }, fundingId);
    expect(retriedFund.response.status).toBe(200);
    expect(retriedFund.json.duplicate).toBe(true);
    expect(retriedFund.json.room.requests).toHaveLength(room.requests.length);
    const approval = { type: 'approve' as const, requestId: room.requests.at(-1)!.id, approve: true };
    const approvalId = randomUUID(); const approvalBase = room;
    room = await accepted(room, host, approval, approvalId);
    const retry = await command(approvalBase, host, approval, approvalId);
    expect(retry.response.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(room.players.map(player => player.stack)).toEqual([500, 500]);
    const before = await allLedger(room.id);
    expect(before.map(entry => [entry.kind, entry.chips])).toEqual([['buy_in', 500], ['buy_in', 500]]);
    const settings = {
      type: 'settings' as const, smallBlind: 50, bigBlind: 100, ante: 0,
      turnSeconds: 45, autoDeal: false, allowRebuys: true, minBuyIn: 750,
    };
    expect((await command(room, other, settings)).response.status).toBe(403);
    room = await accepted(room, host, settings);
    expect(room.settings.minBuyIn).toBe(750);
    expect(room.players.map(player => [player.stack, player.buyIns, player.cashOuts])).toEqual([[500, 500, 0], [500, 500, 0]]);
    expect(await allLedger(room.id)).toEqual(before);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('next-hand edits are host-only, versioned, idempotent, and never alter the active hand', async () => {
    const setup = await funded();
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await deal(room, host);
    const originalHand = (await store.getRoom(room.id)).hand;
    const rules: HandRules = { ...defaultHandRules(), game: 'omaha_bomb', bombAnte: 7, maxRunouts: 3 };
    expect((await command(room, other, { type: 'next_hand', rules })).response.status).toBe(403);
    expect((await command(room, host, { type: 'next_hand', rules: { ...rules, maxRunouts: 4 } })).response.status).toBe(400);
    const key = randomUUID(); const prior = room;
    room = await accepted(room, host, { type: 'next_hand', rules }, key);
    expect((await store.getRoom(room.id)).hand).toEqual(originalHand);
    const retry = await command(prior, host, { type: 'next_hand', rules }, key);
    expect(retry.response.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(retry.json.room.version).toBe(room.version);
    expect((await command(room, host, { type: 'next_hand', rules: { ...rules, bombAnte: 8 } }, key)).response.status).toBe(409);
    expect((await command(prior, host, { type: 'next_hand', rules })).response.status).toBe(409);
    room = await checkDown(room, setup.people);
    room = await deal(room, host);
    expect(room.hand).toMatchObject({ rules, street: 'flop', pot: 14 });
    expect(room.players.find(player => player.id === host.user.id)!.cards).toHaveLength(4);
    room = await checkDown(room, setup.people);
    const histories = (await api(`/rooms/${room.id}/hands`, host)).json.entries;
    expect(histories).toHaveLength(2);
    expect(histories.map((hand: { rules: HandRules }) => hand.rules.game)).toEqual(['omaha_bomb', 'holdem']);
    expect(histories.map((hand: { showdown: boolean }) => hand.showdown)).toEqual([true, true]);
    expect(histories[0].boards).toHaveLength(2);
    expect(histories[0].board).toEqual(histories[0].boards[0]);
    expect(histories[0].runoutBoards).toEqual([histories[0].boards]);
  });

  test('Indian forehead privacy holds for commands, GET, WebSocket, exports, and completed histories', async () => {
    const setup = await funded();
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    const observer = await guest('Indian observer');
    room = await join(room, observer);
    room = await accepted(room, host, {
      type: 'next_hand', rules: { ...defaultHandRules(), game: 'indian', indianAnte: 5, maxRunouts: 3 },
    });
    room = await deal(room, host, rig(['Ks', 'Ah', 'Kd', 'Ad', '4c', '2c', '3d', '6h', '4d', '9s', '4h', 'Jc']));
    const expectedCards = new Map([[host.user.id, ['Ah', 'Ad']], [other.user.id, ['Ks', 'Kd']]]);
    const verifyView = (view: RoomView, who: Guest) => {
      expect(view.hand).not.toHaveProperty('deck');
      expect(view.hand).not.toHaveProperty('burned');
      expect(view.hand).not.toHaveProperty('holeCards');
      for (const [id, cards] of expectedCards) {
        expect(view.players.find(player => player.id === id)!.cards).toEqual(who.user.id === id ? [null, null] : cards);
      }
      for (const card of expectedCards.get(who.user.id) ?? []) expect(JSON.stringify(view)).not.toContain(`"${card}"`);
    };
    verifyView(room, host);
    const views = await Promise.all([get(room.id, host), get(room.id, other), get(room.id, observer)]);
    views.forEach((view, index) => verifyView(view, [host, other, observer][index]!));
    const [hostSocket, observerSocket] = await Promise.all([socketView(room.id, host), socketView(room.id, observer)]);
    verifyView(hostSocket, host); verifyView(observerSocket, observer);
    for (const who of [host, other, observer]) {
      const exported = await api(`/rooms/${room.id}/export.json`, who);
      expect(exported.response.status).toBe(200);
      verifyView(exported.json.room as RoomView, who);
      for (const card of expectedCards.get(who.user.id) ?? []) expect(exported.text).not.toContain(`"${card}"`);
      expect((await api(`/rooms/${room.id}/hands`, who)).json.entries).toEqual([]);
    }
    room = await checkDown(room, setup.people);
    expect(room.hand).toMatchObject({ street: 'complete', board: ['2c', '3d', '6h', '9s', 'Jc'], runoutCount: 1 });
    for (const who of [host, other]) {
      const view = await get(room.id, who);
      expect(view.players.find(player => player.id === who.user.id)!.cards).toEqual(expectedCards.get(who.user.id));
    }
    const history = (await api(`/rooms/${room.id}/hands`, host)).json.entries[0];
    expect(history.rules.game).toBe('indian');
    expect(history.showdown).toBe(true);
    expect(history.boards).toEqual([['2c', '3d', '6h', '9s', 'Jc']]);
    expect(history.revealed).toEqual({ [host.user.id]: ['Ah', 'Ad'], [other.user.id]: ['Ks', 'Kd'] });
    expect(history.balanceAfter).toEqual({ [host.user.id]: 605, [other.user.id]: 395, [observer.user.id]: 0 });
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('Indian fold reveals both own cards immediately across HTTP, WebSocket reconnect, exports and restart', async () => {
    const setup = await funded([500, 500, 500]);
    let room = setup.room; const [host, second, third] = setup.people as [Guest, Guest, Guest];
    room = await accepted(room, host, {
      type: 'next_hand', rules: { ...defaultHandRules(), game: 'indian', indianAnte: 25 },
    });
    room = await deal(room, host);
    const saved = await store.getRoom(room.id);
    const cards = saved.hand!.holeCards[host.user.id]!;
    expect(room.hand!.actorId).toBe(host.user.id);
    expect(room.players[0]!.cards).toEqual([null, null]);
    const before = room;
    const commandId = randomUUID();
    room = await accepted(room, host, { type: 'act', action: 'fold' }, commandId);
    expect(room.hand!.street).not.toBe('complete');
    expect(room.hand!.revealed).toEqual({});
    expect(room.players[0]!.cards).toEqual(cards);
    const ledger = await allLedger(room.id);
    expect(ledger.filter(entry => entry.kind === 'ante').map(entry => entry.chips)).toEqual([25, 25, 25]);
    expect((await command(before, host, { type: 'act', action: 'fold' }, commandId)).json.duplicate).toBe(true);
    expect(await allLedger(room.id)).toEqual(ledger);
    for (const view of [await get(room.id, host), await socketView(room.id, host), (await api(`/rooms/${room.id}/export.json`, host)).json.room as RoomView])
      expect(view.players.find(player => player.id === host.user.id)!.cards).toEqual(cards);
    for (const who of [second, third]) {
      const view = await socketView(room.id, who);
      expect(view.players.find(player => player.id === who.user.id)!.cards).toEqual([null, null]);
      expect(view.players.find(player => player.id === host.user.id)!.cards).toEqual(cards);
      for (const card of saved.hand!.holeCards[who.user.id]!) {
        expect(JSON.stringify(view)).not.toContain(`"${card}"`);
        expect((await api(`/rooms/${room.id}/export.json`, who)).text).not.toContain(`"${card}"`);
      }
    }
    await store.pauseAfterRestart();
    room = await get(room.id, host);
    expect(room.paused).toBe(true);
    expect(room.players[0]!.cards).toEqual(cards);
    expect((await store.getRoom(room.id)).hand!.holeCards).toEqual(saved.hand!.holeCards);
    room = await accepted(room, host, { type: 'pause', value: false });
    room = await checkDown(room, setup.people);
    expect(room.hand!.board).toHaveLength(5);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
    book(await allLedger(room.id));
  });

  test('bounty debt persists separately from bankrolls, retries never duplicate it, and exports reconcile', async () => {
    const setup = await funded([60, 60], { minBuyIn: 1, smallBlind: 10, bigBlind: 20, chipValueCents: 4 });
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await accepted(room, host, { type: 'next_hand', rules: { ...defaultHandRules(), sevenDeuceBounty: 1000 } });
    room = await deal(room, host, rig(['As', '7c', 'Ad', '2d', '3c', '7s', '7h', '2c', '4c', 'Qh', '5c', '9d']));
    room = await accepted(room, host, { type: 'act', action: 'raise', amount: 60 });
    const before = await store.getRoom(room.id);
    const beforeLedger = await allLedger(room.id);
    const finalKey = randomUUID(); const waiting = room;
    room = await accepted(room, other, { type: 'act', action: 'call' }, finalKey);
    expect(room.hand).toMatchObject({
      street: 'complete', awardedPot: 120,
      bounty: { winnerId: host.user.id, payerIds: [other.user.id], amount: 1000, totalAmount: 1000 },
    });
    expect(room.players.map(player => [player.stack, player.buyIns, player.cashOuts, player.bountyNet, player.chipNet, player.net]))
      .toEqual([[120, 60, 0, 1000, 60, 1060], [0, 60, 0, -1000, -60, -1060]]);
    expect(room.hand!.revealed[host.user.id]).toEqual(['7c', '2d']);
    const ledger = await allLedger(room.id);
    const ledgerApi = await api(`/rooms/${room.id}/ledger`, other);
    expect(ledgerApi.response.status).toBe(200);
    expect(ledgerApi.json.nextCursor).toBeNull();
    expect((ledgerApi.json.entries as LedgerRow[]).sort((a, b) => a.id - b.id)).toEqual(ledger);
    const retry = await command(waiting, other, { type: 'act', action: 'call' }, finalKey);
    expect(retry.response.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(await allLedger(room.id)).toEqual(ledger);
    const bountyEntries = ledger.filter(entry => entry.kind === 'bounty');
    expect(bountyEntries).toHaveLength(1);
    expect(bountyEntries[0]).toMatchObject({
      from: `bounty:${other.user.id}`, to: `bounty:${host.user.id}`, playerId: other.user.id,
      chips: 1000, cashCents: 4000, handId: room.hand!.id,
    });
    const balances = book(ledger);
    expect(balances.get('bank')).toBe(-120);
    expect(balances.get(`player:${host.user.id}`)).toBe(120);
    expect(balances.get(`player:${other.user.id}`)).toBe(0);
    expect(balances.get(`pot:${room.hand!.id}`)).toBe(0);
    expect(balances.get(`bounty:${host.user.id}`)).toBe(1000);
    expect(balances.get(`bounty:${other.user.id}`)).toBe(-1000);
    const finalEntries = ledger.filter(entry => entry.id > beforeLedger.at(-1)!.id);
    const after = await store.getRoom(room.id);
    expect(() => verifyTransfers(before, after, finalEntries)).not.toThrow();
    for (const forged of [
      { kind: 'bet' as const }, { cashCents: 1 }, { from: `player:${other.user.id}` }, { playerId: host.user.id },
    ]) {
      expect(() => verifyTransfers(before, after, finalEntries.map(entry => entry.kind === 'bounty' ? { ...entry, ...forged } : entry))).toThrow();
    }
    const histories = (await api(`/rooms/${room.id}/hands`, host)).json.entries;
    expect(histories).toHaveLength(1);
    expect(histories[0]).toMatchObject({
      showdown: true,
      bounty: room.hand!.bounty, bountyAfter: { [host.user.id]: 1000, [other.user.id]: -1000 },
      balanceAfter: { [host.user.id]: 120, [other.user.id]: 0 }, board: room.hand!.board,
    });
    const exportJson = await api(`/rooms/${room.id}/export.json`, other);
    expect(exportJson.response.status).toBe(200);
    expect(exportJson.json.room.players.find((player: { id: string }) => player.id === other.user.id))
      .toMatchObject({ bountyNet: -1000, chipNet: -60, net: -1060 });
    expect(exportJson.json.room.hand).toMatchObject({
      showdown: true, bounty: room.hand!.bounty,
      revealed: { [host.user.id]: ['7c', '2d'] },
      bountyAfter: { [host.user.id]: 1000, [other.user.id]: -1000 },
    });
    const exportedBounties = (exportJson.json.audit as AuditRow[])
      .flatMap(entry => entry.transfers).filter(entry => entry.kind === 'bounty');
    const { id: _id, at: _at, transactionId: _transaction, ...bountyTransfer } = bountyEntries[0]!;
    expect(exportedBounties).toEqual([bountyTransfer]);
    expect(exportJson.text).not.toContain('"deck"');
    const csv = await fetch(`${base}/api/rooms/${room.id}/export.csv`, { headers: { Cookie: other.cookie } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const bountyLines = (await csv.text()).split(/\r?\n/).filter(line => line.includes(',"bounty",'));
    expect(bountyLines).toHaveLength(1);
    expect(bountyLines[0]).toContain(
      `"bounty","${other.user.name}","bounty:${other.user.id}","bounty:${host.user.id}","1000","40.00","USD"`,
    );
    const summary = (await api('/rooms', other)).json.rooms.find((item: { id: string }) => item.id === room.id);
    expect(summary).toMatchObject({ bountyNet: -1000, chipNet: -60, net: -1060, stack: 0, buyIns: 60 });
    room = await accepted(room, host, { type: 'close' });
    expect(room.players.map(player => [player.stack, player.cashOuts, player.bountyNet, player.net]))
      .toEqual([[0, 120, 1000, 1060], [0, 0, -1000, -1060]]);
    expect((await allLedger(room.id)).filter(entry => entry.kind === 'bounty')).toHaveLength(1);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test.each([false, true])('uncontested history persists showdown=false with bounty enabled=%s', async bounty => {
    const setup = await funded();
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await accepted(room, host, {
      type: 'next_hand', rules: { ...defaultHandRules(), sevenDeuceBounty: bounty ? 25 : 0 },
    });
    room = await deal(room, host, rig(['As', '7c', 'Kd', '2d']));
    room = await accepted(room, host, { type: 'act', action: 'raise', amount: 300 });
    room = await accepted(room, other, { type: 'act', action: 'fold' });
    const reveal = bounty ? { [host.user.id]: ['7c', '2d'] } : {};
    expect(room.hand).toMatchObject({ street: 'complete', showdown: false, revealed: reveal, awardedPot: 200 });
    const histories = (await api(`/rooms/${room.id}/hands`, other)).json.entries;
    expect(histories).toHaveLength(1);
    expect(histories[0]).toMatchObject({ id: room.hand!.id, showdown: false, revealed: reveal, pot: 200 });
    expect(histories[0].bounty).toEqual(bounty
      ? { winnerId: host.user.id, payerIds: [other.user.id], amount: 25, totalAmount: 25 } : null);
    const persisted = await store.hands(room.id);
    expect(persisted.entries[0]!.showdown).toBe(false);
    expect(room.players.map(player => player.stack)).toEqual([600, 400]);
    expect(room.players.map(player => player.bountyNet)).toEqual(bounty ? [25, -25] : [0, 0]);
    book(await allLedger(room.id));
  });

  test('partially voted runouts survive store restart, pause/resume, duplicate retries, and hand-history persistence', async () => {
    const setup = await funded([60, 60], { minBuyIn: 1, smallBlind: 10, bigBlind: 20 });
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await accepted(room, host, { type: 'next_hand', rules: { ...defaultHandRules(), maxRunouts: 3 } });
    room = await deal(room, host, [...PACK]);
    room = await accepted(room, host, { type: 'act', action: 'raise', amount: 60 });
    room = await accepted(room, other, { type: 'act', action: 'call' });
    expect(room.hand!.runoutVote).toMatchObject({ eligible: [host.user.id, other.user.id], votes: {}, maxRuns: 3 });
    const handId = room.hand!.id;
    const firstKey = randomUUID(); const beforeVote = room;
    room = await accepted(room, host, { type: 'runouts', handId, count: 3 }, firstKey);
    const same = await command(beforeVote, host, { type: 'runouts', handId, count: 3 }, firstKey);
    expect(same.response.status).toBe(200);
    expect(same.json.duplicate).toBe(true);
    expect((await command(room, host, { type: 'runouts', handId, count: 3 })).response.status).toBe(409);
    const persisted = await store.getRoom(room.id);
    const previousLedger = await allLedger(room.id);
    const restoredStore = new Store(database);
    await restoredStore.pauseAfterRestart();
    const restored = await restoredStore.getRoom(room.id);
    expect(restored.paused).toBe(true);
    expect(restored.hand!.runoutVote).toMatchObject({ votes: { [host.user.id]: 3 }, deadline: null });
    expect(restored.hand!.deck).toEqual(persisted.hand!.deck);
    expect(restored.hand!.runoutPrefix).toEqual(persisted.hand!.runoutPrefix);
    expect(restored.players.map(player => player.stack)).toEqual(persisted.players.map(player => player.stack));
    expect(await allLedger(room.id)).toEqual(previousLedger);
    room = await get(room.id, host);
    const beforeResume = Date.now();
    room = await accepted(room, host, { type: 'pause', value: false });
    expect(room.hand!.runoutVote!.deadline).toBeGreaterThanOrEqual(beforeResume + 20_000);
    expect(room.hand!.runoutVote!.deadline).toBeLessThanOrEqual(Date.now() + 20_000);
    const finalKey = randomUUID(); const lastVote = room;
    room = await accepted(room, other, { type: 'runouts', handId, count: 2 }, finalKey);
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 2, runoutVote: null });
    const finalLedger = await allLedger(room.id);
    const lastRetry = await command(lastVote, other, { type: 'runouts', handId, count: 2 }, finalKey);
    expect(lastRetry.response.status).toBe(200);
    expect(lastRetry.json.duplicate).toBe(true);
    expect(await allLedger(room.id)).toEqual(finalLedger);
    const history = (await api(`/rooms/${room.id}/hands`, other)).json.entries;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: handId, runoutCount: 2, runoutBoards: room.hand!.runoutBoards, board: room.hand!.board, pot: 120 });
    expect(history[0].boards).toEqual(history[0].runoutBoards[0]);
    expect(history[0].results.map((result: { runoutIndex: number; amount: number }) => [result.runoutIndex, result.amount])).toEqual([[0, 60], [1, 60]]);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
    book(finalLedger);
  });

  test('the real store timeout records missing consent once, including a valid system audit record', async () => {
    const setup = await funded([60, 60], { minBuyIn: 1, smallBlind: 10, bigBlind: 20 });
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await accepted(room, host, { type: 'next_hand', rules: { ...defaultHandRules(), maxRunouts: 3 } });
    room = await deal(room, host, [...PACK]);
    room = await accepted(room, host, { type: 'act', action: 'raise', amount: 60 });
    room = await accepted(room, other, { type: 'act', action: 'call' });
    room = await accepted(room, host, { type: 'runouts', handId: room.hand!.id, count: 3 });
    const deadline = room.hand!.runoutVote!.deadline!;
    expect(await store.timeout(room.id, room.version - 1)).toBeNull();
    expect(await store.timeout(room.id, room.version)).toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    try {
      const expired = await store.timeout(room.id, room.version);
      expect(expired?.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
      expect(await store.timeout(room.id, room.version)).toBeNull();
      expect(await store.timeout(room.id, expired!.version)).toBeNull();
    } finally { clock.mockRestore(); }
    room = await get(room.id, host);
    expect(room.hand!.runoutCount).toBe(1);
    expect((await store.hands(room.id)).entries).toHaveLength(1);
    const audit = await store.audit(room.id);
    expect(audit.entries[0]).toMatchObject({ actorId: 'system' });
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
    expect((await allLedger(room.id)).filter(entry => entry.kind === 'payout').reduce((sum, entry) => sum + entry.chips, 0)).toBe(120);
  });

  test('the real app scheduler expires a pending vote even though actorId and the betting deadline are null', async () => {
    const setup = await funded([60, 60], { minBuyIn: 1, smallBlind: 10, bigBlind: 20 });
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await accepted(room, host, { type: 'next_hand', rules: { ...defaultHandRules(), maxRunouts: 3 } });
    room = await deal(room, host, [...PACK]);
    room = await accepted(room, host, { type: 'act', action: 'raise', amount: 60 });
    room = await accepted(room, other, { type: 'act', action: 'call' });
    room = await accepted(room, host, { type: 'runouts', handId: room.hand!.id, count: 3 });
    expect(room.hand).toMatchObject({ actorId: null, deadline: null });
    const deadline = room.hand!.runoutVote!.deadline!;
    const scheduled = await makeApp(store, { origin, production: false, trustProxy: false, scheduler: true });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    try {
      await new Promise<void>(resolve => scheduled.http.listen(0, '127.0.0.1', resolve));
      const address = scheduled.http.address();
      if (!address || typeof address === 'string') throw new Error('Owned scheduler server has no TCP address');
      expect(address.port).not.toBe(8080);
      const health = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ready' });
      let settled = await store.getRoom(room.id);
      for (let attempt = 0; settled.hand!.street !== 'complete' && attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        settled = await store.getRoom(room.id);
      }
      expect(settled.hand).toMatchObject({
        street: 'complete', runoutCount: 1, runoutVote: null, awardedPot: 120, completedAt: deadline,
      });
      const entries = await allLedger(room.id);
      expect(entries.filter(entry => entry.kind === 'payout').reduce((sum, entry) => sum + entry.chips, 0)).toBe(120);
      expect((await store.audit(room.id)).entries[0]!.actorId).toBe('system');
      expect((await store.verifyAudit(room.id)).valid).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(await allLedger(room.id)).toEqual(entries);
      expect((await store.hands(room.id)).entries).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await scheduled.close();
    }
  }, 15_000);

  test('an authentic active snapshot stripped to v1 reloads as Holdem without changing cookies, balances, deck, or ledger', async () => {
    const setup = await funded([5000, 5000], { minBuyIn: 4000 });
    let room = setup.room; const [host, other] = setup.people as [Guest, Guest];
    room = await deal(room, host, [...PACK]);
    room = await accepted(room, host, { type: 'act', action: 'call' });
    room = await accepted(room, other, { type: 'act', action: 'check' });
    const modern = await store.getRoom(room.id);
    const legacy = structuredClone(modern);
    for (const field of ['schemaVersion', 'nextHandRules']) delete (legacy as unknown as Record<string, unknown>)[field];
    for (const player of legacy.players) delete (player as unknown as Record<string, unknown>).bountyNet;
    for (const field of ['rules', 'boards', 'runoutBoards', 'runoutPrefix', 'runoutCount', 'runoutVote', 'preflopPotAdjustment', 'bounty', 'bountyAfter']) {
      delete (legacy.hand as unknown as Record<string, unknown>)[field];
    }
    const ledger = await allLedger(room.id);
    await database.query('UPDATE rr_rooms SET state=$2::jsonb WHERE id=$1', [room.id, JSON.stringify(legacy)]);
    const restoredStore = new Store(database);
    const restored = await restoredStore.getRoom(room.id);
    expect(restored.schemaVersion).toBe(3);
    expect(restored.settings.minBuyIn).toBe(4000);
    expect(restored.hand).toMatchObject({
      rules: { game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 },
      board: modern.hand!.board, boards: [modern.hand!.board], runoutVote: null, runoutCount: 1,
      pot: modern.hand!.pot, deck: modern.hand!.deck, holeCards: modern.hand!.holeCards,
    });
    expect(restored.players).toEqual(modern.players);
    expect(restored.version).toBe(modern.version);
    for (const who of [host, other]) {
      expect((await api('/me', who)).json.user).toEqual(who.user);
      const summary = (await restoredStore.rooms(who.user.id)).find(item => item.id === room.id)!;
      expect(summary).toMatchObject({ stack: 4900, buyIns: 5000, chipNet: 0, bountyNet: 0, net: 0 });
    }
    expect((await restoredStore.openRooms()).find(item => item.id === room.id)!.schemaVersion).toBe(3);
    room = await get(room.id, host);
    room = await accepted(room, host, { type: 'chat', message: 'Persist the upgraded snapshot without moving chips.' });
    expect(await allLedger(room.id)).toEqual(ledger);
    const saved = await database.query<{ state: Room }>('SELECT state FROM rr_rooms WHERE id=$1', [room.id]);
    expect(saved.rows[0]!.state.schemaVersion).toBe(3);
    expect(saved.rows[0]!.state.hand!.rules.game).toBe('holdem');
    room = await checkDown(room, setup.people);
    expect(room.hand!.board.slice(0, 3)).toEqual(modern.hand!.board);
    expect(room.hand!.rules).toMatchObject({ game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 });
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(10_000);
    const history = (await store.hands(room.id)).entries[0]!;
    expect(history.rules.game).toBe('holdem');
    expect(history.runoutCount).toBe(1);
    expect(history.board).toEqual(history.boards[0]);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });
});
