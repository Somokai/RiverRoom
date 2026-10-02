import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, defaultHandRules, type Card, type Command, type HandRules, type Room, type RoomSettings, type RunoutCount } from '../src/shared/model';
import { chooseBotAction } from '../src/server/bot';
import { evaluateIndian, evaluateOmaha, makeDeck } from '../src/server/cards';
import { assertRoom, createRoom, legalActions, roomView, timeoutRunout, timeoutTurn, transition } from '../src/server/engine';
import { normalizeRoom } from '../src/server/state';
import { verifyTransfers } from '../src/server/store';

let now = 1_800_000_000_000;
function step(room: Room, actor: string, command: Command, deck?: Card[]) {
  const result = transition(room, actor, command, { now: ++now, deck });
  assertRoom(result.room);
  verifyTransfers(room, result.room, result.transfers);
  return result;
}
const apply = (room: Room, actor: string, command: Command, deck?: Card[]) => step(room, actor, command, deck).room;
const act = (room: Room, action: 'check' | 'call' | 'fold' | 'raise', amount?: number) =>
  apply(room, room.hand!.actorId!, { type: 'act', action, amount });
const deal = (room: Room, deck?: Card[]) => apply(room, 'p0', { type: 'deal' }, deck);
const choose = (room: Room, actor: string, count: RunoutCount) =>
  apply(room, actor, { type: 'runouts', handId: room.hand!.id, count });

function table(stacks = [1000, 1000], rules: Partial<HandRules> = {}, settings: Partial<RoomSettings> = {}) {
  const created = createRoom({
    id: 'focused', code: 'MIXED123', name: 'Mixed engine tests', hostId: 'p0', hostName: 'Player 0', buyIn: stacks[0]!,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 1_000_000, autoDeal: false, ...settings },
  }, { now: ++now });
  verifyTransfers(null, created.room, created.transfers);
  let room = created.room;
  for (let i = 1; i < stacks.length; i++) {
    room = apply(room, `p${i}`, { type: 'join', name: `Player ${i}` });
    room = apply(room, `p${i}`, { type: 'fund', amount: stacks[i]! });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return apply(room, 'p0', { type: 'next_hand', rules: { ...defaultHandRules(room.settings), ...rules } });
}
function rig(hands: string[], tail = '') {
  const cards = hands.map(hand => hand.split(' '));
  const prefix: Card[] = [];
  for (let round = 0; round < cards[0]!.length; round++)
    for (let player = 1; player <= cards.length; player++) prefix.push(cards[player % cards.length]![round]!);
  if (tail) prefix.push(...tail.split(' '));
  expect(new Set(prefix).size).toBe(prefix.length);
  return [...prefix, ...makeDeck().filter(card => !prefix.includes(card))];
}
function finish(room: Room, runs: RunoutCount = 1) {
  let turns = 0;
  while (room.hand!.street !== 'complete') {
    if (++turns > 200) throw new Error('Hand did not complete.');
    const vote = room.hand!.runoutVote;
    if (vote) room = choose(room, vote.eligible.find(id => !Object.hasOwn(vote.votes, id))!, Math.min(runs, vote.maxRuns) as RunoutCount);
    else room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  return room;
}
function allInOffer(rules: Partial<HandRules> = {}, deck?: Card[]) {
  let room = deal(table([1000, 1000], { maxRunouts: 3, ...rules }), deck);
  room = act(room, 'raise', 1000);
  expect(room.hand!.runoutVote).toBeNull();
  room = act(room, 'call');
  expect(room.hand!.runoutVote).not.toBeNull();
  return room;
}

describe('focused variant evaluators and betting limits', () => {
  test('Omaha must use two private cards even on a royal-flush board or with four private aces', () => {
    expect(evaluateOmaha('2c 3d 4h 5c'.split(' '), 'As Ks Qs Js Ts'.split(' ')).category).toBe(0);
    expect(evaluateOmaha('As 2d 3c 4h'.split(' '), 'Ks Qs Js Ts 9s'.split(' ')).category).toBe(0);
    expect(evaluateOmaha('As Ad Ac Ah'.split(' '), '2c 3d 4h 5s 9c'.split(' ')).category).toBe(1);
    expect(evaluateOmaha('As Ks 2d 3c'.split(' '), 'Qs Js Ts'.split(' ')).label).toBe('Royal flush');
    expect(() => evaluateOmaha(['As', 'Ks'], 'Qs Js Ts'.split(' '))).toThrow();
    expect(() => evaluateOmaha('As Ks 2d 3c'.split(' '), 'Qs Js As'.split(' '))).toThrow();
  });

  test('the legacy one-card Indian evaluator remains ace high and independent of suit', () => {
    expect(evaluateIndian('As').score).toBe(evaluateIndian('Ah').score);
    expect(evaluateIndian('As').score).toBeGreaterThan(evaluateIndian('Kc').score);
    expect(evaluateIndian('2c').score).toBeLessThan(evaluateIndian('3s').score);
    expect(() => evaluateIndian('1c')).toThrow();
  });

  test('all preflop pots and repots count both nominal short-blind deficits, then only actual chips after the flop', () => {
    let room = deal(table([5000, 50, 100, 5000], { game: 'omaha', omahaAnte: 25 }, { smallBlind: 100, bigBlind: 200 }));
    expect(room.hand).toMatchObject({ pot: 200, preflopPotAdjustment: 200, actorId: 'p3' });
    expect(legalActions(room, 'p3')).toMatchObject({
      bettingLimit: 'pot_limit', potLimitTo: 800, maxRaiseTo: 800, allInTo: 4975, canAllIn: false, potAfterCall: 600,
    });
    expect(() => act(room, 'raise', 801)).toThrow();
    room = act(room, 'raise', 800);
    expect(legalActions(room, 'p0')).toMatchObject({ potLimitTo: 2800, maxRaiseTo: 2800, potAfterCall: 2000 });
    const repot = act(room, 'raise', 2800);
    expect(legalActions(repot, 'p3')).toMatchObject({ potLimitTo: 8800, maxRaiseTo: 4975, allInTo: 4975, canAllIn: true });
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'flop', pot: 1800, preflopPotAdjustment: 200 });
    expect(legalActions(room, room.hand!.actorId!)).toMatchObject({ potLimitTo: 1800, potAfterCall: 1800 });
  });

  test('ante-exhausted blinds count their full nominal deficits without inventing ante chips', () => {
    const room = deal(table([1000, 25, 30, 1000], { game: 'omaha' }, { ante: 20 }));
    expect(room.hand).toMatchObject({ pot: 95, preflopPotAdjustment: 15 });
    expect(legalActions(room, 'p3')).toMatchObject({ potLimitTo: 150, potAfterCall: 130 });
  });

  test('a small pot cap never licenses a fake short all-in; a genuinely short stack can bet', () => {
    const room = deal(table([1000, 1000], { game: 'omaha_bomb', bombAnte: 1 }, { smallBlind: 50, bigBlind: 100 }));
    expect(legalActions(room, 'p1')).toMatchObject({
      minRaiseTo: 100, maxRaiseTo: 2, allInTo: 999, potLimitTo: 2, canRaise: false, canAllIn: false,
    });
    expect(() => act(room, 'raise', 2)).toThrow('minimum');
    const short = deal(table([1000, 2], { game: 'omaha_bomb', bombAnte: 1 }, { smallBlind: 50, bigBlind: 100 }));
    expect(legalActions(short, 'p1')).toMatchObject({ maxRaiseTo: 1, allInTo: 1, canRaise: true, canAllIn: true });
    expect(() => act(short, 'raise', 1)).not.toThrow();
    const call = deal(table([15, 1000]));
    expect(legalActions(call, 'p0')).toMatchObject({ canRaise: false, canAllIn: true, allInTo: 15, callAmount: 5 });
  });

  test.each([false, true])('a check reopens only after a full bet is cumulatively faced (full=%s)', full => {
    let room = deal(table([1000, 1000, 30, full ? 40 : 1000]));
    for (let i = 0; i < 4; i++) room = act(room, i === 3 ? 'check' : 'call');
    room = act(room, 'check');
    room = act(room, 'raise', 10);
    room = full ? act(room, 'raise', 20) : act(room, 'call');
    room = act(room, 'call');
    expect(room.hand!.actorId).toBe('p1');
    expect(legalActions(room, 'p1').canRaise).toBe(full);
    if (full) expect(() => act(room, 'raise', 40)).not.toThrow();
    else expect(() => act(room, 'raise', 30)).toThrow('reopen');
  });
});

