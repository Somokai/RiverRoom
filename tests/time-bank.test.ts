import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Command, type Room, type RoomSettings } from '../src/shared/model';
import { makeDeck } from '../src/server/cards';
import { assertRoom, createRoom, legalActions, roomView, timeoutRunout, timeoutTurn, transition, validateSettings } from '../src/server/engine';
import { normalizeRoom, ROOM_SCHEMA_VERSION } from '../src/server/state';
import { verifyTransfers } from '../src/server/store';
import { commandSchema, settingsSchema } from '../src/server/validation';

function table(settings: Partial<RoomSettings> = {}, count = 2) {
  let now = 1_800_000_000_000;
  const created = createRoom({
    id: 'time-bank-room', code: 'BANK2345', name: 'Time banks', hostId: 'p0', hostName: 'Player 0', buyIn: 10000,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, turnSeconds: 15, autoDeal: false, ...settings },
  }, { now });
  verifyTransfers(null, created.room, created.transfers);
  let room = created.room;
  const send = (actor: string, command: Command, at = now + 1, system = false) => {
    now = at;
    const result = transition(room, actor, command, { now, system, deck: command.type === 'deal' ? makeDeck() : undefined });
    assertRoom(result.room);
    verifyTransfers(room, result.room, result.transfers);
    room = result.room;
    return result;
  };
  for (let index = 1; index < count; index++) {
    send(`p${index}`, { type: 'join', name: `Player ${index}` });
    send(`p${index}`, { type: 'fund', amount: 10000 });
    send('p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  const deal = () => send('p0', { type: 'deal' });
  const act = (action: Extract<Command, { type: 'act' }>['action'], at = now + 1, amount?: number) =>
    send(room.hand!.actorId!, { type: 'act', action, amount }, at);
  const finish = () => {
    for (let turns = 0; turns < 20 && room.hand?.street !== 'complete'; turns++) act('fold');
    expect(room.hand?.street).toBe('complete');
  };
  const timeout = (at: number) => {
    now = at;
    const result = timeoutTurn(room, at);
    if (result) {
      assertRoom(result.room);
      verifyTransfers(room, result.room, result.transfers);
      room = result.room;
    }
    return result;
  };
  return { get room() { return room; }, get now() { return now; }, send, deal, act, finish, timeout };
}

function withBank() {
  const game = table({ timeBankSeconds: 10, timeBankEveryHands: 2 });
  for (let hand = 0; hand < 2; hand++) { game.deal(); game.finish(); }
  game.deal();
  return game;
}

function settingsCommand(room: Room, changes: Partial<Extract<Command, { type: 'settings' }>> = {}): Extract<Command, { type: 'settings' }> {
  const { smallBlind, bigBlind, ante, autoDeal, turnSeconds, allowRebuys, timeBankSeconds, timeBankEveryHands } = room.settings;
  return { type: 'settings', smallBlind, bigBlind, ante, autoDeal, turnSeconds, allowRebuys, timeBankSeconds, timeBankEveryHands, ...changes };
}
const bank = (room: Pick<Room, 'players'>, id: string) => room.players.find(player => player.id === id)!;

describe('time-bank accrual and settings', () => {
  test('awards only after each player completes the configured number of participated hands', () => {
    const game = table({ timeBankSeconds: 7, timeBankEveryHands: 2 }, 3);
    game.send('p2', { type: 'sit_out', value: true });
    game.send('p3', { type: 'join', name: 'Unfunded player' });
    game.deal();
    expect(game.room.players.every(player => player.timeBankMs === 0)).toBe(true);
    game.finish();
    expect(bank(game.room, 'p0')).toMatchObject({ timeBankMs: 0, timeBankHandsPlayed: 1 });
    expect(bank(game.room, 'p1')).toMatchObject({ timeBankMs: 0, timeBankHandsPlayed: 1 });
    game.deal(); game.finish();
    expect(bank(game.room, 'p0')).toMatchObject({ timeBankMs: 7000, timeBankHandsPlayed: 0 });
    expect(bank(game.room, 'p1')).toMatchObject({ timeBankMs: 7000, timeBankHandsPlayed: 0 });
    for (const id of ['p2', 'p3']) expect(bank(game.room, id)).toMatchObject({ timeBankMs: 0, timeBankHandsPlayed: 0 });

    game.send('p2', { type: 'sit_out', value: false });
    game.deal();
    game.send('p1', { type: 'sit_out', value: true });
    game.send('p4', { type: 'join', name: 'Late player' });
    game.finish();
    expect(bank(game.room, 'p1').timeBankHandsPlayed).toBe(1);
    expect(bank(game.room, 'p2').timeBankHandsPlayed).toBe(1);
    expect(bank(game.room, 'p4').timeBankHandsPlayed).toBe(0);
    game.deal(); game.finish();
    expect(bank(game.room, 'p0')).toMatchObject({ timeBankMs: 14000, timeBankHandsPlayed: 0 });
    expect(bank(game.room, 'p1')).toMatchObject({ timeBankMs: 7000, timeBankHandsPlayed: 1 });
    expect(bank(game.room, 'p2')).toMatchObject({ timeBankMs: 7000, timeBankHandsPlayed: 0 });
  });

  test('unused normal-clock seconds never become banked time, and scheduled awards accumulate beyond a turn', () => {
    const game = withBank();
    for (let turns = 0; game.room.hand?.street !== 'complete' && turns < 20; turns++)
      game.act(legalActions(game.room, game.room.hand!.actorId!).canCheck ? 'check' : 'call');
    expect(game.room.hand!.street).toBe('complete');
    expect(game.room.players.every(player => player.timeBankMs === 10000)).toBe(true);
    expect(game.room.players.every(player => player.timeBankHandsPlayed === 1)).toBe(true);
    game.deal(); game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 20000)).toBe(true);
    expect(game.room.players.every(player => player.timeBankMs > game.room.settings.turnSeconds * 1000)).toBe(true);
  });

  test('clock and accrual changes are frozen until the next hand; older settings clients preserve them', () => {
    const game = table({ timeBankSeconds: 10, timeBankEveryHands: 2 });
    game.deal(); game.finish(); game.deal();
    const clock = structuredClone(game.room.hand!.clock);
    const deadline = game.room.hand!.deadline;
    game.send('p0', settingsCommand(game.room, { turnSeconds: 30, timeBankSeconds: 25, timeBankEveryHands: 1 }));
    expect(game.room.hand!.clock).toEqual(clock);
    expect(game.room.hand!.deadline).toBe(deadline);
    game.act('call');
    expect(game.room.hand!.baseDeadline).toBe(game.now + 15000);
    game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 10000)).toBe(true);
    game.deal();
    expect(game.room.hand!.clock).toEqual({ turnSeconds: 30, timeBankSeconds: 25, timeBankEveryHands: 1 });
    expect(game.room.hand!.baseDeadline).toBe(game.now + 30000);
    expect(game.room.hand!.deadline).toBe(game.now + 40000);
    const { timeBankSeconds: _seconds, timeBankEveryHands: _hands, ...legacyCommand } = settingsCommand(game.room);
    game.send('p0', legacyCommand);
    expect(game.room.settings).toMatchObject({ timeBankSeconds: 25, timeBankEveryHands: 1 });
    game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 35000)).toBe(true);
  });

  test('zero disables future awards without deleting earned time or progress', () => {
    const game = withBank();
    game.finish();
    game.send('p0', settingsCommand(game.room, { timeBankSeconds: 0 }));
    game.deal();
    expect(game.room.hand!.deadline! - game.room.hand!.baseDeadline!).toBe(10000);
    game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 10000 && player.timeBankHandsPlayed === 1)).toBe(true);
    game.send('p0', settingsCommand(game.room, { timeBankSeconds: 3 }));
    game.deal(); game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 13000 && player.timeBankHandsPlayed === 0)).toBe(true);
  });

  test.each([
    { timeBankSeconds: -1 }, { timeBankSeconds: 1.5 }, { timeBankSeconds: 3601 }, { timeBankSeconds: Number.NaN },
    { timeBankEveryHands: 0 }, { timeBankEveryHands: -1 }, { timeBankEveryHands: 1.5 }, { timeBankEveryHands: 1001 },
  ])('rejects invalid time-bank settings: %j', changes => {
    const game = table();
    const before = structuredClone(game.room);
    expect(settingsSchema.safeParse({ ...game.room.settings, ...changes }).success).toBe(false);
    expect(commandSchema.safeParse(settingsCommand(game.room, changes)).success).toBe(false);
    expect(() => game.send('p0', settingsCommand(game.room, changes))).toThrow('time bank');
    expect(game.room).toEqual(before);
  });

  test('defaults remain off, limits are accepted, and only the host can change accrual', () => {
    const game = table();
    expect(settingsSchema.parse({})).toMatchObject({ timeBankSeconds: 0, timeBankEveryHands: 10 });
    expect(() => validateSettings({ ...game.room.settings, timeBankSeconds: 3600, timeBankEveryHands: 1000 })).not.toThrow();
    expect(() => game.send('p1', settingsCommand(game.room, { timeBankSeconds: 10 }))).toThrow('Only the host');
    game.deal(); game.finish();
    expect(game.room.players.every(player => player.timeBankMs === 0 && player.timeBankHandsPlayed === 0)).toBe(true);
  });
});

