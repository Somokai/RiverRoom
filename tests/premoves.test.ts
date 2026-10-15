import { describe, expect, test } from 'vitest';
import { canPremove, resolvePremove, type Premove } from '../src/client/premoves';
import { DEFAULT_SETTINGS, type Command, type Room } from '../src/shared/model';
import { assertRoom, createRoom, roomView, transition } from '../src/server/engine';
import { verifyTransfers } from '../src/server/store';

let now = 1_800_000_000_000;
function apply(room: Room, actor: string, command: Command) {
  const result = transition(room, actor, command, { now: ++now });
  assertRoom(result.room); verifyTransfers(room, result.room, result.transfers);
  return result.room;
}
function table(stacks = [1000, 1000]) {
  let room = createRoom({
    id: 'premoves', code: 'PREMOVE1', name: 'Premove table', hostId: 'p0', hostName: 'Player 0', buyIn: stacks[0]!,
    settings: { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, minBuyIn: 1, autoDeal: false },
  }, { now: ++now }).room;
  for (let i = 1; i < stacks.length; i++) {
    room = apply(room, `p${i}`, { type: 'join', name: `Player ${i}` });
    room = apply(room, `p${i}`, { type: 'fund', amount: stacks[i]! });
    room = apply(room, 'p0', { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
  }
  return apply(room, 'p0', { type: 'deal' });
}
const view = (room: Room, you = 'p1') => roomView(room, you, new Set(), now);
const queue = (room: Room, action: Premove['action'], youId = 'p1'): Premove => ({
  action, roomId: room.id, handId: room.hand!.id, street: room.hand!.street, youId,
});

describe('private browser premove intentions', () => {
  test.each(['check', 'check_fold'] as const)('%s waits and then checks only when the server allows it', action => {
    const initial = table();
    const premove = queue(initial, action);
    expect(canPremove(view(initial))).toBe(true);
    expect(resolvePremove(premove, view(initial), true)).toBe('wait');
    const turn = apply(initial, 'p0', { type: 'act', action: 'call' });
    expect(resolvePremove(premove, view(turn), true)).toBe('check');
    expect(initial.hand?.actorId).toBe('p0');
  });

  test('check cancels immediately after a raise, even before its owner has the turn; check/fold remains queued', () => {
    const initial = table([1000, 1000, 1000]);
    const check = queue(initial, 'check', 'p2');
    const checkFold = queue(initial, 'check_fold', 'p2');
    const raised = apply(initial, 'p0', { type: 'act', action: 'raise', amount: 60 });
    expect(raised.hand?.actorId).toBe('p1');
    expect(resolvePremove(check, view(raised, 'p2'), true)).toBe('cancel');
    expect(resolvePremove(checkFold, view(raised, 'p2'), true)).toBe('wait');
    const turn = apply(raised, 'p1', { type: 'act', action: 'call' });
    expect(resolvePremove(checkFold, view(turn, 'p2'), true)).toBe('fold');
    expect(resolvePremove(check, view(turn, 'p2'), true)).toBe('cancel');
  });

  test('a premove never carries into a different street, hand, room, or identity', () => {
    const initial = table();
    const premove = queue(initial, 'check_fold');
    const called = apply(initial, 'p0', { type: 'act', action: 'call' });
    const flop = apply(called, 'p1', { type: 'act', action: 'check' });
    expect(flop.hand?.actorId).toBe('p1');
    expect(resolvePremove(premove, view(flop), true)).toBe('cancel');
    const complete = apply(initial, 'p0', { type: 'act', action: 'fold' });
    expect(resolvePremove(premove, view(complete), true)).toBe('cancel');
    const next = apply(complete, 'p0', { type: 'deal' });
    expect(resolvePremove(premove, view(next), true)).toBe('cancel');
    expect(resolvePremove(premove, { ...view(initial), id: 'other-room' }, true)).toBe('cancel');
    expect(resolvePremove(premove, view(initial, 'p0'), true)).toBe('cancel');
  });

  test('disconnects, pauses, folds, closed sessions, and players with no chips invalidate a selection', () => {
    const initial = table();
    const premove = queue(initial, 'check_fold');
    expect(resolvePremove(premove, view(initial), false)).toBe('cancel');
    expect(resolvePremove(premove, view(apply(initial, 'p0', { type: 'pause', value: true })), true)).toBe('cancel');
    const ended = apply(initial, 'p0', { type: 'act', action: 'fold' });
    expect(canPremove(view(apply(ended, 'p0', { type: 'close' })))).toBe(false);
    const allIn = table([1000, 20]);
    expect(canPremove(view(allIn))).toBe(false);
    expect(resolvePremove(queue(allIn, 'check_fold'), view(allIn), true)).toBe('cancel');
    const three = table([1000, 1000, 1000]);
    const folded = apply(three, 'p0', { type: 'act', action: 'fold' });
    expect(canPremove(view(folded, 'p0'))).toBe(false);
  });

  test('spectators and all-in runout decisions never offer premoves', () => {
    let room = table();
    room = apply(room, 'watcher', { type: 'join', name: 'Observer' });
    expect(canPremove(view(room, 'watcher'))).toBe(false);
    room = apply(room, 'p0', { type: 'next_hand', rules: { ...room.nextHandRules, maxRunouts: 3 } });
    room = apply(room, 'p0', { type: 'act', action: 'fold' });
    room = apply(room, 'p0', { type: 'deal' });
    room = apply(room, room.hand!.actorId!, { type: 'act', action: 'raise', amount: 990 });
    room = apply(room, room.hand!.actorId!, { type: 'act', action: 'call' });
    expect(room.hand?.runoutVote).not.toBeNull();
    expect(canPremove(view(room))).toBe(false);
  });
});
