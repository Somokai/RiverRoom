import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS, defaultHandRules,
  type Card, type ChipTransfer, type Command, type GameVariant, type HandRules,
  type Room, type RoomSettings, type RunoutCount,
} from '../src/shared/model';
import { createRoom, legalActions, timeoutRunout, timeoutTurn, transition, type Transition } from '../src/server/engine';
import { normalizeRoom } from '../src/server/state';
import { commandSchema } from '../src/server/validation';

const PACK = [...'23456789TJQKA'].flatMap(rank => [...'cdhs'].map(suit => rank + suit));
const cards = (text: string) => text.split(' ');
const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

function rig(prefix: Card[]) {
  expect(prefix.length).toBeLessThanOrEqual(52);
  expect(new Set(prefix).size, 'The rig itself must be a physical deck').toBe(prefix.length);
  expect(prefix.every(card => PACK.includes(card))).toBe(true);
  return [...prefix, ...PACK.filter(card => !prefix.includes(card))];
}

function runDeck(holes: Card[][], runs: Card[][][], sharedLength: 0 | 3 | 4 = 0) {
  const order = [...holes.slice(1), holes[0]!];
  const prefix = runs[0]!.map(board => board.slice(0, sharedLength));
  for (const run of runs) {
    expect(run).toHaveLength(prefix.length);
    run.forEach((board, index) => expect(board.slice(0, sharedLength)).toEqual(prefix[index]));
  }
  const physical = [
    ...holes.flat(), ...prefix.flat(),
    ...runs.flatMap(run => run.flatMap(board => board.slice(sharedLength))),
  ];
  expect(new Set(physical).size).toBe(physical.length);
  const availableBurns = PACK.filter(card => !physical.includes(card));
  let burn = 0;
  const dealt = Array.from({ length: holes[0]!.length }, (_, round) => order.map(hole => hole[round]!)).flat();
  const burnCard = () => {
    const card = availableBurns[burn++];
    if (!card) throw new Error('The fixture requires more than 52 physical cards');
    dealt.push(card);
  };
  if (sharedLength >= 3) { burnCard(); dealt.push(...prefix.flatMap(board => board.slice(0, 3))); }
  if (sharedLength === 4) { burnCard(); dealt.push(...prefix.map(board => board[3]!)); }
  for (const run of runs) {
    let length: number = sharedLength;
    while (length < 5) {
      const next = length === 0 ? 3 : length + 1;
      burnCard();
      for (const board of run) dealt.push(...board.slice(length, next));
      length = next;
    }
  }
  return rig(dealt);
}

class Table {
  room: Room;
  transfers: ChipTransfer[];
  now = 1_800_000_100_000;

  constructor(
    stacks = [60, 60], game: GameVariant = 'holdem', maxRunouts: RunoutCount = 3,
    settings: Partial<RoomSettings> = {}, rules: Partial<HandRules> = {},
  ) {
    const initial = createRoom({
      id: 'runout-room', code: 'RUNOUT12', name: 'Independent runout rules',
      hostId: 'p0', hostName: 'Runout host', buyIn: stacks[0]!,
      settings: {
        ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20,
        minBuyIn: 1, maxBuyIn: 1_000_000, autoDeal: false, ...settings,
      },
    }, { now: this.now });
    this.room = initial.room;
    this.transfers = [...initial.transfers];
    for (let index = 1; index < stacks.length; index++) {
      this.send(`p${index}`, { type: 'join', name: `Runout ${index}` });
      this.send(`p${index}`, { type: 'fund', amount: stacks[index]! });
      this.send('p0', { type: 'approve', requestId: this.room.requests.at(-1)!.id, approve: true });
    }
    this.send('p0', { type: 'next_hand', rules: { ...defaultHandRules(this.room.settings), game, maxRunouts, ...rules } });
  }

