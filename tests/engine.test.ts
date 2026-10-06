import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, chips, money, presetRaise, type Command, type Room, type RoomSettings } from '../src/shared/model';
import { makeDeck, evaluate, shuffleDeck } from '../src/server/cards';
import { assertRoom, createRoom, legalActions, roomView, timeoutTurn, transition } from '../src/server/engine';
import { verifyTransfers } from '../src/server/store';
import { chooseBotAction } from '../src/server/bot';
import { EMOJI_GROUPS, isPlayerEmoji } from '../src/shared/emoji';

let now = 1800000000000;
function apply(room: Room, actor: string, command: Command, deck?: string[]) {
  const result = transition(room, actor, command, { now: ++now, deck });
  assertRoom(result.room);
  verifyTransfers(room, result.room, result.transfers);
  return result.room;
}
function table(stacks = [1000, 1000], settings: Partial<RoomSettings> = {}) {
  const initial = createRoom({
    id: 'room', code: 'ABC12345', name: 'Test table', hostId: 'p0', hostName: 'Player 0', buyIn: stacks[0]!,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 1000000, autoDeal: false, ...settings },
  }, { now: ++now });
  verifyTransfers(null, initial.room, initial.transfers);
  let room = initial.room;
  for (let i = 1; i < stacks.length; i++) {
    room = apply(room, `p${i}`, { type: 'join', name: `Player ${i}` });
    room = apply(room, `p${i}`, { type: 'fund', amount: stacks[i]! });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return room;
}
function start(room: Room, deck?: string[]) { return apply(room, 'p0', { type: 'deal' }, deck); }
function act(room: Room, action: 'fold' | 'check' | 'call' | 'raise', amount?: number) {
  return apply(room, room.hand!.actorId!, { type: 'act', action, amount });
}
function checkDown(initial: Room) {
  let room = initial; let turns = 0;
  while (room.hand?.street !== 'complete') {
    if (++turns > 100) throw new Error('A check-down did not finish.');
    room = act(room, legalActions(room, room.hand!.actorId!).canCheck ? 'check' : 'call');
  }
  return room;
}
function rig(cards: string[]) {
  expect(new Set(cards).size).toBe(cards.length);
  return [...cards, ...makeDeck().filter(card => !cards.includes(card))];
}
const stack = (room: Room, id: string) => room.players.find(player => player.id === id)!.stack;

describe('card evaluation and fair deck construction', () => {
  test.each([
    ['As Ks Qs Js Ts', 8, 'Royal flush'],
    ['5h 4h 3h 2h Ah', 8, 'Straight flush'],
    ['As Ad Ac Ah 2s', 7, 'Four of a kind'],
    ['Ks Kd Kc Ah Ad', 6, 'Full house'],
    ['As Js 9s 6s 2s', 5, 'Flush'],
    ['Ac 2d 3s 4h 5d', 4, 'Straight'],
    ['9s 9d 9c Ah 3s', 3, 'Three of a kind'],
    ['As Ad Kc Kh 2c', 2, 'Two pair'],
    ['As Ad Qc Jh 2s', 1, 'One pair'],
    ['As Kd 9c 7h 4s', 0, 'High card'],
  ])('%s ranks correctly', (cards, category, label) => {
    const result = evaluate(cards.split(' '));
    expect(result.category).toBe(category); expect(result.label).toBe(label);
  });
  test('best five of seven, wheel, kickers, and full houses', () => {
    expect(evaluate('As Ad Ac Ks Kd Kc 2d'.split(' ')).score).toBe(evaluate('As Ad Ac Ks Kd'.split(' ')).score);
    expect(evaluate('Ah 2c 3d 4s 5h'.split(' ')).score).toBeLessThan(evaluate('2h 3c 4d 5s 6h'.split(' ')).score);
    expect(evaluate('As Ad Kh Qh 8s'.split(' ')).score).toBeGreaterThan(evaluate('Ah Ac Kc Qd 7s'.split(' ')).score);
    expect(evaluate('As Ks Qs Js 9s 2d 3h'.split(' ')).score).toBeLessThan(evaluate('As Ks Qs Js Ts 2d 3h'.split(' ')).score);
    expect(evaluate('As Ad Ks Kd Qc'.split(' ')).score).toBeGreaterThan(evaluate('Ah Ac Kh Kc Jd'.split(' ')).score);
  });
  test('rejects invalid, missing, and duplicate cards', () => {
    for (const cards of [['As', 'As', '2c', '3d', '4h'], ['1s', '2s', '3s', '4s', '5s'], ['As', 'Ks']])
      expect(() => evaluate(cards)).toThrow();
  });
  test('shuffles all 52 cards without replacement', () => {
    const signatures = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const deck = shuffleDeck();
      expect(deck).toHaveLength(52); expect(new Set(deck).size).toBe(52);
      expect([...deck].sort()).toEqual(makeDeck().sort());
      signatures.add(deck.join());
    }
    expect(signatures.size).toBe(20);
  });
});

