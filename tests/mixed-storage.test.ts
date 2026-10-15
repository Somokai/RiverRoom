import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultHandRules, type ChipTransfer, type Command, type Hand, type HandHistory, type Identity, type Room, type RoomSettings } from '../src/shared/model';
import * as cards from '../src/server/cards';
import * as playerStats from '../src/server/stats';
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

describe('private player statistics', () => {
  const send = async (room: Room, actor: string, command: Command, commandId = randomUUID()) =>
    (await store.execute(room.id, actor, commandId, command, room.version)).room;

  test('counts voluntary preflop decisions, postflop actions and tied showdowns without counting forced contributions', async () => {
    const host = await fresh({ ante: 25 });
    const guest = await member(host.room);
    const prefix = ['2c', '3c', '4c', '5c', '6c', 'As', 'Ks', 'Qs', '7c', 'Js', '8c', 'Ts'];
    const deck = [...prefix, ...[...'23456789TJQKA'].flatMap(rank => [...'cdhs'].map(suit => rank + suit)).filter(card => !prefix.includes(card))];
    const shuffle = vi.spyOn(cards, 'shuffleDeck').mockReturnValueOnce(deck);
    let room: Room;
    try { room = await send(guest.room, host.identity.id, { type: 'deal' }); }
    finally { shuffle.mockRestore(); }
    expect((await store.playerStats(host.identity.id)).totals.hands).toBe(0);
    room = await send(room, host.identity.id, { type: 'act', action: 'call' });
    room = await send(room, guest.user.id, { type: 'act', action: 'check' });
    expect(room.hand?.street).toBe('flop');
    room = await send(room, guest.user.id, { type: 'act', action: 'raise', amount: 100 });
    room = await send(room, host.identity.id, { type: 'act', action: 'raise', amount: 300 });
    room = await send(room, guest.user.id, { type: 'act', action: 'call' });
    expect((await store.playerStats(host.identity.id)).totals.hands).toBe(0);
    room = await checkDown(room);
    expect(room.hand?.results[0]?.winners).toHaveLength(2);
    const owner = await store.playerStats(host.identity.id);
    expect(owner.totals).toEqual({
      hands: 1, preflopOpportunities: 1, vpipHands: 1, pfrHands: 0, postflopBetsRaises: 1,
      postflopCalls: 0, flopsSeen: 1, showdowns: 1, showdownsWon: 1, handsWon: 1,
    });
    expect(owner.games.find(group => group.game === 'holdem')?.counts).toEqual(owner.totals);
    expect(owner.games.filter(group => group.game !== 'holdem').every(group => group.counts.hands === 0)).toBe(true);
    expect((await store.playerStats(guest.user.id)).totals).toEqual({
      ...owner.totals, vpipHands: 0, postflopCalls: 1,
    });
    expect(owner.trackedSince).toBe(new Date(room.hand!.startedAt).toISOString());
    expect(owner.lastHandAt).toBe(new Date(room.hand!.completedAt!).toISOString());
    await send(room, host.identity.id, { type: 'close' });
    expect(await new Store(db).playerStats(host.identity.id)).toEqual(owner);
  });

  test('counts multiple raises once, ignores retried commands, and aggregates the same identity across tables', async () => {
    const host = await fresh();
    const guest = await member(host.room);
    let room = await send(guest.room, host.identity.id, { type: 'deal' });
    room = await send(room, host.identity.id, { type: 'act', action: 'raise', amount: 200 });
    room = await send(room, guest.user.id, { type: 'act', action: 'raise', amount: 400 });
    room = await send(room, host.identity.id, { type: 'act', action: 'raise', amount: 600 });
    const beforeFold = room;
    const commandId = randomUUID();
    room = await send(room, guest.user.id, { type: 'act', action: 'fold' }, commandId);
    const first = await store.playerStats(host.identity.id);
    const duplicate = await store.execute(room.id, guest.user.id, commandId, { type: 'act', action: 'fold' }, beforeFold.version);
    expect(duplicate.duplicate).toBe(true);
    expect(await store.playerStats(host.identity.id)).toEqual(first);
    expect(first.totals).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 1, preflopOpportunities: 1, handsWon: 1 });
    expect((await store.playerStats(guest.user.id)).totals).toMatchObject({ vpipHands: 1, pfrHands: 1, handsWon: 0, flopsSeen: 0 });

    let other = await store.create(host.identity, {
      name: 'Same player, another session', settings: { ...DEFAULT_SETTINGS, autoDeal: false }, buyIn: 1000, commandId: randomUUID(),
    });
    other = await send(other, host.identity.id, { type: 'add_bot' });
    other = await send(other, host.identity.id, { type: 'deal' });
    other = await send(other, host.identity.id, { type: 'act', action: 'fold' });
    expect((await store.playerStats(host.identity.id)).totals).toMatchObject({
      hands: 2, vpipHands: 1, pfrHands: 1, preflopOpportunities: 2, handsWon: 1,
    });
    expect((await store.playerStats(guest.user.id)).totals.hands).toBe(1);
    expect((await store.playerStats(other.players.find(player => player.bot)!.id)).totals.hands).toBe(0);
  });

  test('walks and timeout folds do not inflate VPIP, and folding on the flop is not a showdown', async () => {
    const host = await fresh();
    const guest = await member(host.room);
    let room = await send(guest.room, host.identity.id, { type: 'deal' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(room.hand!.deadline! + 1);
    try { room = (await store.timeout(room.id, room.version))!; }
    finally { clock.mockRestore(); }
    expect(room.hand?.street).toBe('complete');
    expect((await store.playerStats(host.identity.id)).totals).toMatchObject({ hands: 1, preflopOpportunities: 1, vpipHands: 0, flopsSeen: 0 });
    expect((await store.playerStats(guest.user.id)).totals).toMatchObject({ hands: 1, preflopOpportunities: 0, vpipHands: 0, handsWon: 1 });
    room = await send(room, host.identity.id, { type: 'deal' });
    room = await send(room, guest.user.id, { type: 'act', action: 'call' });
    room = await send(room, host.identity.id, { type: 'act', action: 'check' });
    room = await send(room, host.identity.id, { type: 'act', action: 'fold' });
    for (const id of [host.identity.id, guest.user.id])
      expect((await store.playerStats(id)).totals).toMatchObject({ hands: 2, flopsSeen: 1, showdowns: 0, showdownsWon: 0 });
  });

  test.each(['omaha', 'indian', 'omaha_bomb'] as const)('%s forced-ante all-ins count a hand and showdown but no preflop opportunity', async game => {
    const host = await fresh({}, 500);
    const guest = await member(host.room, 500);
    let room = await send(guest.room, host.identity.id, {
      type: 'next_hand', rules: { ...defaultHandRules(), game, omahaAnte: 500, indianAnte: 500, bombAnte: 500 },
    });
    room = await send(room, host.identity.id, { type: 'deal' });
    expect(room.hand?.street).toBe('complete');
    for (const id of [host.identity.id, guest.user.id]) {
      const stats = await store.playerStats(id);
      expect(stats.totals).toMatchObject({ hands: 1, preflopOpportunities: 0, vpipHands: 0, pfrHands: 0,
        postflopBetsRaises: 0, postflopCalls: 0, flopsSeen: 1, showdowns: 1 });
      expect(stats.games.find(group => group.game === game)?.counts).toEqual(stats.totals);
    }
  });

  test('side pots and three runouts are one hand, one flop and one showdown per player', async () => {
    const host = await fresh({}, 500);
    const guest = await member(host.room, 1000);
    const third = await member(guest.room, 1500);
    let room = await send(third.room, host.identity.id, { type: 'next_hand', rules: { ...defaultHandRules(), maxRunouts: 3 } });
    room = await send(room, host.identity.id, { type: 'deal' });
    room = await send(room, host.identity.id, { type: 'act', action: 'raise', amount: 500 });
    room = await send(room, guest.user.id, { type: 'act', action: 'raise', amount: 1000 });
    room = await send(room, third.user.id, { type: 'act', action: 'call' });
    expect(room.hand?.runoutVote?.maxRuns).toBe(3);
    const ids = [host.identity.id, guest.user.id, third.user.id];
    for (const id of ids) room = await send(room, id, { type: 'runouts', handId: room.hand!.id, count: 3 });
    expect(room.hand?.street).toBe('complete');
    expect(room.hand?.results.some(pot => pot.potIndex > 0)).toBe(true);
    expect(room.hand?.runoutCount).toBe(3);
    for (const id of ids) {
      const won = room.hand!.results.some(pot => (pot.shares[id] ?? 0) > 0) ? 1 : 0;
      expect((await store.playerStats(id)).totals).toEqual({
        hands: 1, preflopOpportunities: 1, vpipHands: 1, pfrHands: id === third.user.id ? 0 : 1,
        postflopBetsRaises: 0, postflopCalls: 0, flopsSeen: 1, showdowns: 1, showdownsWon: won, handsWon: won,
      });
    }
  });

  test('sitting-out and unfunded players are excluded; partial pre-upgrade hands are never backfilled', async () => {
    const host = await fresh();
    const guest = await member(host.room);
    const observer = await member(guest.room, 0);
    const sittingOut = await member(observer.room);
    let room = await send(sittingOut.room, sittingOut.user.id, { type: 'sit_out', value: true });
    room = await send(room, host.identity.id, { type: 'deal' });
    room = await send(room, host.identity.id, { type: 'act', action: 'call' });
    // Simulate a hand already in flight when this table was first installed.
    await db.query('DELETE FROM rr_player_hand_stats WHERE room_id=$1', [room.id]);
    room = await checkDown(room);
    expect((await store.hands(room.id)).entries).toHaveLength(1);
    for (const id of [host.identity.id, guest.user.id, observer.user.id, sittingOut.user.id])
      expect((await store.playerStats(id)).totals.hands).toBe(0);
    room = await send(room, host.identity.id, { type: 'deal' });
    room = await checkDown(room);
    expect((await store.playerStats(host.identity.id)).totals.hands).toBe(1);
    expect((await store.playerStats(guest.user.id)).totals.hands).toBe(1);
    expect((await store.playerStats(observer.user.id)).totals.hands).toBe(0);
    expect((await store.playerStats(sittingOut.user.id)).totals.hands).toBe(0);
    expect((await store.hands(room.id)).entries).toHaveLength(2);
    expect((await store.verifyAudit(room.id)).valid).toBe(true);
  });

  test('statistics failure rolls back the entire deal rather than losing player actions or chips', async () => {
    const host = await fresh();
    const guest = await member(host.room);
    const ledger = await store.ledger(guest.room.id);
    const audit = await store.audit(guest.room.id);
    const record = vi.spyOn(playerStats, 'recordPlayerStats').mockRejectedValueOnce(new Error('Synthetic statistics write failure'));
    try { await expect(send(guest.room, host.identity.id, { type: 'deal' })).rejects.toThrow('Synthetic statistics write failure'); }
    finally { record.mockRestore(); }
    expect(await store.getRoom(guest.room.id)).toEqual(guest.room);
    expect(await store.ledger(guest.room.id)).toEqual(ledger);
    expect(await store.audit(guest.room.id)).toEqual(audit);
    expect((await store.playerStats(host.identity.id)).totals.hands).toBe(0);
  });
});

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
