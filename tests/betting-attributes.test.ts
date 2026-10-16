import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS, defaultHandRules, isPotLimit, postflopCapRemaining, rulesGameLabel,
  type Command, type HandRules, type Room, type RoomSettings,
} from '../src/shared/model';
import { makeDeck } from '../src/server/cards';
import { assertRoom, createRoom, legalActions, roomView, transition } from '../src/server/engine';
import { chooseBotAction } from '../src/server/bot';
import { normalizeRoom, ROOM_SCHEMA_VERSION } from '../src/server/state';
import { verifyTransfers } from '../src/server/store';
import { commandSchema } from '../src/server/validation';
import { canPremove } from '../src/client/premoves';

let now = 1_800_000_000_000;
function apply(room: Room, actor: string, command: Command, deck?: string[]) {
  const result = transition(room, actor, command, { now: ++now, deck });
  assertRoom(result.room);
  verifyTransfers(room, result.room, result.transfers);
  return result.room;
}
function table(stacks = [1000, 1000], rules: Partial<HandRules> = {}, settings: Partial<RoomSettings> = {}) {
  const created = createRoom({
    id: 'betting-attributes', code: 'BETCAP01', name: 'Betting attributes', hostId: 'p0', hostName: 'Host', buyIn: stacks[0]!,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 1_000_000, autoDeal: false, ...settings },
  }, { now: ++now });
  verifyTransfers(null, created.room, created.transfers);
  let room = created.room;
  for (let index = 1; index < stacks.length; index++) {
    room = apply(room, `p${index}`, { type: 'join', name: `Player ${index}` });
    room = apply(room, `p${index}`, { type: 'fund', amount: stacks[index]! });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return apply(room, 'p0', { type: 'next_hand', rules: { ...room.nextHandRules, ...rules } });
}
const deal = (room: Room) => apply(room, 'p0', { type: 'deal' }, makeDeck());
const act = (room: Room, action: 'check' | 'call' | 'raise' | 'fold', amount?: number) =>
  apply(room, room.hand!.actorId!, { type: 'act', action, amount });