test('reused display formatters preserve chip and currency output', () => {
  for (const value of [0, 1, -1, 1234, -123456, 1000000000]) {
    expect(chips(value)).toBe(new Intl.NumberFormat('en-US').format(value));
    for (const currency of ['USD', 'EUR', 'GBP', 'CAD'])
      expect(money(value, currency)).toBe(new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100));
  }
  expect(money(1234)).toBe('$12.34');
  expect(() => money(100, 'invalid')).toThrow(RangeError);
});

describe('per-table player emojis', () => {
  test('the picker has distinct, named choices accepted by the server', () => {
    const choices = EMOJI_GROUPS.flatMap(group => group.choices);
    expect(new Set(choices.map(choice => choice.value)).size).toBe(choices.length);
    expect(choices.every(choice => choice.label && choice.keywords && choice.value.length <= 16 && isPlayerEmoji(choice.value))).toBe(true);
  });

  test('each player changes only their emoji without changing an active hand or its accounts', () => {
    const original = start(table());
    const result = transition(original, 'p1', { type: 'emoji', emoji: '\u{1F60E}' }, { now: ++now });
    expect(original.players[1]?.emoji).toBeNull();
    expect(result.room.players[0]?.emoji).toBeNull();
    expect(result.room.players[1]?.emoji).toBe('\u{1F60E}');
    expect(result.room.hand).toEqual(original.hand);
    expect(result.room.players.map(({ emoji: _emoji, ...player }) => player))
      .toEqual(original.players.map(({ emoji: _emoji, ...player }) => player));
    expect(result.transfers).toEqual([]);
    expect(result.events).toEqual([expect.objectContaining({ kind: 'emoji', actorId: 'p1' })]);
    expect(result.room.version).toBe(original.version + 1);
    verifyTransfers(original, result.room, result.transfers);
    for (const viewer of ['p0', 'p1'])
      expect(roomView(result.room, viewer, new Set()).players[1]?.emoji).toBe('\u{1F60E}');
    const paused = apply(result.room, 'p0', { type: 'pause', value: true });
    const cleared = apply(paused, 'p1', { type: 'emoji', emoji: null });
    expect(cleared.players[1]?.emoji).toBeNull();
    expect(cleared.hand).toEqual(paused.hand);
  });

  test('legacy snapshots without emojis still work, and rejoining keeps the table selection', () => {
    let room = table();
    for (const player of room.players) delete player.emoji;
    expect(() => assertRoom(room)).not.toThrow();
    expect(roomView(room, 'p0', new Set()).players[1]?.emoji).toBeUndefined();
    room = apply(room, 'p1', { type: 'emoji', emoji: '\u{1F988}' });
    room = apply(room, 'p1', { type: 'cash_out' });
    room = apply(room, 'p1', { type: 'join', name: 'Player 1' });
    expect(room.players[1]?.emoji).toBe('\u{1F988}');
    expect(table().players[1]?.emoji).toBeNull();
  });

  test('invalid values, nonmembers, and closed-session changes are rejected', () => {
    const room = table();
    for (const emoji of ['', 'hello', '<script>', '\u{1F600}\u{1F600}', 'a'.repeat(100)])
      expect(() => apply(room, 'p1', { type: 'emoji', emoji })).toThrow('Choose an emoji');
    expect(() => apply(room, 'outsider', { type: 'emoji', emoji: '\u{1F600}' })).toThrow('not a member');
    const closed = apply(room, 'p0', { type: 'close' });
    expect(() => apply(closed, 'p1', { type: 'emoji', emoji: null })).toThrow('closed');
  });
});