  accept(result: Transition) {
    this.room = result.room; this.transfers.push(...result.transfers);
    expect(total(this.room.players.map(item => item.stack + item.cashOuts - item.buyIns)) + (this.room.hand?.pot ?? 0)).toBe(0);
    expect(total(this.room.players.map(item => item.bountyNet))).toBe(0);
    return result;
  }
  send(actor: string, command: Command, deck?: Card[]) {
    const before = structuredClone(this.room);
    const effect = transition(this.room, actor, command, { now: ++this.now, deck });
    expect(this.room).toEqual(before);
    return this.accept(effect);
  }
  deal(deck?: Card[]) { return this.send('p0', { type: 'deal' }, deck); }
  act(action: 'raise' | 'call' | 'fold' | 'check', amount?: number) {
    expect(this.room.hand?.actorId, 'Expected an outstanding betting action, not a vote').toBeTruthy();
    return this.send(this.room.hand!.actorId!, { type: 'act', action, amount });
  }
  passive() { return this.act(legalActions(this.room, this.room.hand!.actorId!).canCheck ? 'check' : 'call'); }
  shove() {
    const id = this.room.hand!.actorId!;
    const hp = this.room.hand!.players.find(item => item.id === id)!;
    const stack = this.room.players.find(item => item.id === id)!.stack;
    return this.act('raise', hp.streetBet + stack);
  }
  until(street: 'flop' | 'turn' | 'river') {
    for (let turn = 0; this.room.hand!.street !== street; turn++) {
      if (turn >= 60) throw new Error(`Check-down did not reach ${street}`);
      expect(this.room.hand!.street).not.toBe('complete');
      expect(this.room.hand!.runoutVote).toBeNull();
      this.passive();
    }
  }
  vote(id: string, count: RunoutCount) {
    return this.send(id, { type: 'runouts', handId: this.room.hand!.id, count });
  }
  agree(count: RunoutCount) {
    const vote = this.room.hand!.runoutVote;
    expect(vote, 'The fixture must actually reach runout consent').not.toBeNull();
    for (const id of vote!.eligible) {
      if (this.room.hand!.street === 'complete') break;
      if (!Object.hasOwn(this.room.hand!.runoutVote!.votes, id)) this.vote(id, count);
    }
    expect(this.room.hand!.street).toBe('complete');
  }
  timeout(now: number) {
    const before = structuredClone(this.room);
    const result = timeoutRunout(this.room, now);
    expect(this.room).toEqual(before);
    expect(result).not.toBeNull();
    this.now = now;
    return this.accept(result!);
  }
}

function reject(table: Table, id: string, command: Command, now = table.now + 1) {
  const original = structuredClone(table.room);
  expect(() => transition(table.room, id, command, { now })).toThrow();
  expect(table.room).toEqual(original);
}

function headsUp(game: 'holdem' | 'omaha' = 'holdem', max: RunoutCount = 3, street: 'preflop' | 'flop' | 'turn' = 'preflop') {
  const table = new Table([60, 60], game, max);
  table.deal([...PACK]);
  if (street !== 'preflop') table.until(street);
  table.shove(); table.act('call');
  return table;
}

function physicalCards(room: Room) {
  const hand = room.hand!;
  expect(hand.board).toEqual(hand.boards[0] ?? []);
  const prefix = hand.runoutPrefix ?? hand.boards.map(() => []);
  let dealtBoards: Card[];
  if (hand.runoutBoards.length) {
    expect(hand.runoutBoards).toHaveLength(hand.runoutCount);
    expect(hand.boards).toEqual(hand.runoutBoards[0]);
    dealtBoards = [
      ...prefix.flat(),
      ...hand.runoutBoards.flatMap(run => run.flatMap((board, index) => {
        expect(board.slice(0, prefix[index]!.length)).toEqual(prefix[index]);
        return board.slice(prefix[index]!.length);
      })),
    ];
  } else dealtBoards = hand.boards.flat();
  const physical = [...hand.deck, ...hand.burned, ...Object.values(hand.holeCards).flat(), ...dealtBoards];
  expect(physical).toHaveLength(52);
  expect(new Set(physical).size, 'Prefixes may be shared; no physical tail, hole, or burn may be reused').toBe(52);
  expect([...physical].sort()).toEqual([...PACK].sort());
}

function expectedRunouts(prefix: Card[][], remaining: Card[], count: number) {
  let index = 0;
  const burns: Card[] = [];
  const runs = Array.from({ length: count }, () => {
    const boards = prefix.map(board => [...board]);
    while (boards[0]!.length < 5) {
      burns.push(remaining[index++]!);
      const take = boards[0]!.length === 0 ? 3 : 1;
      for (const board of boards) for (let card = 0; card < take; card++) board.push(remaining[index++]!);
    }
    return boards;
  });
  expect(index).toBeLessThanOrEqual(remaining.length);
  return { runs, burns, remaining: remaining.slice(index) };
}

function accounting(table: Table) {
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
    } else if (entry.from !== 'bank') expect(balances.get(entry.from)).toBeGreaterThanOrEqual(0);
  }
  for (const player of table.room.players) {
    expect(balances.get(`player:${player.id}`) ?? 0).toBe(player.stack);
    expect(balances.get(`bounty:${player.id}`) ?? 0).toBe(player.bountyNet);
  }
  for (const [account, balance] of balances) if (account.startsWith('pot:')) expect(balance).toBe(0);
  expect(balances.get('bank')).toBe(total(table.room.players.map(player => player.cashOuts - player.buyIns)));
  expect(total([...balances.values()])).toBe(0);
  expect(total(table.room.players.map(player => player.bountyNet))).toBe(0);
  const hand = table.room.hand!;
  expect(total(hand.results.map(result => result.amount))).toBe(hand.awardedPot);
  for (const result of hand.results) {
    expect(total(Object.values(result.shares))).toBe(result.amount);
    for (const id of Object.keys(result.shares)) {
      expect(result.eligible).toContain(id);
      expect(result.winners).toContain(id);
    }
  }
}