describe('authoritative time-bank consumption', () => {
  test.each([-1, 0, 1250])('only charges milliseconds beyond the normal boundary: offset %i', offset => {
    const game = withBank();
    const before = structuredClone(game.room);
    const actor = game.room.hand!.actorId!;
    const at = game.room.hand!.baseDeadline! + offset;
    const expected = 10000 - Math.max(0, offset);
    const view = roomView(game.room, actor, new Set(), at);
    expect(bank(view, actor).timeBankMs).toBe(expected);
    expect(view.hand).not.toHaveProperty('deck');
    expect(view.hand).not.toHaveProperty('holeCards');
    expect(game.room).toEqual(before);
    game.act('call', at);
    expect(bank(game.room, actor).timeBankMs).toBe(expected);
    expect(bank(game.room, game.room.hand!.actorId!).timeBankMs).toBe(10000);
    expect(game.room.hand!.deadline! - game.room.hand!.baseDeadline!).toBe(10000);
  });

  test('refreshes and unrelated commands neither double-charge nor reset an active bank', () => {
    const game = withBank();
    const actor = game.room.hand!.actorId!;
    const base = game.room.hand!.baseDeadline!;
    const deadline = game.room.hand!.deadline!;
    game.send('p1', { type: 'chat', message: 'Still thinking' }, base + 2000);
    for (const viewer of ['p0', 'p1']) {
      const view = roomView(game.room, viewer, new Set(), base + 3000);
      expect(bank(view, actor).timeBankMs).toBe(7000);
      expect(view.hand!.deadline).toBe(deadline);
    }
    expect(bank(game.room, actor).timeBankMs).toBe(10000);
    game.act('raise', base + 4321, 40);
    expect(bank(game.room, actor).timeBankMs).toBe(5679);
    game.act('call');
    expect(bank(game.room, actor).timeBankMs).toBe(5679);
  });

  test('rejects invalid actions and expired calls/raises without granting extra time or spending chips', () => {
    const game = withBank();
    const before = structuredClone(game.room);
    const actor = game.room.hand!.actorId!;
    const base = game.room.hand!.baseDeadline!;
    const deadline = game.room.hand!.deadline!;
    expect(() => game.act('raise', base + 1000, 1)).toThrow();
    expect(game.room).toEqual(before);
    expect(game.timeout(base)).toBeNull();
    expect(game.timeout(deadline - 1)).toBeNull();
    for (const system of [false, true])
      for (const action of ['call', 'raise'] as const)
        expect(() => game.send(actor, { type: 'act', action, amount: 40 }, deadline, system)).toThrow('turn clock expired');
    const result = game.timeout(deadline)!;
    expect(result.transfers.some(transfer => transfer.kind === 'bet')).toBe(false);
    expect(game.room.hand!.street).toBe('complete');
    expect(bank(game.room, actor)).toMatchObject({ timeBankMs: 0, timeoutCount: 1, timeBankHandsPlayed: 1 });
    expect(game.timeout(deadline + 1000)).toBeNull();
  });

  test('full exhaustion checks for free, and only actual timeouts count toward sitting out', () => {
    const game = withBank();
    game.act('call');
    const actor = game.room.hand!.actorId!;
    expect(game.timeout(game.room.hand!.baseDeadline!)).toBeNull();
    expect(bank(game.room, actor).timeoutCount).toBe(0);
    const first = game.timeout(game.room.hand!.deadline!)!;
    expect(first.events[0]!.message).toContain('checked');
    expect(bank(game.room, actor)).toMatchObject({ timeBankMs: 0, timeoutCount: 1, sittingOut: false });
    expect(game.room.hand!.actorId).toBe(actor);
    expect(game.room.hand!.deadline).toBe(game.room.hand!.baseDeadline);
    game.timeout(game.room.hand!.deadline!);
    expect(bank(game.room, actor)).toMatchObject({ timeBankMs: 0, timeoutCount: 2, sittingOut: true });
  });

  test('pauses charge elapsed bank once, preserve the reserve, and resume with the usual fresh normal clock', () => {
    const game = withBank();
    const actor = game.room.hand!.actorId!;
    game.send('p0', { type: 'pause', value: true }, game.room.hand!.baseDeadline! + 3250);
    expect(bank(game.room, actor).timeBankMs).toBe(6750);
    expect(game.room.hand).toMatchObject({ baseDeadline: null, deadline: null });
    game.send('p0', { type: 'pause', value: true }, game.now + 100000);
    expect(bank(roomView(game.room, actor, new Set(), game.now + 100000), actor).timeBankMs).toBe(6750);
    expect(game.timeout(game.now + 100000)).toBeNull();
    expect(() => game.act('call')).toThrow('paused');
    game.send('p0', { type: 'pause', value: false });
    const resumed = game.room.hand!.baseDeadline!;
    expect(game.room.hand!.deadline).toBe(game.now + 15000 + 6750);
    game.send('p0', { type: 'pause', value: false }, game.now + 1000);
    expect(game.room.hand!.baseDeadline).toBe(resumed);
    game.act('call', resumed + 500);
    expect(bank(game.room, actor).timeBankMs).toBe(6250);
  });

  test('a recovery pause never deducts downtime from the last saved bank', () => {
    const game = withBank();
    const actor = game.room.hand!.actorId!;
    game.send('p0', { type: 'pause', value: true }, game.room.hand!.deadline! + 86400000, true);
    expect(bank(game.room, actor).timeBankMs).toBe(10000);
    game.send('p0', { type: 'pause', value: false });
    expect(game.room.hand!.deadline).toBe(game.now + 25000);
  });

  test('runout choices never consume banked time or receive a bank extension', () => {
    const game = withBank();
    game.finish();
    game.send('p0', { type: 'next_hand', rules: { ...game.room.nextHandRules, maxRunouts: 2 } });
    game.deal();
    game.act('raise', game.now + 1, legalActions(game.room, game.room.hand!.actorId!).maxRaiseTo);
    game.act('call');
    const before = game.room;
    expect(before.hand).toMatchObject({ actorId: null, baseDeadline: null, deadline: null });
    expect(before.hand!.runoutVote!.deadline).toBe(game.now + 20000);
    expect(before.players.every(player => player.timeBankMs === 10000)).toBe(true);
    const expired = timeoutRunout(before, before.hand!.runoutVote!.deadline!)!;
    assertRoom(expired.room);
    verifyTransfers(before, expired.room, expired.transfers);
    expect(expired.room.players.every(player => player.timeBankMs === 20000)).toBe(true);
    expect(expired.room.hand!.street).toBe('complete');
  });
});