describe('focused deals, privacy, and host controls', () => {
  test.each(['indian', 'omaha'] as const)('%s round buy-ins are forced antes, not funding or calls, and freeze at the deal', game => {
    const ante = game === 'indian' ? 37 : 23;
    let room = table([1000, 1000, 1000, 1000], { game, indianAnte: 37, omahaAnte: 23 }, { ante: 9 });
    room = apply(room, 'p2', { type: 'sit_out', value: true });
    room = apply(room, 'observer', { type: 'join', name: 'Unfunded observer' });
    const result = step(room, 'p0', { type: 'deal' });
    room = result.room;
    expect(result.transfers.filter(entry => entry.kind === 'ante').map(entry => [entry.playerId, entry.chips, entry.cashCents]))
      .toEqual([['p0', ante, 0], ['p1', ante, 0], ['p3', ante, 0]]);
    expect(result.transfers.filter(entry => entry.kind === 'blind').map(entry => entry.chips)).toEqual([10, 20]);
    expect(result.transfers.every(entry => entry.kind === 'ante' || entry.kind === 'blind')).toBe(true);
    expect(room.hand!.pot).toBe(ante * 3 + 30);
    expect(room.players.find(player => player.id === 'p2')!.stack).toBe(1000);
    expect(room.players.map(player => player.buyIns)).toEqual([1000, 1000, 1000, 1000, 0]);
    expect(legalActions(room, 'p0').toCall).toBe(20);
    if (game === 'omaha') expect(legalActions(room, 'p0').potLimitTo).toBe(ante * 3 + 70);
    const frozen = structuredClone(room.hand);
    const selected = step(room, 'p0', { type: 'next_hand', rules: { ...room.nextHandRules, indianAnte: ante + 11, omahaAnte: ante + 11 } });
    room = selected.room;
    expect(selected.transfers).toEqual([]);
    expect(room.hand).toEqual(frozen);
    room = finish(room);
    const next = step(room, 'p0', { type: 'deal' });
    expect(next.transfers.filter(entry => entry.kind === 'ante').map(entry => entry.chips)).toEqual(Array(3).fill(ante + 11));
    expect(next.room.players.map(player => player.buyIns)).toEqual([1000, 1000, 1000, 1000, 0]);
  });

  test('heads-up Indian preserves button/small-blind preflop order and big-blind postflop order', () => {
    let room = deal(table([1000, 1000], { game: 'indian', indianAnte: 15 }));
    expect(room.hand).toMatchObject({ buttonSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1, actorId: 'p0', currentBet: 20, pot: 60 });
    expect(legalActions(room, 'p0')).toMatchObject({ toCall: 10, canCheck: false, minRaiseTo: 40 });
    room = act(room, 'raise', 60);
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'flop', actorId: 'p1', currentBet: 0, pot: 150 });
    expect(room.hand!.board).toHaveLength(3);
    expect(legalActions(room, 'p1')).toMatchObject({ canCheck: true, minRaiseTo: 20 });
    room = act(room, 'raise', 30);
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'turn', actorId: 'p1', pot: 210 });
    expect(finish(room).hand!.board).toHaveLength(5);
  });

  test('an Indian timeout fold reveals both cards only after folding, including a fresh view', () => {
    const room = deal(table([1000, 1000, 1000], { game: 'indian', indianAnte: 5 }));
    const id = room.hand!.actorId!;
    expect(roomView(room, id, new Set()).players.find(player => player.id === id)!.cards).toEqual([null, null]);
    const result = timeoutTurn(room, room.hand!.deadline!)!;
    verifyTransfers(room, result.room, result.transfers);
    expect(result.room.hand!.street).not.toBe('complete');
    expect(result.room.hand!.revealed).toEqual({});
    const restored = JSON.parse(JSON.stringify(result.room)) as Room;
    expect(roomView(restored, id, new Set()).players.find(player => player.id === id)!.cards).toEqual(room.hand!.holeCards[id]);
    for (const other of restored.hand!.players.filter(player => !player.folded))
      expect(roomView(restored, other.id, new Set()).players.find(player => player.id === other.id)!.cards).toEqual([null, null]);
  });

  test('schema-two Indian hands retain one-card settlement until the next deal without changing stored cards or chips', () => {
    const old = deal(table([1000, 1000, 1000], { game: 'indian', indianAnte: 7, maxRunouts: 3 }));
    old.schemaVersion = 2;
    delete (old.nextHandRules as unknown as Record<string, unknown>).omahaAnte;
    const hand = old.hand!;
    delete (hand.rules as unknown as Record<string, unknown>).omahaAnte;
    hand.holeCards = { p0: ['As'], p1: ['Ah'], p2: ['Kc'] };
    hand.deck = makeDeck().filter(card => !Object.values(hand.holeCards).flat().includes(card));
    hand.boards = [];
    hand.smallBlindSeat = hand.bigBlindSeat = null;
    hand.currentBet = hand.preflopPotAdjustment = 0;
    hand.actorId = 'p1';
    hand.pot = 21;
    for (const player of old.players) player.stack = 993;
    for (const player of hand.players) { player.committed = 7; player.streetBet = 0; }
    const before = structuredClone(old);
    let room = normalizeRoom(structuredClone(old));
    assertRoom(room);
    expect(room.schemaVersion).toBe(3);
    expect(room.nextHandRules).toMatchObject({ game: 'indian', indianAnte: 7, maxRunouts: 3, omahaAnte: 20 });
    expect(room.hand).toEqual({ ...before.hand, rules: { ...before.hand!.rules, omahaAnte: 0 } });
    expect(room.players).toEqual(before.players);
    room = finish(room);
    expect(room.hand).toMatchObject({ boards: [], board: [], runoutVote: null, runoutCount: 1 });
    expect(room.hand!.results[0]).toMatchObject({ shares: { p1: 11, p0: 10 }, description: 'Ace high' });
    room = deal(room);
    expect(room.hand!.boards).toEqual([[]]);
    expect(room.hand!.smallBlindSeat).not.toBeNull();
    expect(Object.values(room.hand!.holeCards).every(cards => cards.length === 2)).toBe(true);
    expect(old).toEqual(before);
  });

  test('bomb pots post only clipped bomb antes and burn exactly once before both boards on every street', () => {
    const deck = makeDeck();
    let room = deal(table([1000, 40, 1000], { game: 'omaha_bomb', bombAnte: 75 }, { ante: 20 }), deck);
    expect(room.hand).toMatchObject({ street: 'flop', actorId: 'p2', smallBlindSeat: null, bigBlindSeat: null, pot: 190, currentBet: 0 });
    expect(room.hand!.boards).toEqual([deck.slice(13, 16), deck.slice(16, 19)]);
    expect(room.hand!.burned).toEqual([deck[12]]);
    expect(Object.values(room.hand!.holeCards).every(cards => cards.length === 4)).toBe(true);
    room = finish(room);
    expect(room.hand!.burned).toEqual([deck[12], deck[19], deck[22]]);
    expect(room.hand!.boards).toEqual([
      [...deck.slice(13, 16), deck[20], deck[23]], [...deck.slice(16, 19), deck[21], deck[24]],
    ]);
    expect(room.hand!.results.map(result => [result.potIndex, result.boardIndex, result.amount])).toEqual([
      [0, 0, 60], [0, 1, 60], [1, 0, 35], [1, 1, 35],
    ]);
  });

  test('two-card Indian uses Holdem betting, hides live owners, and reveals a folded owner before the hand ends', () => {
    let room = deal(table([1000, 1000, 1000], { game: 'indian', indianAnte: 7, maxRunouts: 3 }, { ante: 10 }),
      rig(['As Kc', 'Ah Kd', 'Qc Jd'], '6c 2c 3d 4h 6d 5s 6h 9c'));
    expect(room.hand).toMatchObject({ actorId: 'p0', board: [], boards: [[]], smallBlindSeat: 1, bigBlindSeat: 2, pot: 51, currentBet: 20 });
    const own = roomView(room, 'p0', new Set());
    expect(own.players.map(player => player.cards)).toEqual([[null, null], ['Ah', 'Kd'], ['Qc', 'Jd']]);
    expect(JSON.stringify(own)).not.toContain('"As"');
    expect(JSON.stringify(own)).not.toContain('"Kc"');
    room = apply(room, 'watch', { type: 'join', name: 'Observer' });
    expect(roomView(room, 'watch', new Set()).players.slice(0, 3).map(player => player.cards)).toEqual([['As', 'Kc'], ['Ah', 'Kd'], ['Qc', 'Jd']]);
    room = act(room, 'call');
    room = act(room, 'call');
    room = act(room, 'fold');
    expect(room.hand!.street).toBe('flop');
    expect(room.hand!.revealed).toEqual({});
    expect(roomView(room, 'p2', new Set()).players[2]!.cards).toEqual(['Qc', 'Jd']);
    expect(roomView(room, 'p0', new Set()).players[0]!.cards).toEqual([null, null]);
    room = finish(room);
    expect(room.hand).toMatchObject({ street: 'complete', board: ['2c', '3d', '4h', '5s', '9c'], runoutVote: null, runoutCount: 1 });
    expect(room.hand!.burned).toHaveLength(3);
    expect(room.hand!.results[0]).toMatchObject({ shares: { p1: 41, p0: 40 }, description: 'Straight', boardIndex: 0, runoutIndex: 0 });
    expect(roomView(room, 'p2', new Set()).players[2]!.cards).toEqual(['Qc', 'Jd']);
  });

  test('Indian clipped ante all-ins offer board runouts and settle only the side pots each player funded', () => {
    let room = deal(table([3, 5, 8], { game: 'indian', indianAnte: 10, maxRunouts: 3, sevenDeuceBounty: 100 }),
      rig(['As Ad', 'Ks Kd', 'Qs Qd'], '4c 2c 3d 6h 4d 9s 4h Jc'));
    expect(room.hand!.runoutVote?.maxRuns).toBe(3);
    expect(room.players.every(player => player.stack === 0)).toBe(true);
    room = choose(room, 'p0', 1);
    expect(room.hand).toMatchObject({ street: 'complete', awardedPot: 13, runoutCount: 1, runoutVote: null, bounty: null });
    expect(room.players.map(player => player.stack)).toEqual([9, 4, 3]);
    expect(room.hand!.deck).toHaveLength(38);
    expect(room.hand!.board).toHaveLength(5);
    expect(room.hand!.burned).toHaveLength(3);
  });

  test('bot decisions cannot depend on either hidden Indian hole card or the unseen deck', () => {
    const room = deal(table([1000, 1000, 1000], { game: 'indian', indianAnte: 10 }));
    const actor = room.hand!.actorId!;
    const changed = structuredClone(room);
    for (let index = 0; index < 2; index++)
      [changed.hand!.holeCards[actor]![index], changed.hand!.deck[index]] = [changed.hand!.deck[index]!, changed.hand!.holeCards[actor]![index]!];
    assertRoom(changed);
    const before = roomView(room, actor, new Set(), now);
    const after = roomView(changed, actor, new Set(), now);
    expect(after).toEqual(before);
    for (const roll of [0, 0.3, 0.99]) expect(chooseBotAction(before, () => roll)).toEqual(chooseBotAction(after, () => roll));
  });

  test('next-hand rules are host-only, immutable for this hand, and persist for every subsequent deal', () => {
    let room = deal(table());
    const rules = { ...room.nextHandRules, game: 'omaha' as const, maxRunouts: 2 as const };
    expect(() => apply(room, 'p1', { type: 'next_hand', rules })).toThrow('host');
    const changed = step(room, 'p0', { type: 'next_hand', rules });
    room = changed.room;
    expect(changed.events[0]!.kind).toBe('next_hand');
    expect(room.hand!.rules.game).toBe('holdem');
    rules.bombAnte = 999;
    expect(room.nextHandRules.bombAnte).not.toBe(999);
    room = deal(act(room, 'fold'));
    expect(room.hand!.rules.game).toBe('omaha');
    expect(Object.values(room.hand!.holeCards).every(cards => cards.length === 4)).toBe(true);
    room = deal(act(room, 'fold'));
    expect(room.hand!.rules).toEqual(room.nextHandRules);
  });

  test('the default minimum is 500 and a live minimum change applies to funding, never to existing chips', () => {
    expect(DEFAULT_SETTINGS.minBuyIn).toBe(500);
    let room = deal(table([1000, 1000]));
    const before = room.players.map(player => ({ stack: player.stack, buyIns: player.buyIns, cashOuts: player.cashOuts }));
    const result = step(room, 'p0', {
      type: 'settings', smallBlind: 10, bigBlind: 20, ante: 0, autoDeal: false, turnSeconds: 45, allowRebuys: true, minBuyIn: 500,
    });
    room = result.room;
    expect(result.transfers).toEqual([]);
    expect(result.events[0]!.message).toContain('500');
    expect(room.players.map(player => ({ stack: player.stack, buyIns: player.buyIns, cashOuts: player.cashOuts }))).toEqual(before);
    room = apply(room, 'p2', { type: 'join', name: 'Newcomer' });
    expect(() => apply(room, 'p2', { type: 'fund', amount: 499 })).toThrow('500');
    expect(() => apply(room, 'p2', { type: 'fund', amount: room.settings.maxBuyIn + 1 })).toThrow();
    expect(apply(room, 'p2', { type: 'fund', amount: 500 }).requests.at(-1)!.status).toBe('pending');
    expect(apply(room, 'p0', {
      type: 'settings', smallBlind: 10, bigBlind: 20, ante: 0, autoDeal: false, turnSeconds: 45, allowRebuys: true, minBuyIn: undefined,
    }).settings.minBuyIn).toBe(500);
  });

  test('legacy snapshots normalize on transitions without changing their original hand rules or input', () => {
    const legacy = structuredClone(deal(table())) as Room;
    const raw = legacy as unknown as Record<string, unknown>;
    delete raw.schemaVersion;
    delete raw.nextHandRules;
    for (const player of legacy.players) delete (player as unknown as Record<string, unknown>).bountyNet;
    const hand = legacy.hand as unknown as Record<string, unknown>;
    for (const key of ['rules', 'boards', 'runoutBoards', 'runoutPrefix', 'runoutCount', 'runoutVote', 'preflopPotAdjustment', 'bounty', 'bountyAfter']) delete hand[key];
    const changed = transition(legacy, 'p0', { type: 'chat', message: 'Legacy room' }, { now: ++now });
    assertRoom(changed.room);
    expect(changed.room).toMatchObject({ schemaVersion: 3, nextHandRules: { game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 } });
    expect(changed.room.hand!.rules).toMatchObject({ game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 });
    expect(raw).not.toHaveProperty('schemaVersion');
    expect(hand).not.toHaveProperty('rules');
  });
});