describe('no-limit rules', () => {
  test('heads-up button is small blind and acts first only preflop', () => {
    let room = start(table());
    expect(room.hand).toMatchObject({ buttonSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1, actorId: 'p0', pot: 30 });
    room = act(room, 'call');
    expect(room.hand?.actorId).toBe('p1');
    expect(legalActions(room, 'p1').canCheck).toBe(true);
    room = act(room, 'check');
    expect(room.hand).toMatchObject({ street: 'flop', actorId: 'p1' });
    room = checkDown(room);
    room = start(room);
    expect(room.hand).toMatchObject({ buttonSeat: 1, smallBlindSeat: 1, bigBlindSeat: 0, actorId: 'p1' });
  });
  test('four-way action begins left of the big blind and preserves its option', () => {
    let room = start(table([1000, 1000, 1000, 1000]));
    expect(room.hand?.actorId).toBe('p3');
    room = act(room, 'call'); expect(room.hand?.actorId).toBe('p0');
    room = act(room, 'call'); expect(room.hand?.actorId).toBe('p1');
    room = act(room, 'call'); expect(room.hand?.actorId).toBe('p2');
    expect(room.hand?.street).toBe('preflop');
    room = act(room, 'check'); expect(room.hand).toMatchObject({ street: 'flop', actorId: 'p1' });
  });
  test('raise amounts mean raise-to and minimum increments follow the last full raise', () => {
    let room = start(table());
    const before = structuredClone(room);
    expect(() => apply(room, 'p1', { type: 'act', action: 'raise', amount: 60 })).toThrow('turn');
    expect(() => act(room, 'check')).toThrow('bet');
    expect(() => act(room, 'raise', 30)).toThrow('minimum');
    expect(room).toEqual(before);
    room = act(room, 'raise', 60);
    expect(stack(room, 'p0')).toBe(940);
    expect(legalActions(room, 'p1')).toMatchObject({ toCall: 40, minRaiseTo: 100 });
    expect(() => act(room, 'raise', 90)).toThrow('minimum');
  });
  test('a short all-in does not reopen a prior full raiser', () => {
    let room = start(table([1000, 75, 1000, 1000]));
    room = act(room, 'call'); room = act(room, 'raise', 60); room = act(room, 'raise', 75);
    expect(room.hand?.minRaise).toBe(40);
    room = act(room, 'call'); room = act(room, 'call');
    expect(room.hand?.actorId).toBe('p0');
    expect(legalActions(room, 'p0')).toMatchObject({ canRaise: false, callAmount: 15, minRaiseTo: 115 });
    expect(() => act(room, 'raise', 115)).toThrow('reopen');
    room = act(room, 'call');
    expect(room.hand?.street).toBe('flop');
  });
  test('cumulative short all-ins reopen after a full raise is faced', () => {
    let room = start(table([1000, 75, 100, 1000]));
    room = act(room, 'call'); room = act(room, 'raise', 60);
    room = act(room, 'raise', 75); room = act(room, 'raise', 100); room = act(room, 'call');
    expect(room.hand?.actorId).toBe('p0');
    expect(legalActions(room, 'p0')).toMatchObject({ canRaise: true, minRaiseTo: 140 });
    room = act(room, 'raise', 140);
    expect(room.hand?.currentBet).toBe(140);
  });
  test('a sub-minimum opening all-in still requires a full increment above it', () => {
    let room = start(table([1000, 30, 1000]));
    room = act(room, 'call'); room = act(room, 'call'); room = act(room, 'check');
    expect(room.hand?.actorId).toBe('p1');
    room = act(room, 'raise', 10);
    expect(legalActions(room, 'p2').minRaiseTo).toBe(30);
    expect(() => act(room, 'raise', 20)).toThrow('minimum');
    room = act(room, 'raise', 30);
    expect(room.hand?.minRaise).toBe(20);
  });
  test('heads-up short blind automatically runs out with no artificial wager', () => {
    const room = start(table([5, 100]));
    expect(room.hand?.street).toBe('complete');
    expect(room.hand?.awardedPot).toBe(10);
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(105);
    const room2 = start(table([100, 5]));
    expect(room2.hand?.street).toBe('complete');
    expect(room2.hand?.awardedPot).toBe(10);
  });
  test('short big blind retains the normal bring-in when two players can still bet', () => {
    const room = start(table([1000, 1000, 5]));
    expect(room.hand?.street).toBe('preflop');
    expect(legalActions(room, 'p0')).toMatchObject({ callAmount: 20, minRaiseTo: 40, canRaise: true });
  });
  test('all-in antes do not manufacture negative blind stacks', () => {
    const room = start(table([1, 2, 3], { smallBlind: 1, bigBlind: 2, ante: 2 }));
    expect(room.hand?.street).toBe('complete');
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(6);
    expect(room.hand?.pot).toBe(0);
  });
  test('side pots go only to eligible players and unmatched wagers return', () => {
    const deck = rig(['Kc', 'Qc', 'Ac', 'Kd', 'Qd', 'Ad', '2s', '2c', '3d', '7h', '4s', '9c', '5s', 'Ts']);
    let room = start(table([100, 200, 300], { smallBlind: 5, bigBlind: 10 }), deck);
    room = act(room, 'raise', 100); room = act(room, 'raise', 200);
    expect(legalActions(room, 'p2').canRaise).toBe(false);
    room = act(room, 'call');
    expect(room.hand?.street).toBe('complete');
    expect(room.hand?.results.map(pot => [pot.amount, pot.winners])).toEqual([[300, ['p0']], [200, ['p1']]]);
    expect(room.players.map(player => player.stack)).toEqual([300, 200, 100]);

    let second = start(table([300, 200, 100], { smallBlind: 5, bigBlind: 10 }), deck);
    second = act(second, 'raise', 300); second = act(second, 'call'); second = act(second, 'call');
    expect(second.hand?.awardedPot).toBe(500);
    expect(second.events.some(event => event.kind === 'refund' && event.message.includes('100'))).toBe(true);
    expect(stack(second, 'p0')).toBe(600);
  });
  test('split pots include folded contributions and odd chips go left of the button', () => {
    let room = start(table([50, 50, 50], { smallBlind: 1, bigBlind: 2, ante: 1 }),
      rig(['2c', '3c', '4c', '5d', '6d', '7d', '8c', 'Th', 'Jh', 'Qh', '9c', 'Kh', 'Tc', 'Ah']));
    room = act(room, 'call'); room = act(room, 'call'); room = act(room, 'check');
    room = act(room, 'check'); room = act(room, 'fold'); room = act(room, 'check');
    room = checkDown(room);
    expect(room.hand?.results[0]?.shares).toEqual({ p1: 5, p0: 4 });
    expect(room.players.map(player => player.stack)).toEqual([51, 52, 47]);
    expect(room.hand?.revealed.p2).toBeUndefined();
  });
  test('uncontested hand ends immediately without leaking cards', () => {
    let room = start(table());
    room = act(room, 'fold');
    expect(room.hand).toMatchObject({ street: 'complete', board: [], revealed: {}, showdown: false, awardedPot: 20 });
    expect(stack(room, 'p1')).toBe(1010);
    const view = roomView(room, 'p0', new Set());
    expect(view.players.find(player => player.id === 'p1')?.cards).toEqual([null, null]);
  });
  test('private views never contain opponents cards, future deck, or burns', () => {
    const room = start(table([1000, 1000, 1000]));
    const view = roomView(room, 'p0', new Set(['p0']));
    expect(view.hand).not.toHaveProperty('deck');
    expect(view.hand).not.toHaveProperty('burned');
    expect(view.hand).not.toHaveProperty('holeCards');
    expect(view.players[0]?.cards).toEqual(room.hand?.holeCards.p0);
    for (const card of [...room.hand!.deck, ...room.hand!.holeCards.p1!, ...room.hand!.holeCards.p2!])
      expect(JSON.stringify(view)).not.toContain(`"${card}"`);
  });
  test('pot-fraction and big-blind presets are legal raise-to amounts', () => {
    const room = start(table()); const legal = legalActions(room, 'p0');
    expect(presetRaise(legal, 10, 20, { bb: 3 })).toBe(60);
    expect(presetRaise(legal, 10, 20, { pot: 0.5 })).toBe(40);
    expect(presetRaise(legal, 10, 20, { pot: 0.75 })).toBe(50);
    expect(presetRaise(legal, 10, 20, { pot: 1 })).toBe(60);
    expect(presetRaise({ ...legal, maxRaiseTo: 31 }, 10, 20, { bb: 3 })).toBe(31);
  });
});