describe('runout consent cannot bypass any remaining betting', () => {
  test.each(['holdem', 'omaha'] as const)('%s: no vote while the all-in wager still needs a call', game => {
    const table = new Table([60, 60], game);
    table.deal([...PACK]); table.shove();
    expect(table.room.hand).toMatchObject({ actorId: 'p1', runoutVote: null, board: [] });
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 3 });
    table.act('call');
    expect(table.room.hand!.runoutVote).toMatchObject({ eligible: ['p0', 'p1'], votes: {}, maxRuns: 3 });
    expect(table.room.hand!.actorId).toBeNull();
    expect(table.room.hand!.deadline).toBeNull();
    expect(table.room.hand!.runoutVote!.deadline).toBe(table.now + 20_000);
    expect(table.room.hand!.board).toEqual([]);
    physicalCards(table.room);
  });

  test.each(['holdem', 'omaha'] as const)('%s: two deeper players must finish side-pot betting first', game => {
    const ante = game === 'omaha' ? 20 : 0;
    const table = new Table([20 + ante, 200 + ante, 200 + ante], game);
    table.deal([...PACK]);
    table.act('call'); table.act('call'); table.act('check');
    expect(table.room.hand).toMatchObject({ street: 'flop', actorId: 'p1', pot: 60 + ante * 3, runoutVote: null });
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 2 });
    table.act('raise', 60);
    expect(table.room.hand!.runoutVote).toBeNull();
    table.act('raise', 180);
    expect(table.room.hand).toMatchObject({ actorId: 'p1', runoutVote: null });
    table.act('call');
    expect(table.room.hand!.runoutVote).toMatchObject({ eligible: ['p0', 'p1', 'p2'], maxRuns: 3 });
    expect(table.room.hand!.pot).toBe(420 + ante * 3);
    table.agree(3);
    expect(table.room.hand!.results.filter(result => result.potIndex === 0).map(result => result.amount)).toEqual([20 + ante, 20 + ante, 20 + ante]);
    expect(table.room.hand!.results.filter(result => result.potIndex === 1).map(result => result.amount)).toEqual([120, 120, 120]);
    physicalCards(table.room); accounting(table);
  });

  test('normal checked-down streets never offer extra boards', () => {
    const table = new Table();
    table.deal([...PACK]);
    for (let turn = 0; table.room.hand!.street !== 'complete'; turn++) {
      if (turn >= 20) throw new Error('Normal heads-up check-down failed');
      expect(table.room.hand!.runoutVote).toBeNull();
      table.passive();
    }
    expect(table.room.hand!.runoutCount).toBe(1);
    expect(table.room.hand!.board).toHaveLength(5);
    expect(table.room.hand!.burned).toHaveLength(3);
  });

  test('one remaining nonfolded player never needs consent or any more community cards', () => {
    const table = new Table();
    table.deal([...PACK]); table.shove();
    const remaining = [...table.room.hand!.deck];
    table.act('fold');
    expect(table.room.hand).toMatchObject({ street: 'complete', board: [], runoutVote: null, runoutCount: 1 });
    expect(table.room.hand!.deck).toEqual(remaining);
    expect(table.room.hand!.burned).toEqual([]);
    expect(table.room.hand!.awardedPot).toBe(40);
    accounting(table);
  });

  test('all-in on the river settles immediately, even when the frozen maximum is three', () => {
    const table = new Table();
    table.deal([...PACK]); table.until('river');
    const board = [...table.room.hand!.board];
    const deck = [...table.room.hand!.deck];
    table.shove(); table.act('call');
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 1, board, deck });
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 2 });
    physicalCards(table.room); accounting(table);
  });

  test('maxRunouts=1 preserves immediate legacy all-in behavior', () => {
    const table = headsUp('holdem', 1);
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 1, awardedPot: 120 });
    expect(table.room.hand!.burned).toHaveLength(3);
    expect(table.room.hand!.board).toHaveLength(5);
    physicalCards(table.room); accounting(table);
  });

  test('two-card Indian offers ordinary Holdem runouts after all-in betting finishes', () => {
    const table = new Table([60, 60], 'indian', 3, {}, { indianAnte: 5 });
    table.deal([...PACK]); table.shove(); table.act('call');
    expect(table.room.hand!.runoutVote).toMatchObject({ eligible: ['p0', 'p1'], maxRuns: 3 });
    expect(table.room.hand!.deck).toHaveLength(48);
    table.agree(3);
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 3 });
    expect(table.room.hand!.runoutBoards.every(run => run[0]!.length === 5)).toBe(true);
    expect(table.room.hand!.burned).toHaveLength(9);
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 2 });
    physicalCards(table.room); accounting(table);
  });
});

