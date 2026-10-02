import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Command, type Identity, type Room, type RoomSettings, type RoomView } from '../src/shared/model';
import { chooseBotAction } from '../src/server/bot';
import { makeDeck } from '../src/server/cards';
import { assertRoom, createRoom, roomView, timeoutTurn, transition, type Context } from '../src/server/engine';
import { commandSchema } from '../src/server/validation';
import { Store, verifyTransfers } from '../src/server/store';
import { openDatabase, type Database } from '../src/server/database';
import { makeApp } from '../src/server/app';

let now = 1800000000000;
function step(room: Room, actor: string, command: Command, context: Partial<Context> = {}) {
  const result = transition(room, actor, command, { now: ++now, ...context });
  assertRoom(result.room);
  verifyTransfers(room, result.room, result.transfers);
  return result;
}
function apply(room: Room, actor: string, command: Command, context: Partial<Context> = {}) {
  return step(room, actor, command, context).room;
}
function table(settings: Partial<RoomSettings> = {}, buyIn = 1000) {
  const result = createRoom({
    id: 'practice', code: 'BOT12345', name: 'Virtual practice', hostId: 'host', hostName: 'Host', buyIn,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 2000, autoDeal: false, ...settings },
  }, { now: ++now });
  verifyTransfers(null, result.room, result.transfers);
  return result.room;
}
function bots(room: Room, count = 1) {
  for (let i = 0; i < count; i++) room = apply(room, 'host', { type: 'add_bot' });
  return room;
}
function rig(cards: string[]) {
  return [...cards, ...makeDeck().filter(card => !cards.includes(card))];
}
function bustBot(settings: Partial<RoomSettings> = {}) {
  let room = bots(table({ maxBuyIn: 1000, ...settings }));
  const botId = room.players[1]!.id;
  room = apply(room, 'host', { type: 'deal' }, { deck: rig(['Kc', 'Ac', 'Kd', 'Ad', '2s', '2c', '3d', '7h', '4s', '9c', '5s', 'Ts']) });
  room = apply(room, 'host', { type: 'act', action: 'raise', amount: 1000 });
  room = apply(room, botId, { type: 'act', action: 'call' });
  expect(room.hand?.street).toBe('complete');
  expect(room.players.find(player => player.id === botId)?.stack).toBe(0);
  return { room, botId };
}
function changeSettings(room: Room, settings: Partial<Extract<Command, { type: 'settings' }>>) {
  return apply(room, 'host', {
    type: 'settings', smallBlind: room.settings.smallBlind, bigBlind: room.settings.bigBlind,
    ante: room.settings.ante, autoDeal: room.settings.autoDeal, turnSeconds: room.settings.turnSeconds,
    allowRebuys: room.settings.allowRebuys, ...settings,
  });
}
function randomSource(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}
function testDeck(random: () => number) {
  const deck = makeDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

describe('explicit virtual practice funding', () => {
  test('the public command accepts bot IDs and rejects invalid amounts or missing targets', () => {
    const command = { type: 'fund_bot', playerId: `bot-${randomUUID()}`, amount: 100 };
    expect(commandSchema.parse(command)).toEqual(command);
    for (const amount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10000001, '100'])
      expect(commandSchema.safeParse({ ...command, amount }).success).toBe(false);
    for (const playerId of ['', 'x'.repeat(81), undefined])
      expect(commandSchema.safeParse({ ...command, playerId }).success).toBe(false);
  });

  test('only the host can refill a seated bot, never a human or a removed bot', () => {
    let room = bots(table());
    room = apply(room, 'guest', { type: 'join', name: 'Guest' });
    const botId = room.players.find(player => player.bot)!.id;
    const command: Command = { type: 'fund_bot', playerId: botId, amount: 100 };
    const before = structuredClone(room);
    for (const actor of ['guest', botId, 'outsider']) {
      expect(() => apply(room, actor, command)).toThrow();
      expect(room).toEqual(before);
    }
    expect(() => apply(room, 'host', { ...command, playerId: 'host' })).toThrow('Only practice bots');
    expect(() => apply(room, 'host', { ...command, playerId: 'guest' })).toThrow('Only practice bots');
    expect(() => apply(room, 'host', { ...command, playerId: 'missing' })).toThrow();
    room = apply(room, 'host', { type: 'remove_bot', playerId: botId });
    expect(() => apply(room, 'host', command)).toThrow('Take a seat');
    room = apply(room, 'host', { type: 'close' });
    expect(() => apply(room, 'host', command)).toThrow('closed');
  });

  test('refills use approved funding requests, balanced transfers, and virtual audit labels', () => {
    const room = bots(table());
    const bot = room.players.find(player => player.bot)!;
    const host = room.players.find(player => player.id === 'host')!;
    const result = step(room, 'host', { type: 'fund_bot', playerId: bot.id, amount: 125 });
    expect(result.room.players.find(player => player.id === bot.id)).toMatchObject({
      stack: 1125, buyIns: 1125, rebuyCount: 0, addOnCount: 1,
    });
    expect(result.room.players.find(player => player.id === 'host')).toEqual(host);
    expect(result.room.requests.at(-1)).toMatchObject({ playerId: bot.id, amount: 125, kind: 'add_on', status: 'applied' });
    expect(result.transfers).toEqual([expect.objectContaining({
      from: 'bank', to: `player:${bot.id}`, playerId: bot.id, chips: 125, kind: 'add_on',
      cashCents: 125 * room.settings.chipValueCents, note: `${bot.name}: virtual practice add on`,
    })]);
    expect(result.events.every(event => event.message.includes('virtual practice'))).toBe(true);
    expect(result.events[0]?.actorId).toBe('host');
    expect(roomView(result.room, 'host', new Set()).players.find(player => player.id === bot.id)?.net).toBe(0);
    const removed = step(result.room, 'host', { type: 'remove_bot', playerId: bot.id });
    expect(removed.transfers[0]).toMatchObject({
      kind: 'cash_out', chips: 1125, from: `player:${bot.id}`, to: 'bank',
      note: `${bot.name} cashed out (virtual practice)`,
    });
  });

  test('busted bots can rebuy and subsequent refills count as add-ons exactly once', () => {
    let { room, botId } = bustBot();
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 99 })).toThrow('valid amount');
    const result = step(room, 'host', { type: 'fund_bot', playerId: botId, amount: 100 });
    expect(result.transfers[0]).toMatchObject({ kind: 'rebuy', chips: 100 });
    expect(result.room.requests.at(-1)).toMatchObject({ kind: 'rebuy', status: 'applied' });
    room = apply(result.room, 'host', { type: 'fund_bot', playerId: botId, amount: 1 });
    expect(room.players.find(player => player.id === botId)).toMatchObject({
      stack: 101, buyIns: 1101, rebuyCount: 1, addOnCount: 1,
    });
    room = apply(room, 'host', { type: 'deal' });
    expect(room.hand?.players.map(player => player.id)).toContain(botId);
  });

  test('a stalled auto-deal can resume after an explicit rebuy without resetting its schedule', () => {
    let { room, botId } = bustBot({ autoDeal: true });
    const nextHandAt = room.nextHandAt;
    expect(nextHandAt).not.toBeNull();
    expect(room.players.filter(player => player.stack > 0 && !player.sittingOut)).toHaveLength(1);
    expect(() => apply(room, 'host', { type: 'deal' })).toThrow('Two funded');
    room = apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 100 });
    expect(room.nextHandAt).toBe(nextHandAt);
    expect(room.players.filter(player => player.stack > 0 && !player.sittingOut)).toHaveLength(2);
    room = apply(room, 'host', { type: 'deal' }, { system: true });
    expect(room.handNumber).toBe(2);
    expect(room.hand?.players.map(player => player.id)).toContain(botId);
  });

  test('disabled rebuys are enforced without changing the human add-on rules', () => {
    const busted = bustBot();
    const room = changeSettings(busted.room, { allowRebuys: false });
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: busted.botId, amount: 100 })).toThrow('Rebuys are disabled');
    let funded = bots(table({ allowRebuys: false }));
    const botId = funded.players[1]!.id;
    funded = apply(funded, 'host', { type: 'fund_bot', playerId: botId, amount: 1 });
    expect(funded.players[1]?.addOnCount).toBe(1);
    funded = apply(funded, 'guest', { type: 'join', name: 'Human guest' });
    funded = apply(funded, 'guest', { type: 'fund', amount: 500 });
    expect(funded.requests.at(-1)).toMatchObject({ playerId: 'guest', kind: 'buy_in', status: 'pending' });
    expect(funded.players.find(player => player.id === 'guest')?.stack).toBe(0);
    const result = step(funded, 'host', { type: 'approve', requestId: funded.requests.at(-1)!.id, approve: true });
    expect(result.transfers[0]?.note).toBe('Human guest: buy in');
    expect(result.room.players.find(player => player.id === 'guest')?.stack).toBe(500);
  });

  test('funding caps, integer amounts, and outstanding requests cannot be bypassed', () => {
    let room = bots(table());
    const botId = room.players[1]!.id;
    const before = structuredClone(room);
    for (const amount of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1001, 10000001]) {
      expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount })).toThrow();
      expect(room).toEqual(before);
    }
    room = apply(room, botId, { type: 'fund', amount: 100 });
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 100 })).toThrow('request waiting');
    room = apply(room, 'host', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: false });
    room = apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 1000 });
    expect(room.players[1]?.stack).toBe(2000);
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 1 })).toThrow('stack cap');
  });

  test('no chips can be refilled during a live or paused hand', () => {
    let room = bots(table());
    const botId = room.players[1]!.id;
    room = apply(room, 'host', { type: 'deal' });
    for (const paused of [false, true]) {
      room = apply(room, 'host', { type: 'pause', value: paused });
      const before = structuredClone(room);
      expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 100 })).toThrow('between hands');
      expect(room).toEqual(before);
    }
  });

  test('refills respect the lifetime funding limit even after earlier cash-outs', () => {
    let room = table({ minBuyIn: 10000000, maxBuyIn: 10000000 }, 10000000);
    for (let i = 1; i < 99; i++) {
      room = apply(room, 'host', { type: 'cash_out' });
      room = apply(room, 'host', { type: 'join', name: 'Host' });
      room = apply(room, 'host', { type: 'fund', amount: 10000000 });
    }
    room = bots(room);
    const before = structuredClone(room);
    expect(room.players.reduce((sum, player) => sum + player.buyIns, 0)).toBe(1000000000);
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: room.players[1]!.id, amount: 1 })).toThrow('lifetime funding limit');
    expect(room).toEqual(before);
  });

  test.each([2, 3, 4, 9])('%i-seat tables admit only the available practice seats', seats => {
    const room = bots(table({ maxSeats: seats }), seats - 1);
    expect(room.players).toHaveLength(seats);
    expect(new Set(room.players.map(player => player.seat)).size).toBe(seats);
    expect(() => bots(room)).toThrow('table is full');
  });

  test('uneven bot refills preserve side-pot eligibility and payouts', () => {
    let room = bots(table({ smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 1000 }), 3);
    const [first, second, third] = room.players.filter(player => player.bot).map(player => player.id) as [string, string, string];
    room = apply(room, 'host', { type: 'sit_out', value: true });
    room = apply(room, 'host', { type: 'fund_bot', playerId: second, amount: 200 });
    room = apply(room, 'host', { type: 'fund_bot', playerId: third, amount: 400 });
    room = apply(room, 'host', { type: 'deal' }, { deck: rig(['Kc', 'Qc', 'Ac', 'Kd', 'Qd', 'Ad', '2s', '2c', '3d', '7h', '4s', '9c', '5s', 'Ts']) });
    room = apply(room, first, { type: 'act', action: 'raise', amount: 200 });
    room = apply(room, second, { type: 'act', action: 'raise', amount: 400 });
    room = apply(room, third, { type: 'act', action: 'call' });
    expect(room.hand?.results.map(pot => [pot.amount, pot.winners])).toEqual([[600, [first]], [400, [second]]]);
    expect(room.players.filter(player => player.bot).map(player => player.stack)).toEqual([600, 400, 200]);
    expect(room.players[0]?.stack).toBe(1000);
  });
});

