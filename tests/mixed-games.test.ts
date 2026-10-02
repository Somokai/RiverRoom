import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS, defaultHandRules,
  type Card, type ChipTransfer, type Command, type GameVariant, type HandHistory,
  type HandRules, type Room, type RoomSettings,
} from '../src/shared/model';
import { evaluateIndian, evaluateOmaha } from '../src/server/cards';
import { createRoom, legalActions, roomView, transition, type Transition } from '../src/server/engine';
import { normalizeHistory, normalizeRoom } from '../src/server/state';
import { commandSchema, settingsSchema } from '../src/server/validation';

const PACK = [...'23456789TJQKA'].flatMap(rank => [...'cdhs'].map(suit => rank + suit));
const cards = (text: string) => text.split(' ');
const sum = (amounts: number[]) => amounts.reduce((total, amount) => total + amount, 0);
const player = (room: Room, id: string) => room.players.find(item => item.id === id)!;

function rig(prefix: Card[]) {
  expect(new Set(prefix).size, 'The test fixture must not duplicate a physical card').toBe(prefix.length);
  expect(prefix.every(card => PACK.includes(card))).toBe(true);
  return [...prefix, ...PACK.filter(card => !prefix.includes(card))];
}

function boardDeck(holes: Card[][], boards: Card[][]) {
  const order = [...holes.slice(1), holes[0]!];
  const prefix = Array.from({ length: holes[0]!.length }, (_, round) => order.map(hole => hole[round]!)).flat();
  const reserved = [...prefix, ...boards.flat()];
  expect(new Set(reserved).size).toBe(reserved.length);
  const burns = PACK.filter(card => !reserved.includes(card)).slice(0, 3);
  prefix.push(burns[0]!, ...boards.flatMap(board => board.slice(0, 3)));
  prefix.push(burns[1]!, ...boards.map(board => board[3]!));
  prefix.push(burns[2]!, ...boards.map(board => board[4]!));
  return rig(prefix);
}

class Table {
  room: Room;
  transfers: ChipTransfer[];
  now = 1_800_000_000_000;

  constructor(stacks = [1000, 1000], settings: Partial<RoomSettings> = {}) {
    const initial = createRoom({
      id: 'mixed-game-room', code: 'MIXED123', name: 'Independent mixed-game tests',
      hostId: 'p0', hostName: 'Player zero', buyIn: stacks[0]!,
      settings: {
        ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, minBuyIn: 1,
        maxBuyIn: 1_000_000, autoDeal: false, ...settings,
      },
    }, { now: this.now });
    this.room = initial.room;
    this.transfers = [...initial.transfers];
    for (let index = 1; index < stacks.length; index++) {
      this.send(`p${index}`, { type: 'join', name: `Player ${index}` });
      this.send(`p${index}`, { type: 'fund', amount: stacks[index]! });
      this.send('p0', { type: 'approve', requestId: this.room.requests.at(-1)!.id, approve: true });
    }
  }

  send(actor: string, command: Command, deck?: Card[]): Transition {
    const before = structuredClone(this.room);
    const result = transition(this.room, actor, command, { now: ++this.now, deck });
    expect(this.room, 'Transitions must not mutate their input snapshot').toEqual(before);
    this.room = result.room;
    this.transfers.push(...result.transfers);
    expect(sum(this.room.players.map(item => item.stack + item.cashOuts - item.buyIns)) + (this.room.hand?.pot ?? 0)).toBe(0);
    return result;
  }

  rules(game: GameVariant, changes: Partial<HandRules> = {}) {
    return this.send('p0', {
      type: 'next_hand', rules: { ...defaultHandRules(this.room.settings), game, ...changes },
    });
  }