describe('up-to votes, eligibility, deadlines, pause, and restored consent', () => {
  test('two and three are compatible: wait for every eligible vote, then choose two', () => {
    const table = headsUp();
    const before = structuredClone(table.room.hand);
    table.vote('p0', 2);
    expect(table.room.hand!.runoutVote?.votes).toEqual({ p0: 2 });
    expect(table.room.hand!.street).toBe('preflop');
    expect(table.room.hand!.deck).toEqual(before!.deck);
    expect(table.room.hand!.pot).toBe(120);
    expect(table.room.hand!.runoutVote!.deadline).toBe(before!.runoutVote!.deadline);
    table.vote('p1', 3);
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutCount: 2, runoutVote: null });
    physicalCards(table.room); accounting(table);
  });

  test('a choice of one can resolve immediately without waiting for the other voter', () => {
    const table = headsUp();
    table.vote('p1', 1);
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 3 });
    physicalCards(table.room); accounting(table);
  });

  test('rejects duplicate, stale, malformed, folded, observer, and wrong-phase votes without mutation', () => {
    const table = new Table([60, 60, 60, 60]);
    table.send('observer', { type: 'join', name: 'Observer' });
    reject(table, 'p0', { type: 'runouts', handId: randomUUID(), count: 2 });
    table.deal([...PACK]);
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 2 });
    table.act('fold'); table.shove(); table.act('call'); table.act('call');
    expect(table.room.hand!.runoutVote!.eligible).toEqual(['p0', 'p1', 'p2']);
    const id = table.room.hand!.id;
    reject(table, 'p3', { type: 'runouts', handId: id, count: 2 });
    reject(table, 'observer', { type: 'runouts', handId: id, count: 2 });
    reject(table, 'not-a-member', { type: 'runouts', handId: id, count: 2 });
    reject(table, 'p0', { type: 'runouts', handId: randomUUID(), count: 2 });
    for (const invalid of [0, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const command = { type: 'runouts' as const, handId: id, count: invalid as RunoutCount };
      expect(commandSchema.safeParse(command).success).toBe(false);
      reject(table, 'p0', command);
    }
    table.vote('p0', 3);
    reject(table, 'p0', { type: 'runouts', handId: id, count: 3 });
    reject(table, 'p0', { type: 'runouts', handId: id, count: 2 });
    reject(table, 'p1', { type: 'act', action: 'call' });
    reject(table, 'p0', { type: 'deal' });
    table.vote('p1', 3); table.vote('p2', 2);
    expect(table.room.hand!.runoutCount).toBe(2);
    reject(table, 'p1', { type: 'runouts', handId: id, count: 3 });
    accounting(table);
  });

  test('a previous handId cannot vote in a later hand', () => {
    const table = new Table();
    table.deal([...PACK]);
    const oldId = table.room.hand!.id;
    table.act('fold');
    table.deal([...PACK]);
    table.shove(); table.act('call');
    expect(table.room.hand!.runoutVote).not.toBeNull();
    reject(table, 'p0', { type: 'runouts', handId: oldId, count: 1 });
    table.agree(2);
  });

  test('missing consent defaults to one exactly at 20 seconds, not just after it', () => {
    const table = headsUp();
    const deadline = table.room.hand!.runoutVote!.deadline!;
    expect(deadline).toBe(table.now + 20_000);
    table.vote('p0', 3);
    expect(timeoutRunout(table.room, deadline - 1)).toBeNull();
    expect(timeoutTurn(table.room, deadline)).toBeNull();
    reject(table, 'p1', { type: 'runouts', handId: table.room.hand!.id, count: 3 }, deadline);
    table.timeout(deadline);
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutCount: 1, runoutVote: null });
    expect(timeoutRunout(table.room, deadline + 1)).toBeNull();
    physicalCards(table.room); accounting(table);
  });

  test('a final valid vote one millisecond before expiry still selects three', () => {
    const table = headsUp();
    table.vote('p0', 3);
    const deadline = table.room.hand!.runoutVote!.deadline!;
    table.now = deadline - 2;
    table.vote('p1', 3);
    expect(table.room.hand!.completedAt).toBe(deadline - 1);
    expect(table.room.hand!.runoutCount).toBe(3);
    physicalCards(table.room); accounting(table);
  });

  test('pause freezes consent; resume gives a fresh 20 seconds and retains prior votes', () => {
    const table = headsUp();
    table.vote('p0', 3);
    const original = structuredClone(table.room.hand);
    const stacks = table.room.players.map(player => player.stack);
    table.send('p0', { type: 'pause', value: true });
    expect(table.room.hand!.runoutVote!.deadline).toBeNull();
    expect(table.room.hand!.runoutVote!.votes).toEqual({ p0: 3 });
    table.now = original!.runoutVote!.deadline! + 100_000;
    expect(timeoutRunout(table.room, table.now)).toBeNull();
    reject(table, 'p1', { type: 'runouts', handId: table.room.hand!.id, count: 2 });
    expect(table.room.hand!.deck).toEqual(original!.deck);
    expect(table.room.hand!.pot).toBe(original!.pot);
    expect(table.room.players.map(player => player.stack)).toEqual(stacks);
    table.send('p0', {
      type: 'settings', smallBlind: 10, bigBlind: 20, ante: 0, autoDeal: false,
      turnSeconds: 90, allowRebuys: true,
    });
    table.send('p0', { type: 'pause', value: false });
    expect(table.room.hand!.runoutVote).toMatchObject({ votes: { p0: 3 }, deadline: table.now + 20_000 });
    table.vote('p1', 2);
    expect(table.room.hand!.runoutCount).toBe(2);
    physicalCards(table.room); accounting(table);
  });

  test('JSON restoration and schema normalization preserve a partially voted current-format hand', () => {
    const table = headsUp('omaha', 3, 'flop');
    table.vote('p0', 3);
    const saved = structuredClone(table.room);
    table.room = normalizeRoom(JSON.parse(JSON.stringify(table.room)) as Room);
    expect(table.room).toEqual(saved);
    table.vote('p1', 2);
    expect(table.room.hand!.runoutCount).toBe(2);
    expect(table.room.hand!.runoutPrefix).toEqual(saved.hand!.boards);
    physicalCards(table.room); accounting(table);
  });

  test('future rule changes during consent cannot lower the frozen current hand maximum', () => {
    const table = headsUp();
    const offer = structuredClone(table.room.hand!.runoutVote);
    table.send('p0', { type: 'next_hand', rules: { ...defaultHandRules(), game: 'indian', maxRunouts: 1 } });
    expect(table.room.hand!.runoutVote).toEqual(offer);
    expect(table.room.hand!.rules).toMatchObject({ game: 'holdem', maxRunouts: 3 });
    table.agree(3);
    expect(table.room.hand!.runoutCount).toBe(3);
    expect(table.room.nextHandRules).toMatchObject({ game: 'indian', maxRunouts: 1 });
  });

  test('a frozen two-run limit cannot be raised to three by changing the next hand', () => {
    const table = headsUp('holdem', 2);
    expect(table.room.hand!.runoutVote!.maxRuns).toBe(2);
    table.send('p0', { type: 'next_hand', rules: { ...defaultHandRules(), maxRunouts: 3 } });
    expect(table.room.hand!.rules.maxRunouts).toBe(2);
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 3 });
    table.agree(2);
    expect(table.room.hand!.runoutCount).toBe(2);
    accounting(table);
  });

  test('bots automatically accept the offered maximum but cannot override a human lower choice', () => {
    const table = new Table([60]);
    table.send('p0', { type: 'add_bot', name: 'Consenting bot' });
    const botId = table.room.players.find(player => player.bot)!.id;
    table.deal([...PACK]); table.shove(); table.act('call');
    expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: 3, votes: { [botId]: 3 } });
    expect(table.room.hand!.runoutVote!.eligible).toEqual(['p0', botId]);
    table.vote('p0', 2);
    expect(table.room.hand!.runoutCount).toBe(2);
    accounting(table);
  });

  test('a hand containing only practice bots does not stall waiting for human consent', () => {
    const table = new Table([60], 'holdem', 3, { maxBuyIn: 60 });
    table.send('p0', { type: 'sit_out', value: true });
    table.send('p0', { type: 'add_bot', name: 'Bot one' });
    table.send('p0', { type: 'add_bot', name: 'Bot two' });
    table.deal([...PACK]); table.shove(); table.act('call');
    expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 3 });
    expect(table.room.hand!.burned).toHaveLength(9);
    physicalCards(table.room); accounting(table);
  });
});