describe('redacted bot decisions and sustained practice', () => {
  test('decision randomness is injectable without changing the one-argument API or view', () => {
    let room = bots(table());
    room = apply(room, 'host', { type: 'deal' });
    room = apply(room, 'host', { type: 'act', action: 'call' });
    const botId = room.players[1]!.id;
    const view = roomView(room, botId, new Set());
    const before = structuredClone(view);
    expect(chooseBotAction(view, () => 0.9)).toEqual({ type: 'act', action: 'check' });
    expect(chooseBotAction(view, randomSource(42))).toEqual(chooseBotAction(view, randomSource(42)));
    expect(() => apply(room, botId, chooseBotAction(view))).not.toThrow();
    expect(view).toEqual(before);
    for (const roll of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1])
      expect(() => chooseBotAction(view, () => roll)).toThrow('Bot randomness');
  });

  test('expired bot turns cannot call, raise, refill, or bypass the timeout', () => {
    let room = bots(table());
    room = apply(room, 'host', { type: 'deal' }, { deck: rig(['Kc', 'Ac', 'Kd', 'Ad', '2s', '2c', '3d', '7h', '4s', '9c', '5s', 'Ts']) });
    room = apply(room, 'host', { type: 'act', action: 'raise', amount: 100 });
    const botId = room.hand!.actorId!;
    const view = roomView(room, botId, new Set());
    const expiredAt = room.hand!.deadline!;
    const before = structuredClone(room);
    for (const roll of [0, 0.99]) {
      const command = chooseBotAction(view, () => roll);
      expect(['call', 'raise']).toContain(command.action);
      expect(() => apply(room, botId, command, { now: expiredAt, system: true })).toThrow('turn clock expired');
    }
    expect(() => apply(room, 'host', { type: 'fund_bot', playerId: botId, amount: 100 }, { now: expiredAt })).toThrow('between hands');
    expect(room).toEqual(before);
    const timed = timeoutTurn(room, expiredAt)!;
    assertRoom(timed.room);
    verifyTransfers(room, timed.room, timed.transfers);
    expect(timed.events.some(event => event.actorId === botId && event.message.includes('folded'))).toBe(true);
    expect(timed.transfers.some(entry => entry.from === `player:${botId}`)).toBe(false);
  });

  test('100 bot-only hands use legal redacted actions and explicit refills while the host observes', () => {
    const random = randomSource(7341);
    let room = bots(table({ smallBlind: 10, bigBlind: 20, minBuyIn: 20, maxBuyIn: 200, autoDeal: true }, 200), 3);
    room = apply(room, 'host', { type: 'sit_out', value: true });
    const hostBefore = structuredClone(room.players[0]!);
    let refills = 0;
    for (let hand = 0; hand < 100; hand++) {
      for (const bot of room.players.filter(player => player.bot && player.stack < 200)) {
        room = apply(room, 'host', { type: 'fund_bot', playerId: bot.id, amount: 200 - bot.stack });
        refills++;
      }
      room = apply(room, 'host', { type: 'deal' }, { deck: testDeck(random) });
      expect(room.hand?.players.some(player => player.id === 'host')).toBe(false);
      let turns = 0;
      while (room.hand?.street !== 'complete') {
        expect(++turns).toBeLessThan(300);
        const actor = room.hand!.actorId!;
        expect(room.players.find(player => player.id === actor)?.bot).toBe(true);
        const view = roomView(room, actor, new Set());
        expect(view.hand).not.toHaveProperty('deck');
        expect(view.hand).not.toHaveProperty('burned');
        expect(view.hand).not.toHaveProperty('holeCards');
        for (const player of view.players.filter(player => player.id !== actor && player.hand))
          expect(player.cards).toEqual([null, null]);
        const privateCards = [...room.hand!.deck, ...room.hand!.burned,
          ...Object.entries(room.hand!.holeCards).filter(([id]) => id !== actor).flatMap(([, cards]) => cards)];
        const serialized = JSON.stringify(view);
        for (const card of privateCards) expect(serialized).not.toContain(`"${card}"`);
        room = apply(room, actor, chooseBotAction(view, random), { system: true });
      }
      expect(room.hand!.pot).toBe(0);
      expect(room.nextHandAt).not.toBeNull();
      expect(room.players[0]).toEqual(hostBefore);
    }
    expect(refills).toBeGreaterThan(0);
    expect(room.players.reduce((sum, player) => sum + player.rebuyCount + player.addOnCount, 0)).toBe(refills);
    room = apply(room, 'host', { type: 'close' });
    expect(room.players.every(player => player.stack === 0)).toBe(true);
    expect(room.players.reduce((sum, player) => sum + player.cashOuts, 0)).toBe(room.players.reduce((sum, player) => sum + player.buyIns, 0));
  });
});