  deal(deck?: Card[]) { return this.send('p0', { type: 'deal' }, deck); }
  act(action: 'check' | 'call' | 'fold' | 'raise', amount?: number) {
    expect(this.room.hand?.actorId, 'This fixture requires a live betting turn').toBeTruthy();
    return this.send(this.room.hand!.actorId!, { type: 'act', action, amount });
  }
  passive() {
    return this.act(legalActions(this.room, this.room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  street() {
    const street = this.room.hand!.street;
    for (let turn = 0; this.room.hand!.street === street; turn++) {
      if (turn >= 30) throw new Error(`Check-down stalled on ${street}`);
      this.passive();
    }
  }
  finish() {
    for (let turn = 0; this.room.hand!.street !== 'complete'; turn++) {
      if (turn >= 120) throw new Error('Check-down failed to finish a hand');
      expect(this.room.hand!.runoutVote, 'This check-down fixture must not silently skip a vote').toBeNull();
      this.passive();
    }
    return this.room.hand!;
  }
}

function rejected(table: Table, actor: string, command: Command) {
  const before = structuredClone(table.room);
  expect(() => transition(table.room, actor, command, { now: table.now + 1 })).toThrow();
  expect(table.room).toEqual(before);
}

function physicalCards(room: Room) {
  const hand = room.hand!;
  expect(hand.board).toEqual(hand.boards[0] ?? []);
  const physical = [...Object.values(hand.holeCards).flat(), ...hand.boards.flat(), ...hand.burned, ...hand.deck];
  expect(physical).toHaveLength(52);
  expect(new Set(physical).size).toBe(52);
  expect([...physical].sort()).toEqual([...PACK].sort());
}

function ledgerBalances(table: Table) {
  const balances = new Map<string, number>();
  for (const entry of table.transfers) {
    expect(Number.isSafeInteger(entry.chips) && entry.chips > 0).toBe(true);
    expect(entry.from).not.toBe(entry.to);
    balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.chips);
    balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.chips);
    if (entry.kind === 'bounty') {
      expect(entry.from).toBe(`bounty:${entry.playerId}`);
      expect(entry.to).toMatch(/^bounty:/);
      expect(entry.cashCents).toBe(entry.chips * table.room.settings.chipValueCents);
    } else if (entry.from !== 'bank') {
      expect(balances.get(entry.from), 'Ordinary chip accounts cannot overdraw').toBeGreaterThanOrEqual(0);
    }
  }
  for (const item of table.room.players) {
    expect(balances.get(`player:${item.id}`) ?? 0).toBe(item.stack);
    expect(balances.get(`bounty:${item.id}`) ?? 0).toBe(item.bountyNet);
  }
  for (const [account, balance] of balances) if (account.startsWith('pot:')) expect(balance).toBe(0);
  expect(balances.get('bank')).toBe(sum(table.room.players.map(item => item.cashOuts - item.buyIns)));
  expect(sum(table.room.players.map(item => item.bountyNet))).toBe(0);
  expect(sum([...balances.values()])).toBe(0);
}

function fiveValue(hand: Card[]): number[] {
  const ranks = hand.map(card => '23456789TJQKA'.indexOf(card[0]!) + 2);
  const histogram = Array.from({ length: 15 }, (_, rank) => ranks.filter(value => value === rank).length);
  const groups = histogram.map((count, rank) => ({ count, rank }))
    .filter(group => group.count).sort((a, b) => b.count - a.count || b.rank - a.rank);
  const descending = [...ranks].sort((a, b) => b - a);
  const distinct = [...new Set(descending)];
  const high = distinct.length === 5
    ? distinct.join() === '14,5,4,3,2' ? 5 : distinct[0]! - distinct[4]! === 4 ? distinct[0]! : 0
    : 0;
  const flush = new Set(hand.map(card => card[1])).size === 1;
  if (flush && high) return [8, high];
  if (groups[0]!.count === 4) return [7, groups[0]!.rank, groups[1]!.rank];
  if (groups[0]!.count === 3 && groups[1]!.count === 2) return [6, groups[0]!.rank, groups[1]!.rank];
  if (flush) return [5, ...descending];
  if (high) return [4, high];
  if (groups[0]!.count === 3) return [3, ...groups.map(group => group.rank)];
  if (groups[0]!.count === 2 && groups[1]!.count === 2) return [2, ...groups.map(group => group.rank)];
  if (groups[0]!.count === 2) return [1, ...groups.map(group => group.rank)];
  return [0, ...descending];
}

function compareValue(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function omahaValue(hole: Card[], board: Card[]) {
  let best: number[] = [-1];
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++)
    for (let x = 0; x < board.length - 2; x++) for (let y = x + 1; y < board.length - 1; y++)
      for (let z = y + 1; z < board.length; z++) {
        const value = fiveValue([hole[a]!, hole[b]!, board[x]!, board[y]!, board[z]!]);
        if (compareValue(value, best) > 0) best = value;
      }
  return best;
}

function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
function shuffled(seed: number) {
  const next = random(seed);
  const deck = [...PACK];
  for (let index = 51; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [deck[index], deck[other]] = [deck[other]!, deck[index]!];
  }
  return deck;
}

describe('Omaha: independent exactly-two-hole, exactly-three-board evaluator oracles', () => {
  test.each([
    ['one-card nut flush is invalid', 'As Kd Qc Jh', '2s 5s 8s Ts 3d', [0, 14, 13, 10, 8, 5]],
    ['board-only straight is invalid', '2c 2d 8h 8s', '9c Td Jh Qs Kc', [1, 8, 13, 12, 11]],
    ['board-only flush is invalid', 'Ac Ad Kc Kd', '2h 4h 7h Jh Qh', [1, 14, 12, 11, 7]],
    ['three-hole royal loses to a legal king-high straight flush', 'As Ks Qs 2d', 'Js Ts 9s 4h 3c', [8, 13]],
    ['four hole aces cannot make quads', 'As Ad Ac Ah', 'Ks Kd 7c 3h 2s', [2, 14, 13, 7]],
    ['three hole kings cannot make a full house', 'Ks Kd Kc Ah', '2s 2h Qd Jc 8h', [2, 13, 2, 12]],
    ['wheel uses ace low', 'As 2d Kc Qh', '3c 4d 5h 9s Jc', [4, 5]],
    ['two spades really do make the nut flush', 'As Ks 4d 2c', 'Qs Js 8s 7d 3h', [5, 14, 13, 12, 11, 8]],
  ])('%s', (_name, holeText, boardText, expected) => {
    const hole = cards(holeText); const board = cards(boardText);
    const ranked = evaluateOmaha(hole, board);
    expect(ranked.category).toBe(expected[0]);
    expect(ranked.cards).toHaveLength(5);
    expect(ranked.cards.filter(card => hole.includes(card))).toHaveLength(2);
    expect(ranked.cards.filter(card => board.includes(card))).toHaveLength(3);
    expect(fiveValue(ranked.cards)).toEqual(expected);
  });

  test('wheel order, ace-pair kicker order, and suit-neutral exact ties', () => {
    const wheelBoard = cards('3c 4d 5h 9s Jc');
    expect(evaluateOmaha(cards('As 2d Kc Qh'), wheelBoard).score)
      .toBeLessThan(evaluateOmaha(cards('2s 6d Kd Qc'), wheelBoard).score);
    const kickerBoard = cards('Ah 9c 8d 4s 3h');
    expect(evaluateOmaha(cards('As Kd Jc 2d'), kickerBoard).score)
      .toBeGreaterThan(evaluateOmaha(cards('Ad Qc Ts 2c'), kickerBoard).score);
    const tieBoard = cards('Ks Qh Jc 8h 9s');
    expect(evaluateOmaha(cards('As Ad 2c 3d'), tieBoard).score)
      .toBe(evaluateOmaha(cards('Ac Ah 4c 5d'), tieBoard).score);
  });

  test('a three-card flop can be evaluated, without using a third hole card', () => {
    const result = evaluateOmaha(cards('As Ks Qs 2d'), cards('Js Ts 3h'));
    expect(fiveValue(result.cards)).toEqual([0, 14, 13, 11, 10, 3]);
  });

  test.each([
    [[], cards('2c 3d 4h 5s 6c')],
    [cards('As Kd Qc'), cards('2c 3d 4h 5s 6c')],
    [cards('As Kd Qc Jh Ts'), cards('2c 3d 4h 5s 6c')],
    [cards('As Kd Qc Jh'), cards('2c 3d')],
    [cards('As Kd Qc Jh'), cards('2c 3d 4h 5s 6c 7d')],
    [cards('As As Qc Jh'), cards('2c 3d 4h 5s 6c')],
    [cards('As Kd Qc Jh'), cards('2c 3d 4h 5s As')],
    [cards('As Kd Qc Jh'), cards('2c 2c 4h 5s 6c')],
    [cards('1s Kd Qc Jh'), cards('2c 3d 4h 5s 6c')],
    [cards('As Kd Qc Jh'), cards('2c 3d 4h 5s 6x')],
  ])('rejects malformed or duplicate Omaha input %#', (hole, board) => {
    expect(() => evaluateOmaha(hole, board)).toThrow();
  });

  test('80 seeded full-deck samples match an independent 60-combination oracle', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const deck = shuffled(seed * 97);
      const hole = deck.slice(0, 4); const board = deck.slice(4, 9);
      const result = evaluateOmaha(hole, board);
      expect(result.cards.filter(card => hole.includes(card)), `seed ${seed}`).toHaveLength(2);
      expect(result.cards.filter(card => board.includes(card)), `seed ${seed}`).toHaveLength(3);
      expect(fiveValue(result.cards), `seed ${seed}`).toEqual(omahaValue(hole, board));
      expect(result.category).toBe(omahaValue(hole, board)[0]);
    }
  });
});