describe('one real deck: exact prefixes, independent tails and burn capacity', () => {
  test.each([
    ['holdem', 'preflop', 2], ['holdem', 'preflop', 3], ['holdem', 'flop', 2],
    ['holdem', 'flop', 3], ['holdem', 'turn', 2], ['holdem', 'turn', 3],
    ['omaha', 'preflop', 2], ['omaha', 'preflop', 3], ['omaha', 'flop', 2],
    ['omaha', 'flop', 3], ['omaha', 'turn', 2], ['omaha', 'turn', 3],
  ] as const)('%s from %s, %i runs: exact sequential burns and tails', (game, street, count) => {
    const table = headsUp(game, 3, street);
    const before = structuredClone(table.room.hand)!;
    const expected = expectedRunouts(before.boards, before.deck, count);
    table.agree(count);
    const hand = table.room.hand!;
    expect(hand.runoutPrefix).toEqual(before.boards);
    expect(hand.runoutBoards).toEqual(expected.runs);
    expect(hand.boards).toEqual(expected.runs[0]);
    expect(hand.board).toEqual(expected.runs[0]![0]);
    expect(hand.burned).toEqual([...before.burned, ...expected.burns]);
    expect(hand.deck).toEqual(expected.remaining);
    expect(hand.results.map(result => result.amount)).toEqual(Array(count).fill(120 / count));
    physicalCards(table.room); accounting(table);
  });

  test('nine-handed preflop Omaha fits exactly two runouts, never three', () => {
    const table = new Table(Array(9).fill(20), 'omaha');
    table.deal([...PACK]);
    for (let actions = 0; !table.room.hand!.runoutVote; actions++) {
      if (actions >= 9) throw new Error('Nine-way all-in did not offer a vote');
      table.passive();
    }
    expect(table.room.hand!.deck).toHaveLength(16);
    expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: 2 });
    reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 3 });
    table.agree(2);
    expect(table.room.hand!.deck).toEqual([]);
    expect(table.room.hand!.burned).toHaveLength(6);
    expect(table.room.hand!.runoutBoards.flat(2)).toHaveLength(10);
    expect(Object.values(table.room.hand!.holeCards).flat()).toHaveLength(36);
    physicalCards(table.room); accounting(table);
  });

  test('folded Omaha cards are not reclaimed to manufacture a third runout', () => {
    const table = new Table(Array(9).fill(40), 'omaha');
    table.deal([...PACK]);
    for (let seat = 3; seat <= 8; seat++) {
      expect(table.room.hand!.actorId).toBe(`p${seat}`);
      table.act('fold');
    }
    table.act('call'); table.act('fold');
    expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: 2, eligible: ['p0', 'p2'] });
    expect(table.room.hand!.deck).toHaveLength(16);
    table.agree(2);
    physicalCards(table.room); accounting(table);
  });

  test.each([
    [9, 'flop', 1, 3], [8, 'flop', 2, 1], [7, 'flop', 2, 5], [6, 'flop', 3, 3],
    [9, 'turn', 2, 0], [8, 'turn', 3, 1],
  ] as const)('double-board bomb: %i seats from %s allow %i runs and leave %i cards', (seats, street, count, remaining) => {
    const table = new Table(Array(seats).fill(10), 'omaha_bomb', 3, {}, { bombAnte: 5 });
    table.deal([...PACK]);
    if (street === 'turn') table.until('turn');
    const prefix = structuredClone(table.room.hand!.boards);
    const oldBurns = [...table.room.hand!.burned];
    const expected = expectedRunouts(prefix, table.room.hand!.deck, count);
    table.shove();
    for (let action = 0; table.room.hand!.actorId; action++) {
      if (action >= seats) throw new Error('Bomb-pot calls did not complete');
      expect(table.room.hand!.runoutVote).toBeNull();
      table.act('call');
    }
    if (count === 1) {
      expect(table.room.hand).toMatchObject({ street: 'complete', runoutVote: null, runoutCount: 1 });
    } else {
      expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: count });
      if (count === 2) reject(table, 'p0', { type: 'runouts', handId: table.room.hand!.id, count: 3 });
      table.agree(count);
    }
    expect(table.room.hand!.runoutBoards).toEqual(expected.runs);
    expect(table.room.hand!.burned).toEqual([...oldBurns, ...expected.burns]);
    expect(table.room.hand!.deck).toEqual(expected.remaining);
    expect(table.room.hand!.deck).toHaveLength(remaining);
    physicalCards(table.room); accounting(table);
  });
});

