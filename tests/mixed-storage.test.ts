import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultHandRules, type ChipTransfer, type Hand, type HandHistory, type Identity, type Room, type RoomSettings } from '../src/shared/model';
import { openDatabase, type Database } from '../src/server/database';
import { legalActions } from '../src/server/engine';
import { normalizeHistory, ROOM_SCHEMA_VERSION } from '../src/server/state';
import { Store, verifyTransfers } from '../src/server/store';
import { settingsSchema } from '../src/server/validation';

let db: Database;
let store: Store;
beforeAll(async () => { db = await openDatabase({ directory: ':memory:' }); store = new Store(db); });
afterAll(async () => { await db.close(); });
async function fresh(overrides: Partial<RoomSettings> = {}, amount = 1000) {
  const identity = (await store.createIdentity('Migration host')).user;
  const room = await store.create(identity, {
    name: 'Mixed storage fixture', settings: { ...DEFAULT_SETTINGS, autoDeal: false, ...overrides },
    buyIn: amount, commandId: randomUUID(),
  });
  return { identity, room };
}
async function member(room: Room, amount = 1000) {
  const user = (await store.createIdentity('Migration guest')).user;
  let next = (await store.execute(room.id, user.id, randomUUID(), { type: 'join', name: user.name }, undefined)).room;
  if (amount > 0) {
    next = (await store.execute(room.id, user.id, randomUUID(), { type: 'fund', amount }, next.version)).room;
    next = (await store.execute(room.id, room.hostId, randomUUID(), { type: 'approve', requestId: next.requests.at(-1)!.id, approve: true }, next.version)).room;
  }
  return { user, room: next };
}
function oldHand(hand: Hand) {
  const {
    rules: _rules, boards: _boards, runoutBoards: _runs, runoutPrefix: _prefix, runoutCount: _count,
    runoutVote: _vote, preflopPotAdjustment: _adjustment, bounty: _bounty, bountyAfter: _bountyAfter,
    ...legacy
  } = hand;
  return { ...legacy, results: legacy.results.map(({ potIndex: _pot, boardIndex: _board, runoutIndex: _run, ...result }) => result) };
}
function oldRoom(room: Room) {
  const { schemaVersion: _schema, nextHandRules: _next, ...legacy } = structuredClone(room);
  return {
    ...legacy, players: legacy.players.map(({ bountyNet: _bounty, ...player }) => player),
    hand: legacy.hand ? oldHand(legacy.hand) : null,
  };
}
async function checkDown(room: Room) {
  for (let turn = 0; turn < 100 && room.hand?.street !== 'complete'; turn++) {
    const actor = room.hand!.actorId!;
    room = (await store.execute(room.id, actor, randomUUID(), {
      type: 'act', action: legalActions(room, actor).canCheck ? 'check' : 'call',
    }, room.version)).room;
  }
  expect(room.hand?.street).toBe('complete');
  return room;
}