describe('PLO pot limits and genuine incomplete all-ins', () => {
  // TDA rules 49 and 56: full nominal blinds preflop; actual pot thereafter.
  // https://www.pokertda.com/view-poker-tda-rules/
  test('caps raise-to using own bet + full call + pot after call, not the stack or pot alone', () => {
    const table = new Table([1000, 1000, 1000, 1000]);
    table.rules('omaha', { omahaAnte: 5 }); table.deal();
    expect(table.room.hand?.actorId).toBe('p3');
    expect(legalActions(table.room, 'p3')).toMatchObject({
      bettingLimit: 'pot_limit', toCall: 20, callAmount: 20, minRaiseTo: 40,
      maxRaiseTo: 90, potLimitTo: 90, allInTo: 995, canAllIn: false, potAfterCall: 70,
    });
    rejected(table, 'p3', { type: 'act', action: 'raise', amount: 91 });
    rejected(table, 'p3', { type: 'act', action: 'raise', amount: 1000 });
    table.act('raise', 90);
    expect(legalActions(table.room, 'p0')).toMatchObject({ minRaiseTo: 160, maxRaiseTo: 320, potLimitTo: 320 });
    table.act('call');
    expect(legalActions(table.room, 'p1')).toMatchObject({
      toCall: 80, potAfterCall: 310, maxRaiseTo: 400, potLimitTo: 400, allInTo: 995,
    });
    table.act('call');
    expect(legalActions(table.room, 'p2')).toMatchObject({ toCall: 70, maxRaiseTo: 470, potLimitTo: 470 });
  });

  test.each([
    [[1000, 4, 1000, 1000], 27, 7],
    [[1000, 1000, 7, 1000], 20, 14],
    [[1000, 4, 7, 1000], 13, 21],
  ])('short blind fixture %# includes actual antes and nominal blinds in the first pot raise', (stacks, actualPot, correction) => {
    const table = new Table(stacks);
    table.rules('omaha', { omahaAnte: 1 }); table.deal();
    expect(table.room.hand).toMatchObject({ currentBet: 20, pot: actualPot, preflopPotAdjustment: correction });
    expect(legalActions(table.room, 'p3')).toMatchObject({ callAmount: 20, minRaiseTo: 40, maxRaiseTo: 74, potLimitTo: 74 });
    rejected(table, 'p3', { type: 'act', action: 'raise', amount: 75 });
    table.act('raise', 74);
    expect(legalActions(table.room, 'p0').potLimitTo).toBe(256);
  });

  test('short blinds use actual remaining chips after antes, without counting nominal antes', () => {
    const table = new Table([1000, 4, 7, 1000], { ante: 3 });
    table.rules('omaha', { omahaAnte: 3 }); table.deal();
    expect(table.room.hand).toMatchObject({ pot: 17, preflopPotAdjustment: 25 });
    expect(legalActions(table.room, 'p3').potLimitTo).toBe(82);
  });

  test('the short-blind adjustment is no longer spendable on the flop', () => {
    const table = new Table([1000, 4, 7, 1000]);
    table.rules('omaha', { omahaAnte: 1 }); table.deal();
    table.act('call'); table.act('call');
    expect(table.room.hand).toMatchObject({ street: 'flop', pot: 53, actorId: 'p3', currentBet: 0 });
    expect(legalActions(table.room, 'p3')).toMatchObject({ potLimitTo: 53, maxRaiseTo: 53, potAfterCall: 53 });
    rejected(table, 'p3', { type: 'act', action: 'raise', amount: 54 });
    table.act('raise', 53);
  });

  test('a pot cap below the minimum is NOT a short-stack all-in exception', () => {
    const table = new Table();
    table.rules('omaha_bomb', { bombAnte: 1 }); table.deal();
    expect(legalActions(table.room, 'p1')).toMatchObject({
      minRaiseTo: 20, maxRaiseTo: 2, potLimitTo: 2, allInTo: 999, canAllIn: false, canRaise: false,
    });
    rejected(table, 'p1', { type: 'act', action: 'raise', amount: 2 });
  });

  test('a real remaining two-chip stack can open all-in below the minimum', () => {
    const table = new Table([100, 7]);
    table.rules('omaha_bomb', { bombAnte: 5 }); table.deal();
    expect(legalActions(table.room, 'p1')).toMatchObject({
      allInTo: 2, maxRaiseTo: 2, canAllIn: true, canRaise: true, minRaiseTo: 20,
    });
    table.act('raise', 2); table.act('call');
    expect(table.room.hand).toMatchObject({ street: 'complete', awardedPot: 14 });
    ledgerBalances(table);
  });

  test('a prior full raiser may only call a single incomplete all-in', () => {
    const table = new Table([1000, 80, 1000, 1000]);
    table.rules('omaha', { omahaAnte: 5 }); table.deal();
    table.act('call'); table.act('raise', 60); table.act('raise', 75);
    table.act('call'); table.act('call');
    expect(table.room.hand?.actorId).toBe('p0');
    expect(legalActions(table.room, 'p0')).toMatchObject({ canRaise: false, callAmount: 15, minRaiseTo: 115 });
    rejected(table, 'p0', { type: 'act', action: 'raise', amount: 115 });
    table.act('call');
    expect(table.room.hand?.street).toBe('flop');
  });

  test('two incomplete all-ins cumulatively reopen a full raise', () => {
    const table = new Table([1000, 80, 105, 1000]);
    table.rules('omaha', { omahaAnte: 5 }); table.deal();
    table.act('call'); table.act('raise', 60);
    table.act('raise', 75); table.act('raise', 100); table.act('call');
    expect(legalActions(table.room, 'p0')).toMatchObject({ canRaise: true, minRaiseTo: 140 });
    table.act('raise', 140);
  });

  test.each(['holdem', 'omaha'] as const)('%s: checking does not reopen against an incomplete opening all-in', game => {
    const table = new Table([1000, 1000, game === 'omaha' ? 50 : 30]);
    table.rules(game); table.deal(); table.street();
    expect(table.room.hand?.actorId).toBe('p1');
    table.act('check'); table.act('raise', 10);
    expect(legalActions(table.room, 'p0')).toMatchObject({ canRaise: true, minRaiseTo: 30 });
    table.act('call');
    expect(legalActions(table.room, 'p1')).toMatchObject({ canRaise: false, callAmount: 10 });
    rejected(table, 'p1', { type: 'act', action: 'raise', amount: 30 });
    table.act('call');
    expect(table.room.hand?.street).toBe('turn');
  });

  test('a checker does regain raising after cumulative opening all-ins reach a full bet', () => {
    const table = new Table([1000, 1000, 50, 60]);
    table.rules('omaha'); table.deal(); table.street();
    table.act('check'); table.act('raise', 10); table.act('raise', 20); table.act('call');
    expect(table.room.hand?.actorId).toBe('p1');
    expect(legalActions(table.room, 'p1')).toMatchObject({ canRaise: true, minRaiseTo: 40 });
    table.act('raise', 40);
  });
});