describe('indexed side pots, board-first splits, odd chips, and bounty eligibility across runs', () => {
  test('three Holdem runs split each main/side pot independently, including the two side-pot odd chips', () => {
    const holes = [cards('As Ad'), cards('Ks Kh'), cards('Qs Qh')];
    const runs = [
      [cards('2c 3d 7h 9c Ts')], [cards('Kc 4d 5h 8c Js')], [cards('Qc 6d 7s 9h Td')],
    ];
    const table = new Table([100, 200, 300], 'holdem', 3, { smallBlind: 5, bigBlind: 10 });
    table.deal(runDeck(holes, runs));
    table.act('raise', 100); table.act('raise', 200); table.act('call');
    expect(table.room.hand!.pot).toBe(500);
    table.agree(3);
    expect(table.room.hand!.runoutBoards).toEqual(runs);
    expect(table.room.hand!.results.map(result => [
      result.potIndex, result.boardIndex, result.runoutIndex, result.amount, result.shares,
    ])).toEqual([
      [0, 0, 0, 100, { p0: 100 }], [0, 0, 1, 100, { p1: 100 }], [0, 0, 2, 100, { p2: 100 }],
      [1, 0, 0, 67, { p1: 67 }], [1, 0, 1, 67, { p1: 67 }], [1, 0, 2, 66, { p2: 66 }],
    ]);
    expect(table.room.hand!.results.filter(result => result.potIndex === 1).map(result => [...result.eligible].sort()))
      .toEqual(Array.from({ length: 3 }, () => ['p1', 'p2']));
    expect(table.room.players.map(player => player.stack)).toEqual([100, 234, 266]);
    physicalCards(table.room); accounting(table);
  });

  test('an unmatched overbet is refunded before all three pot divisions, never tripled', () => {
    const table = new Table([300, 200, 100], 'holdem', 3, { smallBlind: 5, bigBlind: 10 });
    table.deal(runDeck(
      [cards('As Ad'), cards('Ks Kh'), cards('Qs Qh')],
      [[cards('2c 3d 7h 9c Ts')], [cards('Kc 4d 5h 8c Js')], [cards('Qc 6d 7s 9h Td')]],
    ));
    table.shove(); table.act('call'); table.act('call'); table.agree(3);
    expect(table.transfers.filter(entry => entry.kind === 'refund').map(entry => [entry.playerId, entry.chips])).toEqual([['p0', 100]]);
    expect(table.room.hand!.awardedPot).toBe(500);
    expect(table.room.players.map(player => player.stack)).toEqual([333, 167, 100]);
    physicalCards(table.room); accounting(table);
  });

  test('21-chip double bomb: split boards 11/10, then runs 4/4/3 and 4/3/3, then tied seats', () => {
    const holes = [cards('As Kd 2c 3c'), cards('Ah Kc 4c 5c'), cards('8c 8d 6d 7d')];
    const runs = [
      [cards('Qs Jh Td 9c 2h'), cards('Qd Js Tc 9d 3h')],
      [cards('Qs Jh Td 9h 2s'), cards('Qd Js Tc 9s 3s')],
      [cards('Qs Jh Td 6c 4h'), cards('Qd Js Tc 6h 5h')],
    ];
    const table = new Table([7, 7, 7], 'omaha_bomb', 3, { smallBlind: 1, bigBlind: 2 }, { bombAnte: 7 });
    table.deal(runDeck(holes, runs, 3));
    expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: 3 });
    table.agree(3);
    expect(table.room.hand!.runoutBoards).toEqual(runs);
    expect(table.room.hand!.results.map(result => [
      result.potIndex, result.boardIndex, result.runoutIndex, result.amount, result.shares,
    ])).toEqual([
      [0, 0, 0, 4, { p1: 2, p0: 2 }], [0, 0, 1, 4, { p1: 2, p0: 2 }], [0, 0, 2, 3, { p1: 2, p0: 1 }],
      [0, 1, 0, 4, { p1: 2, p0: 2 }], [0, 1, 1, 3, { p1: 2, p0: 1 }], [0, 1, 2, 3, { p1: 2, p0: 1 }],
    ]);
    expect(table.room.players.map(player => player.stack)).toEqual([9, 12, 0]);
    expect(table.room.hand!.deck).toHaveLength(15);
    physicalCards(table.room); accounting(table);
  });

  test.each([false, true])('72 offsuit across two runs: sweep=%s awards exactly one bounty or none', sweep => {
    const second = sweep ? '7d 2s 2h 5c 6d' : 'Ac Kd Qc Jh 9s';
    const table = new Table([60, 60], 'holdem', 2, { chipValueCents: 4 }, { sevenDeuceBounty: 33 });
    table.deal(runDeck([cards('7c 2d'), cards('As Ad')], [
      [cards('7s 7h 2c Qh 9d')], [cards(second)],
    ]));
    table.shove(); table.act('call'); table.agree(2);
    expect(table.room.hand!.results.map(result => result.shares))
      .toEqual(sweep ? [{ p0: 60 }, { p0: 60 }] : [{ p0: 60 }, { p1: 60 }]);
    expect(table.room.players.map(player => player.stack)).toEqual(sweep ? [120, 0] : [60, 60]);
    expect(table.room.players.map(player => player.buyIns)).toEqual([60, 60]);
    expect(table.room.players.map(player => player.bountyNet)).toEqual(sweep ? [33, -33] : [0, 0]);
    expect(table.transfers.filter(entry => entry.kind === 'bounty').map(entry => [
      entry.from, entry.to, entry.chips, entry.cashCents,
    ])).toEqual(sweep ? [['bounty:p1', 'bounty:p0', 33, 132]] : []);
    expect(table.room.hand!.bounty).toEqual(sweep
      ? { winnerId: 'p0', payerIds: ['p1'], amount: 33, totalAmount: 33 } : null);
    physicalCards(table.room); accounting(table);
  });

  test('scooping every main and side pot on all three runs earns one bounty per dealt opponent, not per result', () => {
    const table = new Table([300, 200, 100], 'holdem', 3, { smallBlind: 5, bigBlind: 10, chipValueCents: 2 }, { sevenDeuceBounty: 41 });
    table.deal(runDeck([cards('7c 2d'), cards('As Ad'), cards('Ks Kh')], [
      [cards('7s 7h 2c Qh 9d')], [cards('7d 2s 2h 5c 6d')], [cards('Ac 3c 4d 5d 9c')],
    ]));
    table.shove(); table.act('call'); table.act('call'); table.agree(3);
    expect(table.room.hand!.results.map(result => [result.potIndex, result.runoutIndex, result.shares])).toEqual([
      [0, 0, { p0: 100 }], [0, 1, { p0: 100 }], [0, 2, { p0: 100 }],
      [1, 0, { p0: 67 }], [1, 1, { p0: 67 }], [1, 2, { p0: 66 }],
    ]);
    expect(table.room.players.map(player => player.stack)).toEqual([600, 0, 0]);
    expect(table.room.players.map(player => player.buyIns)).toEqual([300, 200, 100]);
    expect(table.room.players.map(player => player.bountyNet)).toEqual([82, -41, -41]);
    expect(table.room.hand!.bounty).toEqual({ winnerId: 'p0', payerIds: ['p1', 'p2'], amount: 41, totalAmount: 82 });
    expect(table.transfers.filter(entry => entry.kind === 'bounty').map(entry => [
      entry.playerId, entry.from, entry.to, entry.chips, entry.cashCents,
    ])).toEqual([['p1', 'bounty:p1', 'bounty:p0', 41, 82], ['p2', 'bounty:p2', 'bounty:p0', 41, 82]]);
    physicalCards(table.room); accounting(table);
  });
});

