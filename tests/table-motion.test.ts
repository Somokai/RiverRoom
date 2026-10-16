import { describe, expect, test } from 'vitest';
import {
  boardCardKey, CARD_FLIGHT_MS, CARD_REVEAL_MS, CHIP_FLIGHT_MS, collectedPot, holeCardKey, planTableMotion, streetWagers,
} from '../src/client/tableMotion';
import {
  DEFAULT_SETTINGS, type Command, type HandRules, type Room, type RoomSettings, type RoomView,
} from '../src/shared/model';
import { makeDeck } from '../src/server/cards';
import { assertRoom, createRoom, legalActions, roomView, transition } from '../src/server/engine';
import { verifyTransfers } from '../src/server/store';
import { evaluate } from '../src/shared/handEvaluation';
import { currentHands, describeHand, orderedHandCards, winningHands } from '../src/client/handPresentation';

let now = 1_800_000_000_000;
const empty = { chips: [], cards: [] };

function apply(room: Room, actor: string, command: Command, deck?: string[]) {
  const result = transition(room, actor, command, { now: ++now, deck });
  assertRoom(result.room);
  verifyTransfers(room, result.room, result.transfers);
  return result.room;
}

function table(stacks = [1000, 1000], rules: Partial<HandRules> = {}, settings: Partial<RoomSettings> = {}) {
  const initial = createRoom({
    id: 'motion-room', code: 'MOTION12', name: 'Motion test table',
    hostId: 'p0', hostName: 'Player 0', buyIn: stacks[0]!,
    settings: {
      ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20,
      minBuyIn: 1, maxBuyIn: 1_000_000, autoDeal: false, ...settings,
    },
  }, { now: ++now });
  verifyTransfers(null, initial.room, initial.transfers);
  let room = initial.room;
  for (let index = 1; index < stacks.length; index++) {
    room = apply(room, `p${index}`, { type: 'join', name: `Player ${index}` });
    room = apply(room, `p${index}`, { type: 'fund', amount: stacks[index]! });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return apply(room, 'p0', { type: 'next_hand', rules: { ...room.nextHandRules, ...rules } });
}

function start(room: Room, deck = makeDeck()) { return apply(room, 'p0', { type: 'deal' }, deck); }
function act(room: Room, action: 'fold' | 'check' | 'call' | 'raise', amount?: number) {
  return apply(room, room.hand!.actorId!, { type: 'act', action, amount });
}
function view(room: Room, viewer = 'p0') { return roomView(room, viewer, new Set(), now); }
function motion(before: Room, after: Room, viewer = 'p0') { return planTableMotion(view(before, viewer), view(after, viewer)); }
function vote(room: Room, playerId: string) {
  return apply(room, playerId, { type: 'runouts', handId: room.hand!.id, count: 3 });
}
function untilRiver(initial: Room) {
  let room = initial;
  for (let turns = 0; room.hand?.street !== 'river'; turns++) {
    if (turns >= 30 || room.hand?.street === 'complete') throw new Error('Fixture did not reach the river.');
    room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  return room;
}
function rig(cards: string[]) {
  expect(new Set(cards).size).toBe(cards.length);
  return [...cards, ...makeDeck().filter(card => !cards.includes(card))];
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('motion snapshot baselines', () => {
  test('voluntary partial reveals flip only the selected card, without replaying payouts or revealing its neighbor', () => {
    const completed = act(start(table()), 'fold');
    const shown = apply(completed, 'p0', { type: 'reveal', handId: completed.hand!.id, cardIndexes: [1] });
    expect(motion(completed, shown, 'p1')).toEqual({
      chips: [], cards: [{ kind: 'reveal', key: holeCardKey('p0', 1), delay: 0 }],
    });
    expect(motion(completed, shown, 'p0')).toEqual(empty);
  });
  test('initial/reconnect, repeated, skipped, out-of-order, room and viewer changes do not animate', () => {
    const ready = table();
    const dealt = start(ready);
    const before = view(ready);
    const after = view(dealt);
    expect(planTableMotion(before, after).cards).toHaveLength(4);

    const cases: Array<[string, RoomView | null, RoomView]> = [
      ['initial or reconnect', null, after],
      ['same snapshot', after, structuredClone(after)],
      ['same version with different contents', before, { ...after, version: before.version }],
      ['version gap', before, { ...after, version: before.version + 2 }],
      ['out of order', before, { ...after, version: before.version - 1 }],
      ['another room', before, { ...after, id: 'another-room' }],
      ['another viewer', before, view(dealt, 'p1')],
      ['presence-only refresh', after, roomView(dealt, 'p0', new Set(['p0', 'p1']), now + 1000)],
    ];
    for (const [label, previous, next] of cases)
      expect(planTableMotion(previous, next), label).toEqual(empty);
  });

  test('a fresh hand must advance the hand number exactly once', () => {
    const ready = table();
    const before = view(ready);
    const after = view(start(ready));
    for (const number of [before.handNumber, before.handNumber + 2]) {
      const next: RoomView = { ...after, handNumber: number, hand: { ...after.hand!, number } };
      expect(planTableMotion(before, next)).toEqual(empty);
    }
  });

  test('no-hand updates and completed-hand refreshes never replay motion', () => {
    const lobby = table();
    expect(motion(lobby, apply(lobby, 'p0', { type: 'chat', message: 'Ready?' }))).toEqual(empty);
    const dealt = start(lobby);
    const complete = act(dealt, 'fold');
    expect(motion(dealt, complete).chips.some(chip => chip.kind === 'payout')).toBe(true);
    expect(planTableMotion(view(complete), view(complete))).toEqual(empty);
    expect(planTableMotion(null, view(complete))).toEqual(empty);
    expect(motion(complete, apply(complete, 'p1', { type: 'chat', message: 'Next hand' }))).toEqual(empty);
  });
});

describe('dealt cards and forced contributions', () => {
  test('motion timings and slot keys are stable and do not include card faces', () => {
    expect([CHIP_FLIGHT_MS, CARD_FLIGHT_MS, CARD_REVEAL_MS]).toEqual([560, 420, 240]);
    expect(holeCardKey('p1', 3)).toBe('hole:p1:3');
    expect(boardCardKey(2, 1, 4)).toBe('board:2:1:4');
  });

  test('Holdem deals two rounds left of the dealer, including hidden opponents', () => {
    const ready = table([1000, 1000, 1000]);
    const dealt = start(ready, rig('Ks Qs As Kd Qd Ad'.split(' ')));
    const after = view(dealt);
    expect(after.players.map(player => player.cards)).toEqual([['As', 'Ad'], [null, null], [null, null]]);
    const plan = planTableMotion(view(ready), after);
    expect(plan.chips).toMatchObject([
      { kind: 'bet', playerId: 'p1', amount: 10, delay: 0 },
      { kind: 'bet', playerId: 'p2', amount: 20, delay: 0 },
    ]);
    expect(plan.cards).toEqual(
      [0, 1].flatMap(index => ['p1', 'p2', 'p0'].map(player => holeCardKey(player, index)))
        .map((key, index) => ({ kind: 'deal', key, delay: 100 + index * 85 })),
    );
  });

  test('the next hand resets commitments and rotates around empty or sitting-out seats', () => {
    const ready = apply(table([1000, 1000, 1000, 1000]), 'p1', { type: 'sit_out', value: true });
    const first = start(ready);
    const complete = act(act(first, 'fold'), 'fold');
    const second = start(complete);
    expect(second.hand).toMatchObject({ number: 2, buttonSeat: 2 });
    const plan = motion(complete, second);
    expect(plan.cards.map(card => card.key)).toEqual(
      [0, 1].flatMap(index => ['p3', 'p0', 'p2'].map(id => holeCardKey(id, index))),
    );
    expect(plan.chips).toMatchObject([
      { kind: 'bet', playerId: 'p0', amount: 20, delay: 0 },
      { kind: 'bet', playerId: 'p3', amount: 10, delay: 0 },
    ]);
    expect(view(second).players.find(player => player.id === 'p1')?.cards).toEqual([]);
  });

  test.each([2, 9])('Omaha deals four rounds at %i seats with a bounded stagger', seats => {
    const ready = table(Array.from({ length: seats }, () => 1000), { game: 'omaha', omahaAnte: 20 });
    const dealt = start(ready);
    const plan = motion(ready, dealt);
    const order = [...Array.from({ length: seats - 1 }, (_, index) => `p${index + 1}`), 'p0'];
    expect(plan.cards.map(card => card.key)).toEqual(
      [0, 1, 2, 3].flatMap(index => order.map(id => holeCardKey(id, index))),
    );
    expect(plan.cards.every(card => card.kind === 'deal')).toBe(true);
    expect(new Set(plan.cards.map(card => card.key)).size).toBe(seats * 4);
    expect(plan.chips.filter(chip => chip.kind === 'ante')).toEqual(Array.from({ length: seats }, (_, index) => ({
      kind: 'ante', playerId: `p${index}`, amount: 20, from: 'stack', to: 'pot', delay: 0,
    })));
    expect(plan.chips.filter(chip => chip.kind === 'bet')).toEqual([
      { kind: 'bet', playerId: `p${seats === 2 ? 0 : 1}`, amount: 10, from: 'stack', to: 'wager', delay: 0 },
      { kind: 'bet', playerId: `p${seats === 2 ? 1 : 2}`, amount: 20, from: 'stack', to: 'wager', delay: 0 },
    ]);
    for (let index = 1; index < plan.cards.length; index++)
      expect(plan.cards[index]!.delay).toBeGreaterThan(plan.cards[index - 1]!.delay);
    expect(plan.cards.at(-1)!.delay - plan.cards[0]!.delay).toBeLessThanOrEqual(1000);
    expect(plan.cards.at(-1)!.delay + CARD_FLIGHT_MS).toBeLessThanOrEqual(1520);
    expect(view(dealt).players.slice(1).every(player => player.cards.length === 4 && player.cards.every(card => card === null))).toBe(true);
  });

  test('double-board bomb pots post antes and deal both flops after the hole cards', () => {
    const ready = table([1000, 1000, 1000], { game: 'omaha_bomb', bombAnte: 50 });
    const dealt = start(ready);
    expect(dealt.hand?.boards.map(board => board.length)).toEqual([3, 3]);
    const plan = motion(ready, dealt);
    expect(plan.chips).toEqual(['p0', 'p1', 'p2'].map(playerId => ({
      kind: 'ante', playerId, amount: 50, from: 'stack', to: 'pot', delay: 0,
    })));
    const holes = plan.cards.filter(card => card.key.startsWith('hole:'));
    const boards = plan.cards.filter(card => card.key.startsWith('board:'));
    expect(holes).toHaveLength(12);
    expect(boards.map(card => card.key)).toEqual(
      [0, 1].flatMap(board => [0, 1, 2].map(index => boardCardKey(0, board, index))),
    );
    expect(boards[0]!.delay).toBeGreaterThanOrEqual(holes.at(-1)!.delay + CARD_FLIGHT_MS);
    expect(boards[0]!.delay).toBeGreaterThanOrEqual(CHIP_FLIGHT_MS);
    expect(boards.map(card => card.delay - boards[0]!.delay)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(plan.cards.every(card => card.kind === 'deal')).toBe(true);
  });
});

describe('bets, refunds and payouts', () => {
  test('calls and raises use committed deltas, not street bets that reset on the flop', () => {
    let room = start(table([1000, 1000, 1000]));
    for (const [action, amount, playerId, contribution] of [
      ['call', undefined, 'p0', 20],
      ['raise', 60, 'p1', 50],
      ['call', undefined, 'p2', 40],
      ['call', undefined, 'p0', 40],
    ] as const) {
      const next = act(room, action, amount);
      const plan = motion(room, next);
      expect(plan.chips.filter(chip => chip.kind === 'bet')).toEqual([
        { kind: 'bet', playerId, amount: contribution, from: 'stack', to: 'wager', delay: 0 },
      ]);
      if (next.hand!.street === 'preflop') expect(plan.cards).toEqual([]);
      else {
        expect(plan.chips.filter(chip => chip.kind === 'collect')).toEqual(['p0', 'p1', 'p2'].map(playerId => ({
          kind: 'collect', playerId, amount: 60, from: 'wager', to: 'pot', delay: CHIP_FLIGHT_MS + 60,
        })));
        expect(next.hand!.players.map(player => [player.committed, player.streetBet])).toEqual([[60, 0], [60, 0], [60, 0]]);
        expect(plan.cards.map(card => card.key)).toEqual([0, 1, 2].map(index => boardCardKey(0, 0, index)));
        expect(plan.cards[0]!.delay).toBeGreaterThanOrEqual(CHIP_FLIGHT_MS * 2 + 60);
      }
      room = next;
    }
    const raised = act(room, 'raise', 20);
    expect(motion(room, raised).chips).toEqual([{ kind: 'bet', playerId: 'p1', amount: 20, from: 'stack', to: 'wager', delay: 0 }]);
  });

  test('checking through flop, turn and river deals only newly added board slots', () => {
    let room = act(start(table()), 'call');
    for (const indices of [[0, 1, 2], [3], [4]]) {
      const next = act(room, 'check');
      const plan = motion(room, next);
      expect(plan.chips).toEqual(indices[0] === 0 ? ['p0', 'p1'].map(playerId => ({
        kind: 'collect', playerId, amount: 20, from: 'wager', to: 'pot', delay: 0,
      })) : []);
      expect(plan.cards).toEqual(indices.map((index, offset) => ({
        kind: 'deal', key: boardCardKey(0, 0, index), delay: (indices[0] === 0 ? CHIP_FLIGHT_MS + 40 : 0) + offset * 100,
      })));
      room = next;
      if (indices[0] !== 4) {
        const checked = act(room, 'check');
        expect(motion(room, checked)).toEqual(empty);
        room = checked;
      }
    }
  });

  test('an uncalled raise returns separately from the winning pot, without exposing the loser', () => {
    const before = act(start(table()), 'raise', 100);
    const after = act(before, 'fold');
    expect(after.players[0]!.stack - before.players[0]!.stack).toBe(120);
    const plan = motion(before, after);
    expect(plan.chips).toMatchObject([
      { kind: 'refund', playerId: 'p0', amount: 80, from: 'wager', to: 'stack', delay: 0 },
      { kind: 'collect', playerId: 'p0', amount: 20, from: 'wager', to: 'pot', delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'collect', playerId: 'p1', amount: 20, from: 'wager', to: 'pot', delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'payout', playerId: 'p0', amount: 40, delay: expect.any(Number) },
    ]);
    expect(plan.chips.at(-1)!.delay).toBeGreaterThanOrEqual(CHIP_FLIGHT_MS * 2 + 60);
    expect(plan.cards).toEqual([]);
    expect(view(after).players[1]!.cards).toEqual([null, null]);
    for (const viewer of ['p0', 'p1']) {
      expect(winningHands(view(after, viewer))).toMatchObject([{
        playerId: 'p0', amount: 40, description: 'Uncontested', cards: [],
      }]);
    }
  });

  test('a tied showdown pays exact odd-chip shares after revealing only the live opponent', () => {
    let room = start(table([50, 50, 50], {}, { smallBlind: 1, bigBlind: 2, ante: 1 }),
      rig('2c 3c 4c 5d 6d 7d 8c Th Jh Qh 9c Kh Tc Ah'.split(' ')));
    room = act(act(act(room, 'call'), 'call'), 'check');
    room = act(act(act(room, 'check'), 'fold'), 'check');
    const before = act(untilRiver(room), 'check');
    const after = act(before, 'check');
    expect(after.hand!.results[0]!.shares).toEqual({ p1: 5, p0: 4 });
    const plan = motion(before, after);
    expect(plan.cards).toEqual([0, 1].map(index => ({
      kind: 'reveal', key: holeCardKey('p1', index), delay: 0,
    })));
    expect(view(after).players[2]!.cards).toEqual([null, null]);
    expect(plan.chips).toMatchObject([
      { kind: 'payout', playerId: 'p1', amount: 5, delay: expect.any(Number) },
      { kind: 'payout', playerId: 'p0', amount: 4, delay: expect.any(Number) },
    ]);
    expect(plan.chips.every(chip => chip.delay >= CARD_REVEAL_MS)).toBe(true);
    const wins = winningHands(freeze(view(after)));
    expect(wins.map(win => [win.playerId, win.amount])).toEqual([['p1', 5], ['p0', 4]]);
    for (const win of wins) {
      expect(win).toMatchObject({ description: 'Royal flush', split: true, playsBoard: true });
      expect(win.cards).toHaveLength(5);
      expect(win.cards.every(card => !card.hole && card.source.startsWith('board:0:0:'))).toBe(true);
    }
  });

  test('three runouts aggregate main and side-pot shares into one payout per recipient', () => {
    const deck = rig([
      'Ks Qs As Kh Qh Ad',
      '2d 2c 3d 7h 3c 9c 4c Ts',
      '2h Kc 4d 5h 3h 8c 4h Js',
      '5c Qc 6d 7s 5d 9h 6c Td',
    ].flatMap(cards => cards.split(' ')));
    let room = start(table([100, 200, 300], { maxRunouts: 3 }, { smallBlind: 5, bigBlind: 10 }), deck);
    room = act(act(act(room, 'raise', 100), 'raise', 200), 'call');
    expect(room.hand!.runoutVote).not.toBeNull();
    for (const playerId of ['p0', 'p1']) {
      const next = vote(room, playerId);
      expect(motion(room, next)).toEqual(empty);
      room = next;
    }
    const after = vote(room, 'p2');
    expect(after.hand!.results.map(result => result.shares)).toEqual([
      { p0: 100 }, { p1: 100 }, { p2: 100 }, { p1: 67 }, { p1: 67 }, { p2: 66 },
    ]);
    const plan = motion(room, after);
    expect(plan.chips).toMatchObject([
      { kind: 'payout', playerId: 'p0', amount: 100, delay: expect.any(Number) },
      { kind: 'payout', playerId: 'p1', amount: 234, delay: expect.any(Number) },
      { kind: 'payout', playerId: 'p2', amount: 166, delay: expect.any(Number) },
    ]);
    expect(plan.cards.filter(card => card.kind === 'deal').map(card => card.key)).toEqual(
      [0, 1, 2].flatMap(run => [0, 1, 2, 3, 4].map(index => boardCardKey(run, 0, index))),
    );
    const revealEnd = Math.max(...plan.cards.map(card => card.delay + (card.kind === 'deal' ? CARD_FLIGHT_MS : CARD_REVEAL_MS)));
    expect(plan.chips.every(chip => chip.delay >= revealEnd)).toBe(true);
    expect(new Set(plan.chips.map(chip => chip.delay)).size).toBe(1);
    expect(plan.chips.reduce((sum, chip) => sum + chip.amount, 0)).toBe(after.hand!.awardedPot);
    const wins = winningHands(freeze(view(after)));
    expect(wins.map(win => [win.runoutIndex, win.playerId, win.amount, win.pots, win.description])).toEqual([
      [0, 'p0', 100, [0], 'Pair of aces'],
      [0, 'p1', 67, [1], 'Pair of kings'],
      [1, 'p1', 167, [0, 1], 'Three of a kind, kings'],
      [2, 'p2', 166, [0, 1], 'Three of a kind, queens'],
    ]);
    expect(wins.reduce((sum, win) => sum + win.amount, 0)).toBe(after.hand!.awardedPot);
    for (const win of wins) {
      expect(win.cards).toHaveLength(5);
      const board = after.hand!.runoutBoards[win.runoutIndex]![win.boardIndex]!;
      for (const { card, source, hole } of win.cards) {
        expect(source).toBe(hole ? holeCardKey(win.playerId, after.hand!.revealed[win.playerId]!.indexOf(card))
          : boardCardKey(win.runoutIndex, win.boardIndex, board.indexOf(card)));
      }
    }
  });

  test.each(['holdem', 'omaha_bomb'] as const)('%s extra runouts never redeal their shared flop prefixes', game => {
    let room = start(table([60, 60], { game, maxRunouts: 3, bombAnte: 60 }));
    if (game === 'holdem') {
      room = act(act(room, 'call'), 'check');
      room = act(act(room, 'raise', 40), 'call');
    }
    expect(room.hand!.runoutVote).not.toBeNull();
    const before = vote(room, 'p0');
    const after = vote(before, 'p1');
    const boards = game === 'omaha_bomb' ? [0, 1] : [0];
    expect(after.hand!.runoutPrefix).toEqual(before.hand!.boards);
    for (const run of after.hand!.runoutBoards)
      expect(run.map(board => board.slice(0, 3))).toEqual(before.hand!.boards);
    const plan = motion(before, after);
    expect(plan.cards.filter(card => card.kind === 'deal').map(card => card.key)).toEqual(
      [0, 1, 2].flatMap(run => boards.flatMap(board => [3, 4].map(index => boardCardKey(run, board, index)))),
    );
    const shares = new Map<string, number>();
    for (const result of after.hand!.results)
      for (const [id, amount] of Object.entries(result.shares)) shares.set(id, (shares.get(id) ?? 0) + amount);
    expect(plan.chips.map(({ playerId, amount }) => [playerId, amount])).toEqual([...shares]);
    expect(plan.chips.every(chip => chip.kind === 'payout')).toBe(true);
    const wins = winningHands(view(after));
    expect(new Set(wins.map(win => `${win.runoutIndex}:${win.boardIndex}`))).toEqual(
      new Set([0, 1, 2].flatMap(run => boards.map(board => `${run}:${board}`))),
    );
    if (game === 'omaha_bomb') {
      for (const win of wins) {
        expect(win.cards.filter(card => card.hole)).toHaveLength(2);
        expect(win.cards.filter(card => !card.hole)).toHaveLength(3);
      }
    }
  });
});

describe('hand explanations from redacted snapshots', () => {
  test.each([
    ['As Ad Qc Jh 2s', 'Pair of aces', 'As Ad Qc Jh 2s'],
    ['2c Kd Kh As Ad', 'Two pair, aces and kings', 'As Ad Kd Kh 2c'],
    ['Ah Ad Ks Kd Kc', 'Full house, kings full of aces', 'Ks Kd Kc Ah Ad'],
    ['Ac 2d 3s 4h 5d', 'Straight, five high', '5d 4h 3s 2d Ac'],
    ['As Js 9s 6s 2s', 'Flush, ace high', 'As Js 9s 6s 2s'],
    ['5h 4h 3h 2h Ah', 'Straight flush, five high', '5h 4h 3h 2h Ah'],
    ['As Ks Qs Js Ts', 'Royal flush', 'As Ks Qs Js Ts'],
  ])('names and groups the actual combination for %s', (cards, description, ordered) => {
    const rank = evaluate(cards.split(' '));
    expect(describeHand(rank)).toBe(description);
    expect(orderedHandCards(rank)).toEqual(ordered.split(' '));
    expect(rank.cards).toEqual(cards.split(' '));
  });

  test('only the viewer gets their live hand, updated from preflop to the visible board', () => {
    let room = start(table(), rig('Ks As Kh Ad 2c Ac 9c 7d'.split(' ')));
    expect(currentHands(freeze(view(room)))).toEqual([{ boardIndex: 0, description: 'Pair of aces' }]);
    expect(currentHands(view(room, 'p1'))).toEqual([{ boardIndex: 0, description: 'Pair of kings' }]);
    expect(winningHands(view(room))).toEqual([]);
    room = act(act(room, 'call'), 'check');
    const projected = freeze(view(room));
    expect(projected.players[1]!.cards).toEqual([null, null]);
    expect(currentHands(projected)).toEqual([{ boardIndex: 0, description: 'Three of a kind, aces' }]);
    expect(currentHands(view(room, 'p1'))).toEqual([{ boardIndex: 0, description: 'Pair of kings' }]);
  });

  test('each double-board live hand is evaluated separately', () => {
    const room = start(table([1000, 1000], { doubleBoard: true, bombPot: true, bombAnte: 20 }),
      rig('Ks As Kh Ad 2c Ac 9c 7d 2d 3d 4h'.split(' ')));
    expect(currentHands(view(room))).toEqual([
      { boardIndex: 0, description: 'Three of a kind, aces' },
      { boardIndex: 1, description: 'Pair of aces' },
    ]);
  });

  test('Omaha never counts three or four hole cards as a made hand', () => {
    let room = start(table([1000, 1000], { game: 'omaha' }),
      rig('2c As 3c Ad 4c Ac 5c Ah 6c Ks Kd 7h'.split(' ')));
    expect(currentHands(view(room))).toEqual([{ boardIndex: 0, description: 'Omaha hand forms on the flop' }]);
    room = act(act(room, 'call'), 'check');
    expect(currentHands(view(room))).toEqual([{ boardIndex: 0, description: 'Two pair, aces and kings' }]);
  });

  test('hidden Indian cards, folded players, incomplete private views, and completed hands have no live rank', () => {
    const indian = start(table([1000, 1000], { game: 'indian' }));
    expect(view(indian).players[0]!.cards).toEqual([null, null]);
    expect(currentHands(view(indian))).toEqual([]);
    const normal = start(table([1000, 1000, 1000]));
    const redacted = view(normal);
    redacted.players[0]!.cards[0] = null;
    expect(currentHands(redacted)).toEqual([]);
    const folded = act(normal, 'fold');
    expect(folded.hand!.street).not.toBe('complete');
    expect(currentHands(view(folded))).toEqual([]);
    expect(currentHands(view(act(folded, 'fold')))).toEqual([]);
  });

  test('a partial voluntary reveal never fills a winning hand from private cards', () => {
    const finished = act(start(table()), 'fold');
    const shown = apply(finished, 'p1', { type: 'reveal', handId: finished.hand!.id, cardIndexes: [0] });
    for (const viewer of ['p0', 'p1']) {
      const wins = winningHands(view(shown, viewer));
      expect(wins).toHaveLength(1);
      expect(wins[0]).toMatchObject({ playerId: 'p1', description: 'Uncontested', cards: [] });
    }
  });
});

describe('street wager piles and collected pot', () => {
  test('a raise and reraise stay at the seats until the closing call sweeps both complete wagers', () => {
    let room = start(table());
    expect(streetWagers(view(room))).toEqual({ p0: 10, p1: 20 });
    expect(collectedPot(view(room))).toBe(0);
    for (const [amount, actor, added] of [[60, 'p0', 50], [180, 'p1', 160]] as const) {
      const next = act(room, 'raise', amount);
      expect(motion(room, next).chips).toEqual([{
        kind: 'bet', playerId: actor, amount: added, from: 'stack', to: 'wager', delay: 0,
      }]);
      expect(collectedPot(view(next))).toBe(0);
      expect(Object.values(streetWagers(view(next))).reduce((sum, value) => sum + value, 0)).toBe(next.hand!.pot);
      room = next;
    }
    expect(streetWagers(view(room))).toEqual({ p0: 60, p1: 180 });
    const flop = act(room, 'call');
    const plan = motion(room, flop);
    expect(plan.chips).toEqual([
      { kind: 'bet', playerId: 'p0', amount: 120, from: 'stack', to: 'wager', delay: 0 },
      ...['p0', 'p1'].map(playerId => ({
        kind: 'collect', playerId, amount: 180, from: 'wager', to: 'pot', delay: CHIP_FLIGHT_MS + 60,
      })),
    ]);
    expect(streetWagers(view(flop))).toEqual({});
    expect(collectedPot(view(flop))).toBe(360);
    const bet = act(flop, 'raise', 40);
    expect(streetWagers(view(bet))).toEqual({ p1: 40 });
    expect(collectedPot(view(bet))).toBe(360);
    expect(bet.hand!.pot).toBe(400);
  });

  test('folded players keep their wagers until the other players finish the round', () => {
    let room = act(start(table([1000, 1000, 1000])), 'raise', 60);
    const folded = act(room, 'fold');
    expect(motion(room, folded)).toEqual(empty);
    expect(streetWagers(view(folded))).toEqual({ p0: 60, p1: 10, p2: 20 });
    const called = act(folded, 'call');
    expect(motion(folded, called).chips.filter(chip => chip.kind === 'collect').map(chip => [chip.playerId, chip.amount]))
      .toEqual([['p0', 60], ['p1', 10], ['p2', 60]]);
    expect(collectedPot(view(called))).toBe(130);
  });

  test('antes are collected immediately while blinds remain separate street wagers', () => {
    for (const game of ['holdem', 'omaha', 'indian'] as const) {
      const ready = table([1000, 1000], { game, omahaAnte: 30, indianAnte: 40 }, { ante: 5 });
      const room = start(ready);
      const ante = game === 'holdem' ? 5 : game === 'omaha' ? 30 : 40;
      expect(collectedPot(view(room))).toBe(ante * 2);
      expect(streetWagers(view(room))).toEqual({ p0: 10, p1: 20 });
      expect(motion(ready, room).chips).toEqual([
        { kind: 'ante', playerId: 'p0', amount: ante, from: 'stack', to: 'pot', delay: 0 },
        { kind: 'bet', playerId: 'p0', amount: 10, from: 'stack', to: 'wager', delay: 0 },
        { kind: 'ante', playerId: 'p1', amount: ante, from: 'stack', to: 'pot', delay: 0 },
        { kind: 'bet', playerId: 'p1', amount: 20, from: 'stack', to: 'wager', delay: 0 },
      ]);
    }
    const ready = table([1000, 1000], { game: 'omaha_bomb', bombAnte: 50 });
    const bomb = start(ready);
    expect(streetWagers(view(bomb))).toEqual({});
    expect(collectedPot(view(bomb))).toBe(100);
    expect(motion(ready, bomb).chips.every(chip => chip.kind === 'ante' && chip.to === 'pot')).toBe(true);
  });

  test('all-in consent collects once, and later refunds come out of the already-collected pot', () => {
    let room = act(start(table([1000, 100], { maxRunouts: 3 })), 'raise', 300);
    const voteOpen = act(room, 'call');
    expect(voteOpen.hand!.runoutVote).not.toBeNull();
    expect(streetWagers(view(voteOpen))).toEqual({});
    expect(collectedPot(view(voteOpen))).toBe(400);
    expect(motion(room, voteOpen).chips.filter(chip => chip.kind === 'collect').map(chip => [chip.playerId, chip.amount]))
      .toEqual([['p0', 300], ['p1', 100]]);
    room = vote(voteOpen, 'p0');
    expect(motion(voteOpen, room)).toEqual(empty);
    const finished = vote(room, 'p1');
    const plan = motion(room, finished);
    expect(plan.chips.filter(chip => chip.kind === 'collect')).toEqual([]);
    expect(plan.chips.find(chip => chip.kind === 'refund')).toEqual({
      kind: 'refund', playerId: 'p0', amount: 200, from: 'pot', to: 'stack', delay: 0,
    });
    expect(collectedPot(view(finished))).toBe(200);
  });

  test('all-in blinds that resolve during the deal still travel via wager piles, not as antes', () => {
    const ready = table([5, 10]);
    const complete = start(ready);
    expect(complete.hand!.street).toBe('complete');
    const plan = motion(ready, complete);
    expect(plan.chips.filter(chip => chip.kind === 'ante')).toEqual([]);
    expect(plan.chips.filter(chip => chip.kind === 'bet').map(chip => [chip.playerId, chip.amount, chip.to]))
      .toEqual([['p0', 5, 'wager'], ['p1', 5, 'wager']]);
    expect(plan.chips.filter(chip => chip.kind === 'collect').map(chip => chip.amount)).toEqual([5, 5]);
  });

  test('one all-in player does not collect wagers while others can still raise', () => {
    let room = start(table([100, 1000, 1000]));
    for (const [action, amount] of [['raise', 100], ['call', undefined], ['raise', 300]] as const) {
      const next = act(room, action, amount);
      expect(motion(room, next).chips.every(chip => chip.kind === 'bet' && chip.to === 'wager')).toBe(true);
      expect(collectedPot(view(next))).toBe(0);
      room = next;
    }
    const flop = act(room, 'call');
    expect(motion(room, flop).chips.filter(chip => chip.kind === 'collect').map(chip => [chip.playerId, chip.amount]))
      .toEqual([['p0', 100], ['p1', 300], ['p2', 300]]);
    expect(flop.hand!.street).toBe('flop');
    expect(collectedPot(view(flop))).toBe(700);
  });
});

describe('non-pot changes and public visibility', () => {
  test('funding requests, approval, add-ons and cash-outs do not replay a completed hand', () => {
    let room = act(start(table()), 'fold');
    const send = (actor: string, command: Command) => {
      const next = apply(room, actor, command);
      expect(motion(room, next)).toEqual(empty);
      room = next;
    };
    send('p0', { type: 'fund', amount: 100 });
    send('p1', { type: 'fund', amount: 100 });
    send('p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    expect(room.players.map(player => player.stack)).toEqual([1090, 1110]);
    send('p1', { type: 'cash_out' });
    expect(room.players[1]!.stack).toBe(0);
    send('p1', { type: 'join', name: 'Player 1' });
    send('p1', { type: 'fund', amount: 500 });
    send('p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    expect(room.players[1]!.stack).toBe(500);
  });

  test('queued add-ons at settlement are not confused with refunds or payouts', () => {
    let room = start(table());
    const send = (actor: string, command: Command) => {
      const next = apply(room, actor, command);
      expect(motion(room, next)).toEqual(empty);
      room = next;
    };
    send('p0', { type: 'fund', amount: 100 });
    send('p1', { type: 'fund', amount: 100 });
    send('p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    const after = act(room, 'fold');
    expect(after.players.map(player => player.stack)).toEqual([1090, 1110]);
    expect(motion(room, after).chips).toMatchObject([
      { kind: 'refund', playerId: 'p1', amount: 10, delay: 0 },
      { kind: 'collect', playerId: 'p0', amount: 10, delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'collect', playerId: 'p1', amount: 10, delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'payout', playerId: 'p1', amount: 20, delay: expect.any(Number) },
    ]);
  });

  test('emoji, chat, pause and sit-out commands leave the current motion idle', () => {
    let room = start(table());
    const commands: Command[] = [
      { type: 'emoji', emoji: '\u{1F60E}' },
      { type: 'chat', message: 'Nice table' },
      { type: 'pause', value: true },
      { type: 'pause', value: false },
      { type: 'sit_out', value: true },
    ];
    for (const command of commands) {
      const next = apply(room, 'p0', command);
      expect(motion(room, next), command.type).toEqual(empty);
      room = next;
    }
  });

  test('upcoming bomb-pot rules and pending blinds do not alter current Holdem animations', () => {
    let room = start(table());
    const commands: Command[] = [
      { type: 'next_hand', rules: { ...room.nextHandRules, game: 'omaha_bomb', bombAnte: 100 } },
      { type: 'settings', smallBlind: 25, bigBlind: 50, ante: 1, autoDeal: false, turnSeconds: 30, allowRebuys: true },
    ];
    for (const command of commands) {
      const next = apply(room, 'p0', command);
      expect(motion(room, next)).toEqual(empty);
      room = next;
    }
    expect(room.hand!.rules.game).toBe('holdem');
    const called = act(room, 'call');
    expect(motion(room, called)).toEqual({
      chips: [{ kind: 'bet', playerId: 'p0', amount: 10, from: 'stack', to: 'wager', delay: 0 }], cards: [],
    });
    const flop = act(called, 'check');
    expect(motion(called, flop).cards.map(card => card.key)).toEqual([0, 1, 2].map(index => boardCardKey(0, 0, index)));
    expect(view(flop).players.every(player => player.cards.length === 2)).toBe(true);
  });

  test('zero-sum bounty balances are not pot chips, even when a bounty publicly reveals the winner', () => {
    const before = start(table([1000, 1000], { sevenDeuceBounty: 500 }), rig('7c As 2d Ad'.split(' ')));
    const after = act(before, 'fold');
    expect(after.players.map(player => player.bountyNet)).toEqual([-500, 500]);
    const plan = motion(before, after);
    expect(plan.chips).toMatchObject([
      { kind: 'refund', playerId: 'p1', amount: 10, delay: 0 },
      { kind: 'collect', playerId: 'p0', amount: 10, delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'collect', playerId: 'p1', amount: 10, delay: CHIP_FLIGHT_MS + 60 },
      { kind: 'payout', playerId: 'p1', amount: 20, delay: expect.any(Number) },
    ]);
    expect(plan.cards.map(({ kind, key }) => ({ kind, key }))).toEqual(
      [0, 1].map(index => ({ kind: 'reveal', key: holeCardKey('p1', index) })),
    );
    const previous = view(after);
    const balanceOnly: RoomView = {
      ...structuredClone(previous), version: previous.version + 1,
      players: previous.players.map((player, index) => ({
        ...player, bountyNet: player.bountyNet + (index === 0 ? -25 : 25),
        net: player.net + (index === 0 ? -25 : 25),
      })),
    };
    expect(planTableMotion(previous, balanceOnly)).toEqual(empty);
  });

  test('Indian poker reveals only the newly authorized own cards after folding', () => {
    const before = start(table([1000, 1000, 1000], { game: 'indian', indianAnte: 20 }));
    const after = act(before, 'fold');
    expect(after.hand!.street).not.toBe('complete');
    expect(view(before).players[0]!.cards).toEqual([null, null]);
    expect(view(before).players.slice(1).every(player => player.cards.every(card => card !== null))).toBe(true);
    expect(view(after).players[0]!.cards).toEqual(after.hand!.holeCards.p0);
    expect(motion(before, after)).toEqual({
      chips: [], cards: [0, 1].map(index => ({ kind: 'reveal', key: holeCardKey('p0', index), delay: 0 })),
    });
    expect(motion(before, after, 'p1')).toEqual(empty);
  });

  test('plans are deterministic, immutable and independent of private card identities', () => {
    const ready = table([1000, 1000, 1000]);
    const dealt = start(ready, rig('Ks Qs As Kd Qd Ad'.split(' ')));
    const alternate = start(ready, rig('2c 3c 4c 2d 3d 4d'.split(' ')));
    expect(motion(ready, dealt)).toEqual(motion(ready, alternate));
    const river = act(untilRiver(dealt), 'check');
    const beforeSettlement = act(river, 'check');
    const settled = act(beforeSettlement, 'check');
    for (const [before, after] of [[view(ready), view(dealt)], [view(beforeSettlement), view(settled)]]) {
      const originals = structuredClone([before, after]);
      const plan = planTableMotion(freeze(before!), freeze(after!));
      expect(planTableMotion(before!, after!)).toEqual(plan);
      expect([before, after]).toEqual(originals);
      expect(after!.hand).not.toHaveProperty('holeCards');
      expect(after!.hand).not.toHaveProperty('deck');
      for (const card of plan.cards) expect(Object.keys(card).sort()).toEqual(['delay', 'key', 'kind']);
      for (const chip of plan.chips) expect(Object.keys(chip).sort()).toEqual(['amount', 'delay', 'from', 'kind', 'playerId', 'to']);
      for (const face of makeDeck()) expect(JSON.stringify(plan)).not.toContain(`"${face}"`);
    }
  });
});