describe('double-board PLO bomb pots', () => {
  // One shared burn precedes both boards on each street; there is no blind or preflop betting.
  // https://www.pokerstars.com/poker/learn/news/what-is-a-bomb-pot-in-poker/
  test('nine seats use exactly 36 holes, ten board cards, and three burns, leaving three cards', () => {
    const table = new Table(Array<number>(9).fill(1000), { ante: 3 });
    table.rules('omaha_bomb', { bombAnte: 7 });
    const dealt = table.deal([...PACK]);
    expect(table.room.hand).toMatchObject({
      street: 'flop', buttonSeat: 0, smallBlindSeat: null, bigBlindSeat: null,
      actorId: 'p1', currentBet: 0, pot: 63,
    });
    expect(dealt.transfers.filter(item => item.kind === 'blind')).toEqual([]);
    expect(dealt.transfers.filter(item => item.kind === 'ante').map(item => item.chips)).toEqual(Array(9).fill(7));
    for (let seat = 0; seat < 9; seat++) {
      const offset = seat === 0 ? 8 : seat - 1;
      expect(table.room.hand!.holeCards[`p${seat}`]).toEqual([0, 1, 2, 3].map(round => PACK[round * 9 + offset]));
    }
    expect(table.room.hand!.boards).toEqual([PACK.slice(37, 40), PACK.slice(40, 43)]);
    expect(table.room.hand!.burned).toEqual([PACK[36]]);
    expect(table.room.hand!.deck).toHaveLength(9);
    physicalCards(table.room);
    table.street();
    expect(table.room.hand!.boards).toEqual([
      [...PACK.slice(37, 40), PACK[44]], [...PACK.slice(40, 43), PACK[45]],
    ]);
    expect(table.room.hand!.burned).toEqual([PACK[36], PACK[43]]);
    physicalCards(table.room);
    table.street();
    expect(table.room.hand!.boards).toEqual([
      [...PACK.slice(37, 40), PACK[44], PACK[47]], [...PACK.slice(40, 43), PACK[45], PACK[48]],
    ]);
    expect(table.room.hand!.burned).toEqual([PACK[36], PACK[43], PACK[46]]);
    expect(table.room.hand!.deck).toHaveLength(3);
    table.finish();
    physicalCards(table.room);
    expect(table.room.hand!.results.map(result => [result.boardIndex, result.amount])).toEqual([[0, 32], [1, 31]]);
    ledgerBalances(table);
  });

  const holes = [cards('As Ah 2c 3d'), cards('Ks Kh 4c 5d'), cards('Qs Qh 6c 7d')];
  const boards = [cards('Ac Ad 8c 9d Ts'), cards('Kc Kd 8h 9s Jc')];

  test('the two boards choose different winners and the first board receives the odd chip', () => {
    const table = new Table([100, 100, 100], { smallBlind: 1, bigBlind: 2 });
    table.rules('omaha_bomb', { bombAnte: 5 }); table.deal(boardDeck(holes, boards)); table.finish();
    expect(table.room.hand!.boards).toEqual(boards);
    expect(table.room.hand!.results).toMatchObject([
      { potIndex: 0, boardIndex: 0, runoutIndex: 0, amount: 8, shares: { p0: 8 } },
      { potIndex: 0, boardIndex: 1, runoutIndex: 0, amount: 7, shares: { p1: 7 } },
    ]);
    expect(table.room.players.map(item => item.stack)).toEqual([103, 102, 95]);
    ledgerBalances(table);
  });

  test('every side pot is independently split by board and restricted to its contributors', () => {
    const table = new Table([5, 11, 18], { smallBlind: 1, bigBlind: 2 });
    table.rules('omaha_bomb', { bombAnte: 5 }); table.deal(boardDeck(holes, boards));
    table.act('raise', 6); table.act('call');
    expect(table.room.hand?.street).toBe('complete');
    const results = table.room.hand!.results.map(result => ({
      pot: result.potIndex, board: result.boardIndex, run: result.runoutIndex,
      amount: result.amount, shares: result.shares, eligible: [...result.eligible].sort(),
    })).sort((a, b) => a.pot - b.pot || a.board - b.board);
    expect(results).toEqual([
      { pot: 0, board: 0, run: 0, amount: 8, shares: { p0: 8 }, eligible: ['p0', 'p1', 'p2'] },
      { pot: 0, board: 1, run: 0, amount: 7, shares: { p1: 7 }, eligible: ['p0', 'p1', 'p2'] },
      { pot: 1, board: 0, run: 0, amount: 6, shares: { p2: 6 }, eligible: ['p1', 'p2'] },
      { pot: 1, board: 1, run: 0, amount: 6, shares: { p1: 6 }, eligible: ['p1', 'p2'] },
    ]);
    expect(table.room.hand!.awardedPot).toBe(27);
    expect(omahaValue(holes[2]!, boards[0]!)).toEqual([4, 10]);
    expect(table.room.players.map(item => item.stack)).toEqual([8, 13, 13]);
    ledgerBalances(table);
  });

  test('ties are divided only after board splitting, with odd chips clockwise left of the button', () => {
    const table = new Table([20, 20, 20], { smallBlind: 1, bigBlind: 2 });
    table.rules('omaha_bomb', { bombAnte: 3 });
    table.deal(boardDeck(
      [cards('As Kd 2c 3c'), cards('Ah Kc 4c 5c'), cards('8c 8d 6d 7d')],
      [cards('Qs Jh Td 9c 2h'), cards('Qd Js Tc 9d 3h')],
    ));
    table.finish();
    expect(table.room.hand!.results.map(result => result.shares)).toEqual([{ p1: 3, p0: 2 }, { p1: 2, p0: 2 }]);
    expect(table.room.players.map(item => item.stack)).toEqual([21, 22, 17]);
    ledgerBalances(table);
  });
});