describe('mixed-game persistence and migration', () => {
  test('the new default accepts a 500-chip initial buy-in and rejects 499', async () => {
    expect(DEFAULT_SETTINGS.minBuyIn).toBe(500);
    expect(settingsSchema.parse({}).minBuyIn).toBe(500);
    const host = await fresh({}, 500);
    const joined = await member(host.room, 0);
    await expect(store.execute(joined.room.id, joined.user.id, randomUUID(), { type: 'fund', amount: 499 }, joined.room.version)).rejects.toThrow('valid amount');
    let room = (await store.execute(joined.room.id, joined.user.id, randomUUID(), { type: 'fund', amount: 500 }, joined.room.version)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true }, room.version)).room;
    expect(room.players.find(player => player.id === joined.user.id)?.stack).toBe(500);
    expect((await store.ledger(room.id)).entries.map(entry => entry.chips)).toEqual([500, 500]);
  });

  test('an existing custom minimum can be lowered to 500 without changing balances', async () => {
    const host = await fresh({ minBuyIn: 4000 }, 4000);
    const before = structuredClone(host.room.players);
    const room = (await store.execute(host.room.id, host.identity.id, randomUUID(), {
      type: 'settings', smallBlind: 50, bigBlind: 100, ante: 0, autoDeal: false,
      turnSeconds: 45, allowRebuys: true, minBuyIn: 500,
    }, host.room.version)).room;
    expect(room.settings.minBuyIn).toBe(500);
    expect(room.players).toEqual(before);
    expect((await store.ledger(room.id)).entries).toHaveLength(1);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
    const guest = await member(room, 500);
    expect(guest.room.players.find(player => player.id === guest.user.id)?.buyIns).toBe(500);
  });

  test('legacy active hands migrate structurally without changing their cards, money, or configured limits', async () => {
    const host = await fresh({ minBuyIn: 4000 }, 4000);
    let room = (await member(host.room, 4000)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'deal' }, room.version)).room;
    const legacy = oldRoom(room);
    await db.query('UPDATE rr_rooms SET state=$2::jsonb WHERE id=$1', [room.id, JSON.stringify(legacy)]);
    const restored = await store.getRoom(room.id);
    expect(restored.schemaVersion).toBe(ROOM_SCHEMA_VERSION);
    expect(restored.settings.minBuyIn).toBe(4000);
    expect(restored.players.map(player => [player.stack, player.buyIns, player.cashOuts])).toEqual(room.players.map(player => [player.stack, player.buyIns, player.cashOuts]));
    expect(restored.players.every(player => player.bountyNet === 0)).toBe(true);
    expect(restored.hand?.rules).toMatchObject({ game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 });
    expect(restored.hand?.deck).toEqual(room.hand?.deck);
    expect(restored.hand?.holeCards).toEqual(room.hand?.holeCards);
    expect(restored.hand?.boards).toEqual([room.hand!.board]);
    expect(restored.hand?.actorId).toBe(room.hand?.actorId);
    const finished = await checkDown(restored);
    expect(finished.players.reduce((sum, player) => sum + player.stack, 0)).toBe(8000);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('legacy immutable histories are projected as one Holdem board without rewriting records', async () => {
    const host = await fresh();
    const raw = {
      id: randomUUID(), number: 1, board: ['As', 'Kh', 'Qc', 'Jd', 'Ts'], buttonSeat: 0,
      pot: 100, completedAt: Date.now(), revealed: {}, balanceAfter: { [host.identity.id]: 1000 },
      results: [{ amount: 100, eligible: [host.identity.id], winners: [host.identity.id],
        shares: { [host.identity.id]: 100 }, description: 'Uncontested' }],
    };
    await db.query('INSERT INTO rr_hands(room_id,hand_id,hand_number,summary) VALUES($1,$2,$3,$4::jsonb)',
      [host.room.id, raw.id, 1, JSON.stringify(raw)]);
    const history = (await store.hands(host.room.id)).entries[0]!;
    expect(history.rules.game).toBe('holdem');
    expect(history.runoutBoards).toEqual([[raw.board]]);
    expect(history.runoutCount).toBe(1);
    expect(history.bounty).toBeNull();
    expect(history.bountyAfter[host.identity.id]).toBe(0);
    expect(history.results[0]).toMatchObject({ potIndex: 0, boardIndex: 0, runoutIndex: 0 });
    const persisted = (await db.query<{ summary: Record<string, unknown> }>('SELECT summary FROM rr_hands WHERE room_id=$1', [host.room.id])).rows[0]!.summary;
    expect(persisted).not.toHaveProperty('rules');
    expect(normalizeHistory(history)).toEqual(history);
  });

  test('schema-two PLO keeps its active ante and ledger, while only future deals gain the mandatory round ante', async () => {
    const host = await fresh({ ante: 25 });
    let room = (await member(host.room)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), {
      type: 'next_hand', rules: { ...defaultHandRules(room.settings), game: 'omaha', omahaAnte: 25 },
    }, room.version)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'deal' }, room.version)).room;
    const old = structuredClone(room);
    old.schemaVersion = 2;
    delete (old.nextHandRules as unknown as Record<string, unknown>).omahaAnte;
    delete (old.hand!.rules as unknown as Record<string, unknown>).omahaAnte;
    const beforeLedger = (await store.ledger(room.id)).entries;
    const beforeAudit = (await store.audit(room.id)).entries;
    await db.query('UPDATE rr_rooms SET state=$2::jsonb WHERE id=$1', [room.id, JSON.stringify(old)]);
    const restored = await new Store(db).getRoom(room.id);
    expect(restored.schemaVersion).toBe(ROOM_SCHEMA_VERSION);
    expect(restored.nextHandRules.omahaAnte).toBe(100);
    expect(restored.hand).toEqual({ ...old.hand, rules: { ...old.hand!.rules, omahaAnte: 0 } });
    expect(restored.players).toEqual(old.players);
    expect((await store.ledger(room.id)).entries).toEqual(beforeLedger);
    expect((await store.audit(room.id)).entries).toEqual(beforeAudit);
    room = await checkDown(restored);
    expect((await store.hands(room.id)).entries[0]!.rules.omahaAnte).toBe(0);
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'deal' }, room.version)).room;
    expect(room.hand!.rules.omahaAnte).toBe(100);
    expect((await store.ledger(room.id)).entries.filter(entry => entry.handId === room.hand!.id && entry.kind === 'ante')
      .map(entry => entry.chips)).toEqual([100, 100]);
    expect(room.players.map(player => player.buyIns)).toEqual([1000, 1000]);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('schema-two one-card Indian history keeps its original cards and awards without rewriting immutable data', async () => {
    const host = await fresh();
    const { omahaAnte: _newAnte, ...oldRules } = { ...defaultHandRules(), game: 'indian' as const, indianAnte: 10 };
    const raw = {
      id: randomUUID(), number: 1, rules: oldRules, board: [], boards: [], runoutBoards: [[]], runoutCount: 1,
      bounty: null, bountyAfter: { [host.identity.id]: 0 }, showdown: false, buttonSeat: 0,
      pot: 20, completedAt: Date.now(), revealed: { [host.identity.id]: ['As'] },
      balanceAfter: { [host.identity.id]: 1010 },
      results: [{ potIndex: 0, boardIndex: 0, runoutIndex: 0, amount: 20, eligible: [host.identity.id],
        winners: [host.identity.id], shares: { [host.identity.id]: 20 }, description: 'Uncontested' }],
    };
    await db.query('INSERT INTO rr_hands(room_id,hand_id,hand_number,summary) VALUES($1,$2,$3,$4::jsonb)',
      [host.room.id, raw.id, raw.number, JSON.stringify(raw)]);
    const history = (await store.hands(host.room.id)).entries[0]!;
    expect(history).toEqual({ ...raw, rules: { ...oldRules, omahaAnte: 0 } });
    expect(normalizeHistory(history)).toEqual(history);
    const persisted = (await db.query<{ summary: unknown }>('SELECT summary FROM rr_hands WHERE room_id=$1', [host.room.id])).rows[0]!.summary;
    expect(persisted).toEqual(raw);
  });

  test('bounty settlement permits signed obligations but cannot alter chip accounts or disappear from net summaries', async () => {
    const host = await fresh();
    const paired = await member(host.room);
    const before = paired.room;
    const after = structuredClone(before);
    after.players[0]!.bountyNet = 200;
    after.players[1]!.bountyNet = -200;
    const entry: ChipTransfer = {
      kind: 'bounty', from: `bounty:${paired.user.id}`, to: `bounty:${host.identity.id}`,
      chips: 200, cashCents: 200, playerId: paired.user.id, handId: randomUUID(), note: '7-2 settlement fixture',
    };
    expect(() => verifyTransfers(before, after, [entry])).not.toThrow();
    expect(after.players.map(player => player.stack)).toEqual(before.players.map(player => player.stack));
    expect(() => verifyTransfers(before, after, [{ ...entry, kind: 'bet' }])).toThrow('Only bounty');
    expect(() => verifyTransfers(before, after, [{ ...entry, to: `player:${host.identity.id}` }])).toThrow('Invalid bounty');
    expect(() => verifyTransfers(before, after, [{ ...entry, cashCents: 0 }])).toThrow('Invalid bounty');
    await db.query('UPDATE rr_rooms SET state=$2::jsonb WHERE id=$1', [after.id, JSON.stringify(after)]);
    const summary = (await store.rooms(host.identity.id)).find(item => item.id === after.id)!;
    expect(summary).toMatchObject({ chipNet: 0, bountyNet: 200, net: 200 });
  });

  test('runout timeout settles atomically as system work and records all boards', async () => {
    const host = await fresh({}, 500);
    const paired = await member(host.room, 500);
    let room = (await store.execute(paired.room.id, host.identity.id, randomUUID(), {
      type: 'next_hand', rules: { ...defaultHandRules(paired.room.settings), maxRunouts: 3 },
    }, paired.room.version)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'deal' }, room.version)).room;
    room = (await store.execute(room.id, room.hand!.actorId!, randomUUID(), { type: 'act', action: 'raise', amount: 500 }, room.version)).room;
    room = (await store.execute(room.id, room.hand!.actorId!, randomUUID(), { type: 'act', action: 'call' }, room.version)).room;
    expect(room.hand?.runoutVote).not.toBeNull();
    const time = vi.spyOn(Date, 'now').mockReturnValue(room.hand!.runoutVote!.deadline! + 1);
    try { room = (await store.timeout(room.id, room.version))!; }
    finally { time.mockRestore(); }
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
    const audit = (await store.audit(room.id)).entries[0]!;
    expect(audit).toMatchObject({ actorId: 'system', command: 'runout_timeout' });
    const history = (await store.hands(room.id)).entries[0]!;
    expect(history.runoutCount).toBe(1);
    expect(history.runoutBoards[0]?.[0]).toEqual(room.hand!.board);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('pending runout consent survives restart pause and resolves only after resume', async () => {
    const host = await fresh({}, 500);
    const paired = await member(host.room, 500);
    let room = (await store.execute(paired.room.id, host.identity.id, randomUUID(), {
      type: 'next_hand', rules: { ...defaultHandRules(paired.room.settings), maxRunouts: 3 },
    }, paired.room.version)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'deal' }, room.version)).room;
    room = (await store.execute(room.id, room.hand!.actorId!, randomUUID(), { type: 'act', action: 'raise', amount: 500 }, room.version)).room;
    room = (await store.execute(room.id, room.hand!.actorId!, randomUUID(), { type: 'act', action: 'call' }, room.version)).room;
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'runouts', handId: room.hand!.id, count: 3 }, room.version)).room;
    await store.pauseAfterRestart();
    room = await store.getRoom(room.id);
    expect(room.paused).toBe(true);
    expect(room.hand!.runoutVote!.votes[host.identity.id]).toBe(3);
    expect(room.hand!.runoutVote!.deadline).toBeNull();
    expect(await store.timeout(room.id, room.version)).toBeNull();
    room = (await store.execute(room.id, host.identity.id, randomUUID(), { type: 'pause', value: false }, room.version)).room;
    room = (await store.execute(room.id, paired.user.id, randomUUID(), { type: 'runouts', handId: room.hand!.id, count: 2 }, room.version)).room;
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 2 });
    expect(room.hand!.runoutBoards).toHaveLength(2);
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(1000);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });
});