function shuffled(seed: number) {
  let state = seed;
  const deck = [...PACK];
  for (let index = 51; index > 0; index--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const other = (state >>> 0) % (index + 1);
    [deck[index], deck[other]] = [deck[other]!, deck[index]!];
  }
  return deck;
}

describe('72 bounded all-in sweeps over every board game and one/two/three runs', () => {
  test.each([
    ['holdem', 1], ['holdem', 2], ['holdem', 3],
    ['omaha', 1], ['omaha', 2], ['omaha', 3],
    ['omaha_bomb', 1], ['omaha_bomb', 2], ['omaha_bomb', 3],
  ] as const)('%s, %i runs: eight reproducible 2–6 seat full-hand deals', (game, count) => {
    for (let seed = 1; seed <= 8; seed++) {
      const seats = 2 + seed % 5;
      const table = new Table(Array(seats).fill(20), game, count, {}, { bombAnte: 20, sevenDeuceBounty: 7 });
      table.deal(shuffled(7907 * seed));
      for (let actions = 0; table.room.hand!.actorId; actions++) {
        if (actions >= seats) throw new Error(`${game}, seed ${seed}: all-in calls stalled`);
        physicalCards(table.room);
        table.passive();
      }
      if (count > 1) {
        expect(table.room.hand!.runoutVote).toMatchObject({ maxRuns: count });
        const voters = [...table.room.hand!.runoutVote!.eligible];
        if (seed % 2) voters.reverse();
        for (const id of voters) table.vote(id, count);
      } else expect(table.room.hand!.runoutVote).toBeNull();
      expect(table.room.hand).toMatchObject({ street: 'complete', runoutCount: count, awardedPot: 20 * seats, pot: 0 });
      const boards = game === 'omaha_bomb' ? 2 : 1;
      expect(table.room.hand!.runoutBoards).toHaveLength(count);
      for (const run of table.room.hand!.runoutBoards) {
        expect(run).toHaveLength(boards);
        for (const board of run) expect(board).toHaveLength(5);
      }
      expect(table.room.hand!.burned).toHaveLength(game === 'omaha_bomb' ? 1 + 2 * count : 3 * count);
      expect(total(table.room.players.map(player => player.stack))).toBe(20 * seats);
      physicalCards(table.room); accounting(table);
    }
  });
});