describe('Indian Holdem: normal boards and betting with inverse hole-card privacy', () => {
  test('the saved one-card variant still evaluates ace high without suit tiebreaks', () => {
    expect(evaluateIndian('Ac').score).toBeGreaterThan(evaluateIndian('Kh').score);
    expect(evaluateIndian('Kh').score).toBeGreaterThan(evaluateIndian('2s').score);
    expect(new Set(['Ac', 'Ad', 'Ah', 'As'].map(card => evaluateIndian(card).score)).size).toBe(1);
    for (const card of ['', '1s', '10h', 'aS', 'As ', 'Xx', 'As As']) expect(() => evaluateIndian(card)).toThrow();
  });

  test('posts the mandatory Indian ante before normal blinds and plays every Holdem street', () => {
    const table = new Table([100, 100, 100], { ante: 3 });
    table.rules('indian', { indianAnte: 5, maxRunouts: 3 });
    const result = table.deal(boardDeck([cards('As Ad'), cards('Kc Kd'), cards('Qc Qd')], [cards('2c 3d 6h 9s Jc')]));
    expect(table.room.hand).toMatchObject({
      actorId: 'p0', buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, currentBet: 20, pot: 45, board: [],
    });
    expect(table.room.hand!.holeCards).toEqual({ p0: ['As', 'Ad'], p1: ['Kc', 'Kd'], p2: ['Qc', 'Qd'] });
    expect(result.transfers.filter(item => item.kind === 'ante').map(item => item.chips)).toEqual([5, 5, 5]);
    expect(result.transfers.filter(item => item.kind === 'blind').map(item => item.chips)).toEqual([10, 20]);
    expect(legalActions(table.room, 'p0')).toMatchObject({
      bettingLimit: 'no_limit', potLimitTo: null, allInTo: 95, maxRaiseTo: 95, canAllIn: true,
    });
    for (const street of ['flop', 'turn', 'river', 'complete']) {
      table.street();
      expect(table.room.hand!.street).toBe(street);
      if (street !== 'complete') expect(table.room.hand!.actorId).toBe('p1');
    }
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null, awardedPot: 75 });
    expect(table.room.hand!.boards).toEqual([cards('2c 3d 6h 9s Jc')]);
    expect(table.room.hand!.burned).toHaveLength(3);
    expect(table.room.hand!.deck).toHaveLength(38);
    expect(table.room.players.map(item => item.stack)).toEqual([150, 75, 75]);
    physicalCards(table.room); ledgerBalances(table);
  });

  test('owners, folded owners, opponents, and unfunded observers get the right active view', () => {
    const table = new Table([100, 100, 100]);
    table.send('observer', { type: 'join', name: 'Observer' });
    table.rules('indian', { indianAnte: 5 }); table.deal(boardDeck([cards('As Ad'), cards('Kc Kd'), cards('Qc Qd')], [cards('2c 3d 6h 9s Jc')]));
    const ownCards = table.room.hand!.holeCards;
    for (const id of ['p0', 'p1', 'p2', 'observer']) {
      const view = roomView(table.room, id, new Set(), table.now);
      expect(view.hand).not.toHaveProperty('deck');
      expect(view.hand).not.toHaveProperty('burned');
      expect(view.hand).not.toHaveProperty('holeCards');
      for (const dealtId of ['p0', 'p1', 'p2']) {
        expect(view.players.find(item => item.id === dealtId)!.cards).toEqual(id === dealtId ? [null, null] : ownCards[dealtId]);
      }
      if (id !== 'observer') expect(JSON.stringify(view)).not.toContain(`"${ownCards[id]![0]}"`);
    }
    table.act('fold');
    expect(table.room.hand!.street).not.toBe('complete');
    const foldedOwner = roomView(table.room, 'p0', new Set(), table.now);
    expect(foldedOwner.players.find(item => item.id === 'p0')!.cards).toEqual(ownCards.p0);
    expect(table.room.hand!.revealed).toEqual({});
    expect(roomView(table.room, 'p1', new Set()).players.find(item => item.id === 'p1')!.cards).toEqual([null, null]);
    table.finish();
    for (const id of ['p0', 'p1', 'p2']) {
      const view = roomView(table.room, id, new Set(), table.now);
      expect(view.players.find(item => item.id === id)!.cards).toEqual(ownCards[id]);
    }
  });

  test('ordinary Holdem ties split an odd ante pot by seat, not by suit', () => {
    const table = new Table([100, 100, 100]);
    table.rules('indian', { indianAnte: 3 });
    table.deal(boardDeck([cards('As Kc'), cards('Ad Kd'), cards('Qc Jd')], [cards('2c 3d 4h 5s 9c')]));
    table.finish();
    expect(table.room.hand!.results.map(result => result.shares)).toEqual([{ p1: 35, p0: 34 }]);
    expect(table.room.players.map(item => item.stack)).toEqual([111, 112, 77]);
    ledgerBalances(table);
  });

  test('all-in antes run a full board when configured to run once', () => {
    const table = new Table([5, 5, 5]);
    table.rules('indian', { indianAnte: 5, maxRunouts: 1 });
    table.deal(boardDeck([cards('As Ad'), cards('Kc Kd'), cards('Qc Qd')], [cards('2c 3d 6h 9s Jc')]));
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 1 });
    expect(table.room.hand!.burned).toHaveLength(3);
    expect(table.room.hand!.board).toHaveLength(5);
    expect(table.room.hand!.deck).toHaveLength(38);
    expect(table.room.players.map(item => item.stack)).toEqual([15, 0, 0]);
    ledgerBalances(table);
  });
});