describe('time-bank persistence invariants and migration', () => {
  test('schema-five snapshots acquire empty banks without changing an existing turn deadline', () => {
    const game = table();
    game.deal();
    const { timeBankSeconds: _seconds, timeBankEveryHands: _hands, ...settings } = game.room.settings;
    const { clock: _clock, baseDeadline: _base, ...hand } = game.room.hand!;
    const saved = JSON.stringify({
      ...game.room, schemaVersion: 5, settings, hand,
      players: game.room.players.map(({ timeBankMs: _bank, timeBankHandsPlayed: _played, ...player }) => player),
    });
    const original: Room = JSON.parse(saved);
    const view = roomView(original, 'p0', new Set(), game.now);
    expect(JSON.stringify(original)).toBe(saved);
    expect(view.schemaVersion).toBe(ROOM_SCHEMA_VERSION);
    expect(view.players.every(player => player.timeBankMs === 0 && player.timeBankHandsPlayed === 0)).toBe(true);
    expect(view.hand).toMatchObject({
      baseDeadline: hand.deadline, deadline: hand.deadline,
      clock: { turnSeconds: 15, timeBankSeconds: 0, timeBankEveryHands: 10 },
    });
    const normalized = normalizeRoom(structuredClone(original));
    assertRoom(normalized);
    expect(normalizeRoom(structuredClone(normalized))).toEqual(normalized);
    expect(transition(original, 'p0', { type: 'act', action: 'fold' }, { now: game.now + 1 }).room.schemaVersion).toBe(ROOM_SCHEMA_VERSION);
  });

  test.each([-1, 1.5, Number.NaN, Infinity])('rejects corrupt bank balances: %s', value => {
    const game = withBank();
    const invalid = structuredClone(game.room);
    invalid.players[0]!.timeBankMs = value;
    expect(() => assertRoom(invalid)).toThrow('time-bank balance');
  });

  test('rejects corrupt accrual progress and a deadline that does not reconcile with the bank', () => {
    const game = withBank();
    const invalid = structuredClone(game.room);
    invalid.players[0]!.timeBankHandsPlayed = 1000;
    expect(() => assertRoom(invalid)).toThrow('hand count');
    invalid.players[0]!.timeBankHandsPlayed = 0;
    invalid.hand!.deadline = invalid.hand!.deadline! + 1;
    expect(() => assertRoom(invalid)).toThrow('time-bank deadline');
  });
});