describe('persisted practice command boundary', () => {
  let db: Database;
  let store: Store;
  let server: Awaited<ReturnType<typeof makeApp>>;
  let base: string;
  const origin = 'http://localhost:8080';
  type Guest = { user: Identity; cookie: string };
  async function request(path: string, body?: unknown, guest?: Guest) {
    return fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(guest ? { Cookie: guest.cookie, 'X-CSRF-Token': guest.user.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function guest(name: string): Promise<Guest> {
    const response = await request('/auth/guest', { name });
    expect(response.status).toBe(200);
    const result = await response.json() as { user: Identity };
    return { user: result.user, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
  }
  async function create(host: Guest) {
    const response = await request('/rooms', {
      name: 'Bot command boundary', buyIn: 1000, commandId: randomUUID(),
      settings: { ...DEFAULT_SETTINGS, smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 2000, autoDeal: false },
    }, host);
    expect(response.status).toBe(201);
    return (await response.json() as { room: RoomView }).room;
  }
  async function command(room: RoomView, actor: Guest, command: Command, commandId = randomUUID()) {
    return request(`/rooms/${room.id}/commands`, { expectedVersion: room.version, commandId, command }, actor);
  }
  async function next(room: RoomView, actor: Guest, value: Command) {
    const response = await command(room, actor, value);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json() as { room: RoomView }).room;
  }
  beforeAll(async () => {
    db = await openDatabase({ directory: ':memory:' });
    store = new Store(db);
    server = await makeApp(store, { origin, production: false, trustProxy: false, scheduler: false });
    await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve));
    const address = server.http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server port.');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await server?.close(); await db?.close(); });

  test('HTTP refills are host-only, versioned, idempotent, ledger-backed, and hash-audited', async () => {
    const host = await guest('Practice host');
    const other = await guest('Practice guest');
    let room = await next(await create(host), host, { type: 'add_bot' });
    const joined = await request('/rooms/join', { code: room.code, commandId: randomUUID() }, other);
    expect(joined.status).toBe(200);
    room = (await joined.json() as { room: RoomView }).room;
    const bot = room.players.find(player => player.bot)!;
    const refill: Command = { type: 'fund_bot', playerId: bot.id, amount: 100 };
    const originalLedger = (await store.ledger(room.id)).entries;
    expect((await command(room, other, refill)).status).toBe(403);
    expect((await command(room, host, { ...refill, playerId: other.user.id })).status).toBe(400);
    expect((await command(room, host, { ...refill, amount: 0 })).status).toBe(400);
    expect((await store.ledger(room.id)).entries).toEqual(originalLedger);
    const commandId = randomUUID();
    const approved = await command(room, host, refill, commandId);
    expect(approved.status).toBe(200);
    const after = (await approved.json() as { room: RoomView }).room;
    expect(after.players.find(player => player.id === bot.id)).toMatchObject({ stack: 1100, buyIns: 1100, addOnCount: 1, rebuyCount: 0 });
    const repeated = await command(room, host, refill, commandId);
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect((await command(room, host, refill)).status).toBe(409);
    expect((await command(after, host, { ...refill, amount: 200 }, commandId)).status).toBe(409);
    const ledger = (await store.ledger(room.id)).entries;
    expect(ledger).toHaveLength(originalLedger.length + 1);
    expect(ledger[0]).toMatchObject({ kind: 'add_on', chips: 100, from: 'bank', to: `player:${bot.id}`, note: `${bot.name}: virtual practice add on` });
    expect((await store.audit(room.id)).entries[0]).toMatchObject({ actorId: host.user.id, command: 'fund_bot' });
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
    const saved = await store.getRoom(room.id);
    verifyTransfers(null, saved, [...ledger].reverse());
    const exported = await request(`/rooms/${room.id}/export.json`, undefined, host);
    const text = await exported.text();
    expect(text).toContain('virtual practice');
    expect(text).toContain('fund_bot');
    expect(text).not.toContain('"deck"');
    expect(text).not.toContain('"holeCards"');
  });

  test('expired host sessions cannot refill bots or change saved accounting', async () => {
    const host = await guest('Expired practice host');
    const room = await next(await create(host), host, { type: 'add_bot' });
    const ledger = (await store.ledger(room.id)).entries;
    await db.query("UPDATE rr_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id=$1", [host.user.id]);
    expect((await command(room, host, { type: 'fund_bot', playerId: room.players[1]!.id, amount: 100 })).status).toBe(401);
    expect((await store.ledger(room.id)).entries).toEqual(ledger);
    expect((await store.getRoom(room.id)).version).toBe(room.version);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });
});