describe('frozen next-hand choices and minimum buy-in', () => {
  test('mid-hand changes do not alter rules, cards, bets, or money in flight, and persist across deals', () => {
    const table = new Table([1000, 1000, 1000]);
    table.rules('holdem', { sevenDeuceBounty: 9 }); table.deal();
    const hand = structuredClone(table.room.hand);
    const accounts = table.room.players.map(item => [item.stack, item.buyIns, item.cashOuts, item.bountyNet]);
    const next: HandRules = { game: 'omaha_bomb', bombAnte: 7, indianAnte: 11, omahaAnte: 13, sevenDeuceBounty: 17, maxRunouts: 3 };
    expect(table.send('p0', { type: 'next_hand', rules: next }).transfers).toEqual([]);
    expect(table.room.hand).toEqual(hand);
    expect(table.room.nextHandRules).toEqual(next);
    expect(table.room.players.map(item => [item.stack, item.buyIns, item.cashOuts, item.bountyNet])).toEqual(accounts);
    next.bombAnte = 999;
    expect(table.room.nextHandRules.bombAnte).toBe(7);
    table.finish(); table.deal();
    expect(table.room.hand!.rules).toEqual(table.room.nextHandRules);
    expect(table.room.hand!.rules.bombAnte).toBe(7);
    expect(table.room.hand!.street).toBe('flop');
    table.finish(); table.deal();
    expect(table.room.hand!.rules.game).toBe('omaha_bomb');
    expect(table.room.hand!.rules.bombAnte).toBe(7);
    expect(table.room.hand!.pot).toBe(21);
  });

  test('only the host may change next-hand rules; schema rejects unsupported rule values', () => {
    const table = new Table();
    rejected(table, 'p1', { type: 'next_hand', rules: { ...defaultHandRules(), game: 'omaha' } });
    for (const invalid of [
      { game: 'five_card_omaha' }, { maxRunouts: 0 }, { maxRunouts: 4 }, { maxRunouts: 1.5 },
      { bombAnte: 0 }, { indianAnte: -1 }, { omahaAnte: 0 }, { omahaAnte: -1 }, { omahaAnte: 1.5 },
      { omahaAnte: 10_000_001 }, { sevenDeuceBounty: -1 }, { sevenDeuceBounty: 1.5 },
    ]) {
      expect(commandSchema.safeParse({ type: 'next_hand', rules: { ...defaultHandRules(), ...invalid } }).success).toBe(false);
    }
  });

  test('default 500 is accepted for a host and approved guest, while initial 499 is rejected', () => {
    expect(DEFAULT_SETTINGS.minBuyIn).toBe(500);
    expect(settingsSchema.parse({}).minBuyIn).toBe(500);
    expect(() => new Table([499], { ...DEFAULT_SETTINGS, autoDeal: false })).toThrow();
    const table = new Table([500], { ...DEFAULT_SETTINGS, autoDeal: false });
    table.send('p1', { type: 'join', name: 'Guest five hundred' });
    rejected(table, 'p1', { type: 'fund', amount: 499 });
    table.send('p1', { type: 'fund', amount: 500 });
    expect(player(table.room, 'p1').stack).toBe(0);
    table.send('p0', { type: 'approve', requestId: table.room.requests.at(-1)!.id, approve: true });
    expect(table.room.players.map(item => item.stack)).toEqual([500, 500]);
    ledgerBalances(table);
  });

  test('rebuys must reach 500 but add-ons can still be one chip', () => {
    const table = new Table([500, 500], { ...DEFAULT_SETTINGS, autoDeal: false });
    table.send('p0', { type: 'fund', amount: 1 });
    expect(player(table.room, 'p0')).toMatchObject({ stack: 501, buyIns: 501, addOnCount: 1 });
    table.send('p1', { type: 'cash_out' }); table.send('p1', { type: 'join', name: 'Returning guest' });
    rejected(table, 'p1', { type: 'fund', amount: 499 });
    table.send('p1', { type: 'fund', amount: 500 });
    table.send('p0', { type: 'approve', requestId: table.room.requests.at(-1)!.id, approve: true });
    expect(player(table.room, 'p1')).toMatchObject({ stack: 500, buyIns: 1000, cashOuts: 500, rebuyCount: 1 });
    ledgerBalances(table);
  });

  test('a genuinely busted player still cannot rebuy for 499 under the default minimum', () => {
    const table = new Table([500, 500], { ...DEFAULT_SETTINGS, autoDeal: false });
    table.deal(boardDeck([cards('As Ad'), cards('Ks Kd')], [cards('2c 3d 7h 9c Ts')]));
    table.act('raise', 500); table.act('call');
    expect(table.room.players.map(item => item.stack)).toEqual([1000, 0]);
    rejected(table, 'p1', { type: 'fund', amount: 499 });
    table.send('p1', { type: 'fund', amount: 500 });
    expect(table.room.requests.at(-1)).toMatchObject({ kind: 'rebuy', amount: 500, status: 'pending' });
    table.send('p0', { type: 'approve', requestId: table.room.requests.at(-1)!.id, approve: true });
    expect(table.room.players.map(item => item.stack)).toEqual([1000, 500]);
    expect(player(table.room, 'p1')).toMatchObject({ buyIns: 1000, cashOuts: 0, rebuyCount: 1 });
    ledgerBalances(table);
  });

  test('host can change an existing minimum without moving money or retroactively repricing a hand', () => {
    const table = new Table([500, 500], { ...DEFAULT_SETTINGS, autoDeal: false });
    table.deal();
    const before = structuredClone(table.room.players);
    const command: Command = {
      type: 'settings', smallBlind: 50, bigBlind: 100, ante: 0, autoDeal: false,
      turnSeconds: 45, allowRebuys: true, minBuyIn: 600,
    };
    rejected(table, 'p1', command);
    const effect = table.send('p0', command);
    expect(effect.transfers).toEqual([]);
    expect(table.room.players).toEqual(before);
    expect(table.room.settings.minBuyIn).toBe(600);
    rejected(table, 'p0', { ...command, minBuyIn: 20001 });
    rejected(table, 'p0', { ...command, minBuyIn: 0 });
    table.act('fold');
    table.send('p2', { type: 'join', name: 'New minimum' });
    rejected(table, 'p2', { type: 'fund', amount: 500 });
    table.send('p2', { type: 'fund', amount: 600 });
    table.send('p0', { type: 'approve', requestId: table.room.requests.at(-1)!.id, approve: true });
    expect(player(table.room, 'p2').stack).toBe(600);
  });
});