function flop(room: Room) {
  for (let turns = 0; room.hand!.street === 'preflop'; turns++) {
    expect(turns).toBeLessThan(10);
    room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  expect(room.hand!.street).toBe('flop');
  return room;
}
function checkDown(room: Room) {
  for (let turns = 0; room.hand!.street !== 'complete'; turns++) {
    expect(turns).toBeLessThan(30);
    room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  return room;
}
const spent = (room: Room) => room.hand!.players.map(player => player.postflopCommitted);

describe('independent Omaha and pot-limit attributes', () => {
  test.each([
    ['holdem', false, 2], ['holdem', true, 2], ['omaha', false, 4], ['omaha', true, 4],
  ] as const)('%s with potLimit=%s keeps its card rules and independent betting limit', (game, potLimit, count) => {
    const room = deal(table(undefined, { game, potLimit }));
    expect(Object.values(room.hand!.holeCards).every(cards => cards.length === count)).toBe(true);
    const legal = legalActions(room, room.hand!.actorId!);
    expect(legal.bettingLimit).toBe(potLimit ? 'pot_limit' : 'no_limit');
    if (potLimit) {
      expect(legal.maxRaiseTo).toBeLessThan(legal.allInTo);
      expect(legal.canAllIn).toBe(false);
      expect(() => act(room, 'raise', legal.allInTo)).toThrow('not available');
    } else {
      expect(legal.maxRaiseTo).toBe(legal.allInTo);
      expect(legal.canAllIn).toBe(true);
      expect(act(room, 'raise', legal.allInTo).players.find(player => player.id === room.hand!.actorId)!.stack).toBe(0);
    }
  });

  test('no-limit Omaha uses the same exactly-two-plus-three evaluation as pot-limit Omaha', () => {
    const limited = checkDown(deal(table(undefined, { game: 'omaha', potLimit: true })));
    const unlimited = checkDown(deal(table(undefined, { game: 'omaha', potLimit: false })));
    expect(unlimited.hand!.holeCards).toEqual(limited.hand!.holeCards);
    expect(unlimited.hand!.results).toEqual(limited.hand!.results);
    expect(rulesGameLabel(unlimited.hand!.rules)).toBe('No-limit Omaha');
    expect(rulesGameLabel({ ...defaultHandRules(), potLimit: true })).toBe("Pot-limit Hold'em");
  });
});

describe('per-player cumulative post-flop cap', () => {
  test('excludes antes and preflop raises, carries the remaining cap across all streets, and freezes active rules', () => {
    let room = deal(table(undefined, { postflopCap: 100 }, { ante: 5 }));
    room = act(room, 'raise', 300);
    room = act(room, 'call');
    expect(room.hand!.street).toBe('flop');
    expect(spent(room)).toEqual([0, 0]);
    expect(room.hand!.players.map(player => player.committed)).toEqual([305, 305]);
    expect(legalActions(room, 'p1').allInTo).toBe(100);
    room = act(room, 'raise', 50);
    room = act(room, 'call');
    expect(room.hand!.street).toBe('turn');
    expect(spent(room)).toEqual([50, 50]);
    room = apply(room, 'p0', { type: 'next_hand', rules: { ...room.nextHandRules, postflopCap: 500, potLimit: true } });
    expect(room.hand!.rules.postflopCap).toBe(100);
    expect(isPotLimit(room.hand!.rules)).toBe(false);
    room = act(room, 'check');
    room = act(room, 'raise', 30);
    room = act(room, 'call');
    expect(room.hand!.street).toBe('river');
    expect(spent(room)).toEqual([80, 80]);
    expect(legalActions(room, 'p1')).toMatchObject({ maxRaiseTo: 20, allInTo: 20, canAllIn: true });
    expect(() => act(room, 'raise', 21)).toThrow('not available');
    room = act(room, 'raise', 20);
    expect(canPremove(roomView(room, 'p1', new Set(), now))).toBe(false);
    expect(postflopCapRemaining(room.hand, room.hand!.players[1]!)).toBe(0);
    room = act(room, 'call');
    expect(room.hand!.street).toBe('complete');
    expect(spent(room)).toEqual([100, 100]);
    expect(room.hand!.awardedPot).toBe(810);
    expect(room.players.every(player => player.stack >= 595)).toBe(true);
    room = deal(room);
    expect(room.hand!.rules).toMatchObject({ postflopCap: 500, potLimit: true });
    expect(spent(room)).toEqual([0, 0]);
  });

  test('a cap below the minimum bet is a legal capped all-in and offers runouts without consuming unused stacks', () => {
    let room = flop(deal(table(undefined, { postflopCap: 5, maxRunouts: 3 })));
    expect(legalActions(room, 'p1')).toMatchObject({ minRaiseTo: 20, maxRaiseTo: 5, allInTo: 5, canRaise: true, canAllIn: true });
    room = act(room, 'raise', 5);
    expect(room.players.find(player => player.id === 'p1')!.stack).toBe(975);
    expect(room.hand!.players[1]!.lastAction).toBe('Capped');
    expect(legalActions(room, 'p0')).toMatchObject({ callAmount: 5, canRaise: false, canAllIn: true });
    const invalid = structuredClone(room);
    invalid.hand!.actorId = 'p1';
    expect(() => assertRoom(invalid)).toThrow('active betting turn');
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'flop', actorId: null, deadline: null, runoutVote: { eligible: ['p0', 'p1'], maxRuns: 3 } });
    expect(room.players.map(player => player.stack)).toEqual([975, 975]);
    room = apply(room, 'p0', { type: 'runouts', handId: room.hand!.id, count: 2 });
    room = apply(room, 'p1', { type: 'runouts', handId: room.hand!.id, count: 3 });
    expect(room.hand).toMatchObject({ street: 'complete', awardedPot: 50, runoutCount: 2 });
    expect(spent(room)).toEqual([5, 5]);
  });

  test.each(['holdem', 'omaha'] as const)('pot limit and the hard cap both constrain %s bets', game => {
    let room = flop(deal(table(undefined, { game, potLimit: true, postflopCap: 500 })));
    const pot = room.hand!.pot;
    expect(legalActions(room, room.hand!.actorId!)).toMatchObject({ maxRaiseTo: pot, allInTo: 500, canAllIn: false });
    room = act(room, 'raise', pot);
    room = act(room, 'call');
    expect(legalActions(room, room.hand!.actorId!).maxRaiseTo).toBe(Math.min(500 - pot, room.hand!.pot));
    const smaller = flop(deal(table(undefined, { game, potLimit: true, postflopCap: 10 })));
    expect(legalActions(smaller, smaller.hand!.actorId!)).toMatchObject({ maxRaiseTo: 10, allInTo: 10, canAllIn: true });
  });

  test('short stacks and capped stacks cover the correct side pots', () => {
    let room = flop(deal(table([1000, 70, 300], { postflopCap: 100 })));
    room = act(room, 'raise', 25);
    room = act(room, 'raise', 100);
    room = act(room, 'call');
    expect(legalActions(room, 'p1').callAmount).toBe(25);
    room = act(room, 'call');
    expect(room.hand!.street).toBe('complete');
    expect(spent(room)).toEqual([100, 50, 100]);
    expect(room.hand!.results.map(pot => pot.amount)).toEqual([210, 100]);
    expect(room.hand!.results[1]!.eligible).toEqual(['p0', 'p2']);
    expect(room.players[0]!.stack).toBeGreaterThanOrEqual(880);
    expect(room.players[2]!.stack).toBeGreaterThanOrEqual(180);
  });

  test('uncalled refunds reduce net post-flop commitments, never previously paid antes or matched preflop bets', () => {
    let room = flop(deal(table([1000, 60], { postflopCap: 100 })));
    room = act(room, 'check');
    room = act(room, 'raise', 100);
    expect(legalActions(room, 'p1').callAmount).toBe(40);
    room = act(room, 'call');
    expect(room.hand!.awardedPot).toBe(120);
    expect(spent(room)).toEqual([40, 40]);
    expect(room.hand!.players.map(player => player.committed)).toEqual([60, 60]);
    expect(room.players[0]!.stack).toBeGreaterThanOrEqual(940);
  });

  test('zero disables the cap, invalid caps/flags are rejected, and legacy Omaha remains pot limit', () => {
    const ready = table();
    for (const postflopCap of [-1, 0.5, Number.NaN, 10_000_001]) {
      const command = { type: 'next_hand' as const, rules: { ...ready.nextHandRules, postflopCap } };
      expect(commandSchema.safeParse(command).success).toBe(false);
      expect(() => apply(ready, 'p0', command)).toThrow('post-flop cap');
    }
    expect(commandSchema.safeParse({ type: 'next_hand', rules: { ...ready.nextHandRules, potLimit: 'yes' } }).success).toBe(false);
    const unlimited = flop(deal(ready));
    expect(legalActions(unlimited, 'p1').maxRaiseTo).toBe(980);
    const legacy = deal(table(undefined, { game: 'omaha' }));
    legacy.schemaVersion = 4;
    for (const player of legacy.hand!.players) Reflect.deleteProperty(player, 'postflopCommitted');
    Reflect.deleteProperty(legacy.hand!.rules, 'postflopCap');
    const normalized = normalizeRoom(structuredClone(legacy));
    assertRoom(normalized);
    expect(normalized.schemaVersion).toBe(ROOM_SCHEMA_VERSION);
    expect(normalized.hand!.rules.postflopCap).toBe(0);
    expect(spent(normalized)).toEqual([0, 0]);
    expect(legalActions(normalized, normalized.hand!.actorId!).bettingLimit).toBe('pot_limit');
    expect(normalized.hand!.holeCards).toEqual(legacy.hand!.holeCards);
    expect(normalized.players).toEqual(legacy.players);
  });

  test('mixed capped bot hands keep every action legal and reconcile every transfer', () => {
    for (let sample = 0; sample < 40; sample++) {
      let room = deal(table([500, 800, 1200], {
        game: sample % 2 ? 'omaha' : 'holdem', potLimit: sample % 3 === 0,
        indian: sample % 5 === 0, doubleBoard: sample % 4 === 0, bombPot: sample % 3 === 1,
        bombAnte: 25, postflopCap: [5, 55, 100, 500][sample % 4]!,
      }));
      for (let turns = 0; room.hand!.street !== 'complete'; turns++) {
        expect(turns).toBeLessThan(150);
        const actor = room.hand!.actorId!;
        const view = roomView(room, actor, new Set(), now);
        const command = chooseBotAction(view, () => ((turns * 19 + sample * 13) % 100) / 100);
        room = apply(room, actor, command);
      }
      expect(spent(room).every(amount => amount <= room.hand!.rules.postflopCap!)).toBe(true);
    }
  });
});