describe('focused all-in runout lifecycle', () => {
  test('no runout is offered while a call or later side-pot betting remains outstanding', () => {
    let room = deal(table([100, 1000, 1000], { maxRunouts: 3 }));
    room = act(room, 'raise', 100);
    room = act(room, 'call');
    expect(room.hand!.runoutVote).toBeNull();
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'flop', runoutVote: null });
    room = act(room, 'check');
    room = act(room, 'check');
    room = act(room, 'raise', 900);
    expect(room.hand).toMatchObject({ street: 'turn', runoutVote: null });
    room = act(room, 'call');
    expect(room.hand!.runoutVote!.eligible).toEqual(['p0', 'p1', 'p2']);
    const prefix = structuredClone(room.hand!.boards);
    room = choose(room, 'p0', 3);
    room = choose(room, 'p1', 2);
    room = choose(room, 'p2', 3);
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 2, runoutPrefix: prefix });
    expect(room.hand!.runoutBoards.every(run => run[0]!.slice(0, 4).join() === prefix[0]!.join())).toBe(true);
    expect(room.hand!.burned).toHaveLength(4);
    expect(room.hand!.results.map(result => [result.potIndex, result.runoutIndex, result.amount])).toEqual([
      [0, 0, 150], [0, 1, 150], [1, 0, 900], [1, 1, 900],
    ]);
  });

  test('up-to votes require unanimous participation and resolve to the lowest count', () => {
    let room = allInOffer();
    expect(room.hand).toMatchObject({ actorId: null, deadline: null, board: [], burned: [], runoutCount: 1 });
    const deadline = room.hand!.runoutVote!.deadline;
    room = choose(room, 'p0', 3);
    expect(room.hand!.runoutVote!.deadline).toBe(deadline);
    expect(room.hand!.deck).toHaveLength(48);
    room = choose(room, 'p1', 2);
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 2, runoutVote: null });
    expect(room.hand!.burned).toHaveLength(6);
    expect(room.hand!.deck).toHaveLength(32);
    expect(new Set(room.hand!.runoutBoards.flat(2)).size).toBe(10);
  });

  test('one vote for once resolves immediately; late, duplicate, ineligible, stale and oversized votes cannot affect it', () => {
    let room = deal(table([1000, 1000, 1000], { maxRunouts: 3 }));
    room = act(room, 'fold');
    room = act(room, 'raise', 1000);
    room = act(room, 'call');
    room = apply(room, 'watch', { type: 'join', name: 'Observer' });
    for (const id of ['p0', 'watch', 'stranger']) expect(() => choose(room, id, 2)).toThrow();
    expect(() => apply(room, 'p1', { type: 'runouts', handId: 'wrong', count: 2 })).toThrow('hand');
    expect(() => choose(room, 'p1', 4 as RunoutCount)).toThrow();
    const deadline = room.hand!.runoutVote!.deadline!;
    expect(() => transition(room, 'p1', { type: 'runouts', handId: room.hand!.id, count: 2 }, { now: deadline })).toThrow('deadline');
    room = choose(room, 'p1', 3);
    expect(() => choose(room, 'p1', 2)).toThrow('already');
    room = choose(room, 'p2', 1);
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 1 });
    expect(() => choose(room, 'p1', 3)).toThrow('awaiting');
  });

  test('pausing freezes votes; serialized restart-pause preserves votes and resume starts a fresh 20 seconds', () => {
    let room = choose(allInOffer(), 'p0', 2);
    const oldDeadline = room.hand!.runoutVote!.deadline!;
    room = apply(room, 'p0', { type: 'pause', value: true });
    expect(room.hand).toMatchObject({ actorId: null, deadline: null, runoutVote: { deadline: null, votes: { p0: 2 } } });
    expect(timeoutRunout(room, oldDeadline + 100_000)).toBeNull();
    expect(() => choose(room, 'p1', 2)).toThrow('paused');
    room = JSON.parse(JSON.stringify(room)) as Room;
    now = oldDeadline + 100_000;
    room = apply(room, 'p0', { type: 'pause', value: false });
    expect(room.hand!.runoutVote!.deadline).toBe(now + 20_000);
    expect(room.hand!.runoutVote!.votes).toEqual({ p0: 2 });
    expect(timeoutTurn(room, now + 50_000)).toBeNull();
    expect(timeoutRunout(room, now + 19_999)).toBeNull();
    const timed = timeoutRunout(room, now + 20_000)!;
    verifyTransfers(room, timed.room, timed.transfers);
    expect(timed.room.hand).toMatchObject({ street: 'complete', runoutCount: 1 });
    expect(timed.events.some(event => event.kind === 'runout_timeout' && event.message.includes('defaulted'))).toBe(true);
    expect(room.hand!.runoutVote!.votes).toEqual({ p0: 2 });
  });

  test('bots accept the feasible maximum automatically, including tables containing only bots', () => {
    let room = table([1000], { maxRunouts: 3 });
    room = apply(room, 'p0', { type: 'add_bot' });
    room = apply(room, 'p0', { type: 'add_bot' });
    room = apply(room, 'p0', { type: 'sit_out', value: true });
    room = deal(room);
    room = act(room, 'raise', legalActions(room, room.hand!.actorId!).allInTo);
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 3, runoutVote: null });
    expect(room.events.filter(event => event.kind === 'runout_vote')).toHaveLength(2);
    let human = table([1000], { maxRunouts: 3 }, { maxBuyIn: 1000 });
    human = apply(human, 'p0', { type: 'add_bot' });
    human = deal(human);
    human = act(human, 'raise', 1000);
    human = act(human, 'call');
    expect(human.hand!.runoutVote!.votes).toEqual({ [human.players[1]!.id]: 3 });
    expect(choose(human, 'p0', 2).hand!.runoutCount).toBe(2);
  });

  test('nine-seat Omaha preflop offers only two physical runouts, while nine-seat bomb flops restrict to one', () => {
    let room = deal(table(Array(9).fill(1), { game: 'omaha', maxRunouts: 3 }));
    while (room.hand!.actorId) room = act(room, 'call');
    expect(room.hand!.runoutVote!.maxRuns).toBe(2);
    expect(() => choose(room, 'p0', 3)).toThrow();
    room = finish(room, 2);
    expect(room.hand!.deck).toHaveLength(0);
    expect(room.hand!.runoutCount).toBe(2);
    const bomb = deal(table(Array(9).fill(1), { game: 'omaha_bomb', bombAnte: 10, maxRunouts: 3 }));
    expect(bomb.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
    expect(bomb.events.some(event => event.kind === 'runout_restricted' && event.message.includes('running once'))).toBe(true);
  });

  test('nine-seat Omaha can use all remaining twelve cards for three flop-tail runouts with burns', () => {
    let room = deal(table(Array(9).fill(5), { game: 'omaha', maxRunouts: 3 }, { smallBlind: 1, bigBlind: 2 }));
    while (room.hand!.street === 'preflop') room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
    room = act(room, 'raise', 1);
    while (room.hand!.actorId) room = act(room, 'call');
    expect(room.hand!.runoutVote!.maxRuns).toBe(3);
    room = finish(room, 3);
    expect(room.hand!.deck).toHaveLength(0);
    expect(room.hand!.burned).toHaveLength(7);
    assertRoom(room);
  });

  test('each odd side pot is split by board, then run, with zero slices retained and no lost chips', () => {
    let room = deal(table([4, 3, 4], { game: 'omaha_bomb', bombAnte: 3, maxRunouts: 3 }, { smallBlind: 1, bigBlind: 2 }));
    room = act(room, 'raise', 1);
    room = act(room, 'call');
    room = finish(room, 3);
    expect(room.hand!.results.map(result => [result.potIndex, result.boardIndex, result.runoutIndex, result.amount])).toEqual([
      [0, 0, 0, 2], [0, 0, 1, 2], [0, 0, 2, 1], [0, 1, 0, 2], [0, 1, 1, 1], [0, 1, 2, 1],
      [1, 0, 0, 1], [1, 0, 1, 0], [1, 0, 2, 0], [1, 1, 0, 1], [1, 1, 1, 0], [1, 1, 2, 0],
    ]);
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(11);
  });

  test('completed hands still reject reused tails, changed prefixes, projection drift, and omitted burns', () => {
    let room = allInOffer();
    room = choose(choose(room, 'p0', 3), 'p1', 3);
    const duplicate = structuredClone(room);
    duplicate.hand!.runoutBoards[1]![0]![4] = duplicate.hand!.runoutBoards[0]![0]![4]!;
    expect(() => assertRoom(duplicate)).toThrow(/physical cards/i);
    const projection = structuredClone(room);
    projection.hand!.board[0] = projection.hand!.deck[0]!;
    expect(() => assertRoom(projection)).toThrow('projection');
    const falsePrefix = structuredClone(room);
    falsePrefix.hand!.runoutPrefix = structuredClone(falsePrefix.hand!.boards);
    expect(() => assertRoom(falsePrefix)).toThrow('prefix');
    const burn = structuredClone(room);
    burn.hand!.deck.push(burn.hand!.burned.pop()!);
    expect(() => assertRoom(burn)).toThrow('burn');
    let prefix = deal(table([1000, 1000], { maxRunouts: 2 }));
    prefix = act(act(prefix, 'call'), 'check');
    prefix = act(prefix, 'raise', legalActions(prefix, prefix.hand!.actorId!).allInTo);
    prefix = act(prefix, 'call');
    prefix = finish(prefix, 2);
    prefix.hand!.runoutBoards[1]![0]![0] = prefix.hand!.deck[0]!;
    expect(() => assertRoom(prefix)).toThrow('prefix');
  });

  test('river all-ins and uncontested hands never offer a multi-run choice', () => {
    let room = deal(table([1000, 1000], { maxRunouts: 3 }));
    while (room.hand!.street !== 'river') room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
    room = act(room, 'raise', legalActions(room, room.hand!.actorId!).allInTo);
    room = act(room, 'call');
    expect(room.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
    expect(act(deal(table([1000, 1000], { maxRunouts: 3 })), 'fold').hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
  });
});

describe('focused separate seven-deuce settlement accounts', () => {
  test('an uncontested winner exposes 7-2 for a bounty larger than the loser stack without moving in-play chips', () => {
    let room = deal(table([1000, 1000], { sevenDeuceBounty: 1500 }, { chipValueCents: 5 }), rig(['7c 2d', 'As Kh']));
    room = act(room, 'call');
    const result = step(room, 'p1', { type: 'act', action: 'fold' });
    room = result.room;
    expect(room.players.map(player => player.stack)).toEqual([1020, 980]);
    expect(room.players.map(player => player.bountyNet)).toEqual([1500, -1500]);
    expect(room.hand!.bounty).toEqual({ winnerId: 'p0', payerIds: ['p1'], amount: 1500, totalAmount: 1500 });
    expect(room.hand!.revealed.p0).toEqual(['7c', '2d']);
    expect(result.events.some(event => event.kind === 'bounty' && event.message.includes('revealed'))).toBe(true);
    expect(result.transfers.filter(transfer => transfer.kind === 'bounty')).toEqual([expect.objectContaining({
      from: 'bounty:p1', to: 'bounty:p0', playerId: 'p1', chips: 1500, cashCents: 7500, handId: room.hand!.id,
    })]);
    expect(roomView(room, 'p0', new Set()).players.map(player => [player.chipNet, player.net])).toEqual([[20, 1520], [-20, -1520]]);
    room = apply(room, 'p1', { type: 'cash_out' });
    expect(room.players[1]).toMatchObject({ stack: 0, cashOuts: 980, buyIns: 1000, bountyNet: -1500 });
    room = apply(room, 'p0', { type: 'close' });
    expect(room.hand!.bountyAfter).toEqual({ p0: 1500, p1: -1500 });
    expect(room.players.reduce((sum, player) => sum + player.bountyNet, 0)).toBe(0);
  });

  test('folded and busted dealt-in players owe the full bounty, but new arrivals never do', () => {
    let room = deal(table([50, 30, 100, 100], { sevenDeuceBounty: 100 }),
      rig(['7c 2d', 'As Kh', 'Qc Jh', '5s 6s'], 'Ts 7d 7h 2c Td 4c Th 9s'));
    room = apply(room, 'watch', { type: 'join', name: 'Observer' });
    room = act(room, 'fold');
    room = act(room, 'raise', 50);
    room = act(room, 'call');
    room = act(room, 'call');
    expect(room.hand!.bounty).toMatchObject({ winnerId: 'p0', payerIds: ['p1', 'p2', 'p3'], totalAmount: 300 });
    expect(room.players.map(player => player.stack)).toEqual([130, 0, 50, 100, 0]);
    expect(room.players.map(player => player.bountyNet)).toEqual([300, -100, -100, -100, 0]);
    expect(room.hand!.bountyAfter).toEqual({ p0: 300, p1: -100, p2: -100, p3: -100, watch: 0 });
  });

  test('a seven-deuce main-pot winner receives no bounty when a different player wins a side pot', () => {
    let room = deal(table([20, 40, 40], { sevenDeuceBounty: 100 }),
      rig(['7c 2d', 'Ac Ad', 'Kc Kd'], 'Ts 7d 7h 2c Td 4s Th 9s'));
    room = act(room, 'call');
    room = act(room, 'raise', 40);
    room = act(room, 'call');
    expect(room.hand!.results.map(result => result.winners)).toEqual([['p0'], ['p1']]);
    expect(room.hand!.bounty).toBeNull();
    expect(room.players.every(player => player.bountyNet === 0)).toBe(true);
  });

  test.each([false, true])('a multi-run bounty requires the same sole winner on every positive award (scoop=%s)', scoop => {
    const second = scoop ? 'Js 7s 2s 3c Jd 4c Jc 9d' : 'Js Ac Ad 3c Jd 4c Jc 9d';
    let room = allInOffer({ sevenDeuceBounty: 100 }, rig(['7c 2d', 'Ah Kh'], `Ts 7d 7h 2c Td 4s Th 9s ${second}`));
    room = choose(choose(room, 'p0', 2), 'p1', 2);
    expect(room.hand!.bounty !== null).toBe(scoop);
    expect(room.players[0]!.bountyNet).toBe(scoop ? 100 : 0);
  });

  test('suited seven-deuce and shared-board ties never earn a bounty', () => {
    let suited = deal(table([1000, 1000], { sevenDeuceBounty: 100 }), rig(['7c 2c', 'As Kh']));
    suited = act(act(suited, 'call'), 'fold');
    expect(suited.hand!.bounty).toBeNull();
    let tied = deal(table([50, 50], { sevenDeuceBounty: 100 }), rig(['7c 2d', 'Ac Ad'], '2h Ts Js Qs 3h Ks 4h As'));
    tied = act(act(tied, 'raise', 50), 'call');
    expect(tied.hand!.results[0]!.winners).toHaveLength(2);
    expect(tied.hand!.bounty).toBeNull();
  });

  test('signed bounty balances must be safe integers and exactly zero-sum independently of chip conservation', () => {
    const room = table();
    room.players[0]!.bountyNet = -100;
    expect(() => assertRoom(room)).toThrow(/bounty/i);
    room.players[1]!.bountyNet = 100;
    expect(() => assertRoom(room)).not.toThrow();
    room.players[0]!.bountyNet = -(Number.MAX_SAFE_INTEGER + 1);
    room.players[1]!.bountyNet = Number.MAX_SAFE_INTEGER + 1;
    expect(() => assertRoom(room)).toThrow(/bounty/i);
  });
});

test('200 deterministic mixed multiway hands generate only legal redacted bot actions and conserve every physical card and balance', () => {
  let seed = 18181;
  const random = () => ((seed = seed * 16807 % 2147483647) / 2147483647);
  const variants: HandRules['game'][] = ['holdem', 'omaha', 'omaha_bomb', 'indian'];
  for (let iteration = 0; iteration < 200; iteration++) {
    const game = variants[iteration % variants.length]!;
    const count = 2 + Math.floor(random() * 8);
    const stacks = Array.from({ length: count }, () => 1 + Math.floor(random() * 1000));
    const deck = makeDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    let room = deal(table(stacks, { game, bombAnte: 15, indianAnte: 10, sevenDeuceBounty: 50, maxRunouts: 3 }), deck);
    let turns = 0;
    while (room.hand!.street !== 'complete') {
      expect(++turns).toBeLessThan(300);
      const vote = room.hand!.runoutVote;
      if (vote) room = choose(room, vote.eligible.find(id => !Object.hasOwn(vote.votes, id))!, vote.maxRuns);
      else {
        const actor = room.hand!.actorId!;
        const view = roomView(room, actor, new Set());
        const action = chooseBotAction(view, random);
        if (action.action === 'raise') {
          expect(view.legal.canRaise).toBe(true);
          expect(action.amount!).toBeLessThanOrEqual(view.legal.maxRaiseTo);
          expect(action.amount! >= view.legal.minRaiseTo || action.amount === view.legal.allInTo).toBe(true);
        }
        room = apply(room, actor, action);
      }
    }
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(stacks.reduce((sum, value) => sum + value, 0));
    expect(room.players.reduce((sum, player) => sum + player.bountyNet, 0)).toBe(0);
    assertRoom(room);
  }
}, 30_000);