describe('7/2 offsuit: a separate uncapped, zero-sum bounty ledger', () => {
  test('an uncontested winner deliberately reveals 72 and accrues debt without changing chip bankrolls', () => {
    const table = new Table([1000, 1000], { chipValueCents: 3 });
    table.rules('holdem', { sevenDeuceBounty: 75 }); table.deal(rig(cards('As 7c Kd 2d')));
    table.act('raise', 60);
    const effects = table.act('fold');
    expect(table.room.players.map(item => item.stack)).toEqual([1020, 980]);
    expect(table.room.players.map(item => item.buyIns)).toEqual([1000, 1000]);
    expect(table.room.players.map(item => item.cashOuts)).toEqual([0, 0]);
    expect(table.room.players.map(item => item.bountyNet)).toEqual([75, -75]);
    expect(table.room.hand).toMatchObject({
      showdown: false, awardedPot: 40, revealed: { p0: ['7c', '2d'] },
      bounty: { winnerId: 'p0', payerIds: ['p1'], amount: 75, totalAmount: 75 },
      balanceAfter: { p0: 1020, p1: 980 }, bountyAfter: { p0: 75, p1: -75 },
    });
    expect(effects.transfers.filter(item => item.kind === 'bounty')).toMatchObject([{
      kind: 'bounty', from: 'bounty:p1', to: 'bounty:p0', playerId: 'p1',
      chips: 75, cashCents: 225, handId: table.room.hand!.id,
    }]);
    const view = roomView(table.room, 'p1', new Set(), table.now);
    expect(view.players.find(item => item.id === 'p0')).toMatchObject({ cards: ['7c', '2d'], chipNet: 20, net: 95 });
    expect(view.players.find(item => item.id === 'p1')).toMatchObject({ chipNet: -20, net: -95 });
    const count = table.transfers.filter(item => item.kind === 'bounty').length;
    table.send('p0', { type: 'chat', message: 'A completed hand cannot pay a bounty twice.' });
    expect(table.transfers.filter(item => item.kind === 'bounty')).toHaveLength(count);
    ledgerBalances(table);
  });

  test('folded and busted dealt players pay in full; sitting-out observers and mid-hand arrivals never pay', () => {
    const table = new Table([100, 100, 30, 50], { chipValueCents: 2 });
    table.send('p3', { type: 'sit_out', value: true });
    table.rules('holdem', { sevenDeuceBounty: 1000 });
    table.deal(boardDeck(
      [cards('7c 2d'), cards('As Ad'), cards('Ks Kd')],
      [cards('7s 7h 2c Qh 9d')],
    ));
    table.send('arrival', { type: 'join', name: 'Mid-hand arrival' });
    table.act('raise', 100); table.act('fold'); table.act('call');
    expect(table.room.hand!.street).toBe('complete');
    expect(table.room.hand!.bounty).toEqual({
      winnerId: 'p0', payerIds: ['p1', 'p2'], amount: 1000, totalAmount: 2000,
    });
    expect(table.room.players.map(item => item.stack)).toEqual([140, 90, 0, 50, 0]);
    expect(table.room.players.map(item => item.buyIns)).toEqual([100, 100, 30, 50, 0]);
    expect(table.room.players.map(item => item.cashOuts)).toEqual([0, 0, 0, 0, 0]);
    expect(table.room.players.map(item => item.bountyNet)).toEqual([2000, -1000, -1000, 0, 0]);
    expect(table.transfers.filter(item => item.kind === 'bounty').map(item => [item.playerId, item.chips, item.cashCents]))
      .toEqual([['p1', 1000, 2000], ['p2', 1000, 2000]]);
    ledgerBalances(table);
  });

  test.each([
    ['suited seven-deuce', '7c 2c', 50],
    ['disabled bounty', '7c 2d', 0],
    ['a different weak hand', '7c 3d', 50],
  ])('%s cannot earn the bounty', (_name, hole, bounty) => {
    const table = new Table();
    table.rules('holdem', { sevenDeuceBounty: bounty });
    const [first, second] = cards(hole);
    table.deal(rig(['As', first!, 'Kd', second!]));
    table.act('raise', 60); table.act('fold');
    expect(table.room.hand!.bounty).toBeNull();
    expect(table.room.hand!.revealed).toEqual({});
    expect(table.transfers.filter(item => item.kind === 'bounty')).toEqual([]);
    expect(table.room.players.map(item => item.bountyNet)).toEqual([0, 0]);
    ledgerBalances(table);
  });

  test.each(['omaha', 'omaha_bomb', 'indian'] as const)('%s never awards the Holdem-only bounty', game => {
    const table = new Table();
    table.rules(game, { sevenDeuceBounty: 50, bombAnte: 5, indianAnte: 5 });
    table.deal(game === 'indian' ? rig(cards('As 7c')) : rig(cards('As 7c Kd 2d Qc 8h Jh 9h')));
    if (table.room.hand!.actorId === 'p0') table.act('call');
    table.act('fold');
    expect(table.room.hand!.street).toBe('complete');
    expect(table.room.hand!.bounty).toBeNull();
    expect(table.transfers.filter(item => item.kind === 'bounty')).toEqual([]);
    ledgerBalances(table);
  });

  test('a board-playing tie earns no bounty even when one tied hand is 72 offsuit', () => {
    const table = new Table([100, 100]);
    table.rules('holdem', { sevenDeuceBounty: 50 });
    table.deal(boardDeck([cards('7c 2d'), cards('6c 3d')], [cards('Ah Kh Qh Jh Th')]));
    table.finish();
    expect(table.room.hand!.results[0]!.shares).toEqual({ p1: 20, p0: 20 });
    expect(table.room.hand!.bounty).toBeNull();
    expect(table.room.players.map(item => item.bountyNet)).toEqual([0, 0]);
  });

  test('winning the main pot but losing a positive side pot does not qualify', () => {
    const table = new Table([20, 100, 100]);
    table.rules('holdem', { sevenDeuceBounty: 50 });
    table.deal(boardDeck([cards('7c 2d'), cards('As Ad'), cards('Ks Kd')], [cards('7s 7h 2c Qh 9d')]));
    table.act('call'); table.act('raise', 100); table.act('call');
    expect(table.room.hand!.results.map(result => [result.amount, result.shares])).toEqual([[60, { p0: 60 }], [160, { p1: 160 }]]);
    expect(table.room.hand!.bounty).toBeNull();
    expect(table.transfers.filter(item => item.kind === 'bounty')).toEqual([]);
    ledgerBalances(table);
  });

  test('turning the next-hand bounty off cannot change the frozen current-hand award', () => {
    const table = new Table();
    table.rules('holdem', { sevenDeuceBounty: 41 }); table.deal(rig(cards('As 7c Kd 2d')));
    table.rules('holdem', { sevenDeuceBounty: 0 });
    table.act('raise', 60); table.act('fold');
    expect(table.room.hand!.rules.sevenDeuceBounty).toBe(41);
    expect(table.room.hand!.bounty?.totalAmount).toBe(41);
    expect(table.room.nextHandRules.sevenDeuceBounty).toBe(0);
    ledgerBalances(table);
  });
});

function asLegacy(room: Room) {
  const legacy = structuredClone(room);
  legacy.schemaVersion = 1;
  delete (legacy as unknown as Record<string, unknown>).nextHandRules;
  for (const item of legacy.players) delete (item as unknown as Record<string, unknown>).bountyNet;
  if (legacy.hand) {
    for (const key of ['rules', 'boards', 'runoutBoards', 'runoutPrefix', 'runoutCount', 'runoutVote', 'preflopPotAdjustment', 'bounty', 'bountyAfter']) {
      delete (legacy.hand as unknown as Record<string, unknown>)[key];
    }
    for (const result of legacy.hand.results) for (const key of ['potIndex', 'boardIndex', 'runoutIndex']) {
      delete (result as unknown as Record<string, unknown>)[key];
    }
  }
  return legacy;
}