describe('session accounting and controls', () => {
  test('guest buy-ins require approval and duplicate requests cannot multiply funds', () => {
    let room = table([1000]);
    room = apply(room, 'p1', { type: 'join', name: 'Guest' });
    room = apply(room, 'p1', { type: 'fund', amount: 400 });
    expect(stack(room, 'p1')).toBe(0);
    expect(() => apply(room, 'p1', { type: 'fund', amount: 400 })).toThrow('waiting');
    expect(() => apply(room, 'p1', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true })).toThrow('host');
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    expect(stack(room, 'p1')).toBe(400);
    expect(room.players[1]?.buyIns).toBe(400);
  });
  test('add-ons wait until hand settlement and are included exactly once', () => {
    let room = start(table());
    const before = stack(room, 'p0');
    room = apply(room, 'p0', { type: 'fund', amount: 100 });
    expect(stack(room, 'p0')).toBe(before);
    expect(room.requests.at(-1)?.status).toBe('approved');
    room = act(room, 'fold');
    expect(stack(room, 'p0')).toBe(1090);
    expect(room.players[0]?.addOnCount).toBe(1);
    expect(room.players[0]?.buyIns).toBe(1100);
  });
  test('queued rebuy declines if the all-in player wins chips back', () => {
    let room = start(table([100, 1000, 1000]),
      rig(['Kc', 'Qc', 'Ac', 'Kd', 'Qd', 'Ad', '2s', '2c', '3d', '7h', '4s', '9c', '5s', 'Ts']));
    room = act(room, 'raise', 100);
    room = apply(room, 'p0', { type: 'fund', amount: 100 });
    room = checkDown(room);
    expect(room.requests.at(-1)?.status).toBe('declined');
    expect(room.players[0]?.buyIns).toBe(100);
  });
  test('rebuy, sit-out, cash-out, and rejoin preserve one session identity', () => {
    let room = table();
    room = apply(room, 'p1', { type: 'cash_out' });
    expect(room.players[1]).toMatchObject({ seat: null, stack: 0, cashOuts: 1000 });
    room = apply(room, 'p1', { type: 'join', name: 'Player 1' });
    room = apply(room, 'p1', { type: 'fund', amount: 500 });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    expect(room.players).toHaveLength(2);
    expect(room.players[1]).toMatchObject({ stack: 500, buyIns: 1500, cashOuts: 1000, rebuyCount: 1 });
    room = apply(room, 'p1', { type: 'sit_out', value: true });
    expect(() => start(room)).toThrow('Two funded');
    room = apply(room, 'p1', { type: 'sit_out', value: false });
    room = start(room);
    expect(() => apply(room, 'p1', { type: 'cash_out' })).toThrow('between hands');
  });
  test('pause stops turn deadlines, settings defer blinds, session close settles everyone', () => {
    let room = start(table());
    room = apply(room, 'p0', { type: 'pause', value: true });
    expect(room.hand?.deadline).toBeNull();
    expect(() => act(room, 'call')).toThrow('paused');
    room = apply(room, 'p0', { type: 'settings', smallBlind: 25, bigBlind: 50, ante: 1, autoDeal: true, turnSeconds: 30, allowRebuys: true });
    expect(room.settings.bigBlind).toBe(20);
    expect(room.pendingBlinds?.bigBlind).toBe(50);
    room = apply(room, 'p0', { type: 'pause', value: false });
    room = apply(room, 'p0', { type: 'close' });
    expect(room.status).toBe('open');
    room = act(room, 'fold');
    expect(room.status).toBe('closed');
    expect(room.players.every(player => player.stack === 0)).toBe(true);
    expect(room.players.reduce((sum, player) => sum + player.cashOuts, 0)).toBe(2000);
    expect(() => apply(room, 'p0', { type: 'fund', amount: 100 })).toThrow('closed');
  });
  test('timeouts check or fold but never silently spend chips', () => {
    let room = start(table());
    expect(timeoutTurn(room, room.hand!.deadline! - 1)).toBeNull();
    const timed = timeoutTurn(room, room.hand!.deadline! + 1)!;
    verifyTransfers(room, timed.room, timed.transfers);
    expect(timed.room.hand?.street).toBe('complete');
    expect(timed.room.players[0]?.timeoutCount).toBe(1);
    room = start(timed.room);
    room = act(room, 'call');
    expect(room.hand?.actorId).toBe('p0');
    const second = timeoutTurn(room, room.hand!.deadline! + 1)!;
    expect(second.room.players[0]?.timeoutCount).toBe(2);
    expect(second.room.players[0]?.sittingOut).toBe(true);
    expect(second.events[0]?.message).toContain('checked');
  });
  test('a delayed scheduler never lets an expired human or bot turn spend chips', () => {
    const room = start(table());
    for (const system of [false, true]) {
      for (const action of ['call', 'raise'] as const) {
        expect(() => transition(room, 'p0', { type: 'act', action, amount: 100 },
          { now: room.hand!.deadline! + 1, system })).toThrow('turn clock expired');
      }
    }
    expect(stack(room, 'p0')).toBe(990);
    const result = timeoutTurn(room, room.hand!.deadline! + 1)!;
    verifyTransfers(room, result.room, result.transfers);
    expect(result.room.hand?.street).toBe('complete');
  });
  test('bot join is logged once and its virtual funding balances', () => {
    const before = table([1000]);
    const after = apply(before, 'p0', { type: 'add_bot' });
    expect(after.version).toBe(before.version + 1);
    expect(after.events.filter(event => event.kind === 'join')).toHaveLength(2);
    expect(new Set(after.events.map(event => event.id)).size).toBe(after.events.length);
    expect(after.players[1]?.bot).toBe(true);
  });
  test('lifetime funding cannot create a pot or payout larger than the supported chip limit', () => {
    let room = table([10000000], { maxBuyIn: 10000000 });
    for (let i = 1; i < 100; i++) {
      room = apply(room, 'p0', { type: 'cash_out' });
      room = apply(room, 'p0', { type: 'join', name: 'Player 0' });
      room = apply(room, 'p0', { type: 'fund', amount: 10000000 });
    }
    room = apply(room, 'p0', { type: 'cash_out' });
    room = apply(room, 'p0', { type: 'join', name: 'Player 0' });
    expect(() => apply(room, 'p0', { type: 'fund', amount: 1 })).toThrow('lifetime funding limit');
    room = apply(room, 'p0', { type: 'close' });
    expect(room.status).toBe('closed');
    expect(room.players[0]?.cashOuts).toBe(1000000000);
  });
  test('300 simulated multiway hands conserve chips and only generate legal bot actions', () => {
    let seed = 32767;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let game = 0; game < 300; game++) {
      const count = 2 + game % 8;
      let room = start(table(Array.from({ length: count }, () => 20 + Math.floor(rand() * 2000)), { ante: game % 4 }));
      let turns = 0;
      while (room.hand?.street !== 'complete') {
        if (++turns > 300) throw new Error(`Unfinished hand in simulation ${game}`);
        const actor = room.hand!.actorId!;
        const legal = legalActions(room, actor);
        const roll = rand();
        if (game % 3 === 0) room = apply(room, actor, chooseBotAction(roomView(room, actor, new Set())));
        else if (roll < .15) room = act(room, 'fold');
        else if (roll < .42 && legal.canRaise) room = act(room, 'raise', rand() < .4 ? legal.maxRaiseTo : Math.min(legal.maxRaiseTo, legal.minRaiseTo));
        else room = act(room, legal.canCheck ? 'check' : 'call');
      }
      expect(room.hand.pot).toBe(0);
      expect(room.players.every(player => Number.isInteger(player.stack) && player.stack >= 0)).toBe(true);
    }
  }, 30000);
});