describe('legacy state and history remain ordinary single-run Holdem', () => {
  test.each([false, true])('normalizes a legacy %s-completed hand without changing monetary state or cards', complete => {
    const table = new Table([5000, 5000], { minBuyIn: 4000 });
    table.deal(); if (complete) table.finish();
    const legacy = asLegacy(table.room);
    const before = structuredClone(legacy);
    const normalized = normalizeRoom(legacy);
    expect(normalized.schemaVersion).toBe(3);
    expect(normalized.settings.minBuyIn).toBe(4000);
    expect(normalized.nextHandRules).toEqual(defaultHandRules(normalized.settings));
    expect(normalized.hand!.rules).toEqual(defaultHandRules(normalized.settings));
    expect(normalized.hand).toMatchObject({ runoutCount: 1, runoutVote: null, runoutPrefix: null, bounty: null });
    expect(normalized.hand!.boards).toEqual([before.hand!.board]);
    expect(normalized.hand!.board).toEqual(before.hand!.board);
    expect(normalized.hand!.deck).toEqual(before.hand!.deck);
    expect(normalized.hand!.holeCards).toEqual(before.hand!.holeCards);
    expect(normalized.hand!.players).toEqual(before.hand!.players);
    expect(normalized.hand!.balanceAfter).toEqual(before.hand!.balanceAfter);
    expect(normalized.players.map(({ bountyNet: _bounty, ...rest }) => rest)).toEqual(before.players);
    expect(normalized.players.map(item => item.bountyNet)).toEqual([0, 0]);
    expect(normalized.version).toBe(before.version);
    expect(normalizeRoom(structuredClone(normalized))).toEqual(normalized);
    physicalCards(normalized);
  });

  test('legacy history gains only variant metadata, preserving amounts, reveals, and hand identity', () => {
    const legacy = {
      id: 'old-hand', number: 12, board: cards('Ah Kh Qh Jh Th'), buttonSeat: 2, pot: 41, completedAt: 1_700_000_000_000,
      results: [{ amount: 41, eligible: ['a', 'b'], winners: ['a', 'b'], shares: { a: 21, b: 20 }, description: 'Royal flush' }],
      revealed: { a: cards('2c 3d'), b: cards('4s 5d') }, balanceAfter: { a: 4001, b: 3999 },
    } as unknown as HandHistory;
    const copy = structuredClone(legacy);
    const history = normalizeHistory(legacy);
    expect(history).toMatchObject({
      ...copy, rules: defaultHandRules(), boards: [copy.board], runoutBoards: [[copy.board]],
      runoutCount: 1, bounty: null, bountyAfter: { a: 0, b: 0 }, showdown: true,
    });
    expect(history.results).toEqual([{ ...copy.results[0], potIndex: 0, boardIndex: 0, runoutIndex: 0 }]);
    expect(normalizeHistory(structuredClone(history))).toEqual(history);
  });

  test('legacy uncontested history infers showdown=false without inventing a reveal', () => {
    const legacy = {
      id: 'old-uncontested-hand', number: 13, board: [], buttonSeat: 0, pot: 40, completedAt: 1_700_000_000_000,
      results: [{ amount: 40, eligible: ['a'], winners: ['a'], shares: { a: 40 }, description: 'Uncontested' }],
      revealed: {}, balanceAfter: { a: 4020, b: 3980 },
    } as unknown as HandHistory;
    const history = normalizeHistory(legacy);
    expect(history).toMatchObject({ showdown: false, revealed: {}, bounty: null, board: [], runoutCount: 1 });
    expect(history.balanceAfter).toEqual(legacy.balanceAfter);
    expect(history.results[0]!.shares).toEqual({ a: 40 });
  });

  test('current-format bounty reveals never overwrite the explicit showdown=false history field', () => {
    const history: HandHistory = {
      id: 'bounty-fold-hand', number: 14, board: [], boards: [[]], runoutBoards: [[[]]], runoutCount: 1,
      rules: { ...defaultHandRules(), sevenDeuceBounty: 25 }, showdown: false,
      bounty: { winnerId: 'a', payerIds: ['b'], amount: 25, totalAmount: 25 }, bountyAfter: { a: 25, b: -25 },
      buttonSeat: 0, pot: 40, completedAt: 1_800_000_000_000,
      results: [{ potIndex: 0, boardIndex: 0, runoutIndex: 0, amount: 40, eligible: ['a'], winners: ['a'], shares: { a: 40 }, description: 'Uncontested' }],
      revealed: { a: cards('7c 2d') }, balanceAfter: { a: 4020, b: 3980 },
    };
    const before = structuredClone(history);
    expect(normalizeHistory(history)).toEqual(before);
    expect(history.showdown).toBe(false);
    expect(history.revealed).toEqual({ a: ['7c', '2d'] });
  });
});

describe('bounded seeded full-hand variant sweeps with independent physical and financial accounting', () => {
  test.each(['holdem', 'omaha', 'omaha_bomb', 'indian'] as const)('%s: 16 full hands, varied seats, folds, raises and stack depths', game => {
    const seenActions = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const next = random(seed * 1009);
      const seats = 2 + seed % 8;
      const table = new Table(Array.from({ length: seats }, (_, seat) => 80 + ((seat + 1) * seed * 13) % 221), { smallBlind: 2, bigBlind: 4 });
      table.rules(game, { bombAnte: 7, indianAnte: 5, sevenDeuceBounty: 11, maxRunouts: 1 });
      table.deal(shuffled(seed * 991));
      for (let turns = 0; table.room.hand!.street !== 'complete'; turns++) {
        if (turns >= 300) throw new Error(`${game}, seed ${seed}: hand failed to terminate`);
        physicalCards(table.room);
        const hand = table.room.hand!;
        expect(hand.runoutVote).toBeNull();
        expect(Object.values(hand.holeCards).map(hole => hole.length))
          .toEqual(Array(seats).fill(game.startsWith('omaha') ? 4 : 2));
        const actor = hand.actorId!;
        const legal = legalActions(table.room, actor);
        expect(legal.canAct, `${game}, seed ${seed}, actor ${actor}`).toBe(true);
        if (game.startsWith('omaha')) {
          const hp = hand.players.find(item => item.id === actor)!;
          const fullCall = Math.max(0, hand.currentBet - hp.streetBet);
          const nominal = hand.street === 'preflop' ? hand.preflopPotAdjustment : 0;
          const expectedCap = hp.streetBet + fullCall + hand.pot + nominal + fullCall;
          expect(legal.potLimitTo).toBe(expectedCap);
          expect(legal.maxRaiseTo).toBe(Math.min(hp.streetBet + player(table.room, actor).stack, expectedCap));
        }
        const choice = next();
        if (choice < 0.16) { seenActions.add('fold'); table.act('fold'); }
        else if (choice > 0.62 && legal.canRaise && (legal.maxRaiseTo >= legal.minRaiseTo || legal.canAllIn)) {
          seenActions.add('raise'); table.act('raise', legal.maxRaiseTo);
        } else { seenActions.add(legal.canCheck ? 'check' : 'call'); table.passive(); }
      }
      const hand = table.room.hand!;
      physicalCards(table.room);
      expect(sum(hand.results.map(result => result.amount))).toBe(hand.awardedPot);
      expect(sum(hand.results.flatMap(result => Object.values(result.shares)))).toBe(hand.awardedPot);
      expect(hand.pot).toBe(0);
      ledgerBalances(table);
    }
    expect([...seenActions].sort()).toEqual(['call', 'check', 'fold', 'raise']);
  });
});
