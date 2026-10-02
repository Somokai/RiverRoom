import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, defaultHandRules, type GameVariant, type LedgerRow, type Room } from '../src/shared/model';
import { createRoom, roomView, transition } from '../src/server/engine';
import { assertAccounting, assertPrivateView, optionsFrom, testAction } from '../src/testing/run-bots';

function fixture(game: GameVariant = 'holdem') {
  const now = Date.now();
  const initial = createRoom({
    id: 'test-room', code: 'TEST1234', name: 'Harness fixture', hostId: 'host', hostName: 'Host',
    settings: { ...DEFAULT_SETTINGS, autoDeal: false }, buyIn: 10000,
  }, { now });
  const withBot = transition(initial.room, 'host', { type: 'add_bot' }, { now });
  const configured = transition(withBot.room, 'host', { type: 'next_hand', rules: { ...defaultHandRules(), game } }, { now });
  const dealt = transition(configured.room, 'host', { type: 'deal' }, { now });
  const ledger: LedgerRow[] = [...initial.transfers, ...withBot.transfers, ...dealt.transfers].map((entry, index) => ({
    ...entry, id: index + 1, at: new Date(now).toISOString(), transactionId: `test:${index}`,
  }));
  return { room: dealt.room, ledger };
}

describe('local bot harness checks', () => {
  test('bounds workload and only exposes isolated-local options', () => {
    expect(optionsFrom([])).toMatchObject({ players: 6, hands: 24, nativeHands: 3, delayMs: 125 });
    expect(optionsFrom(['--games', 'holdem,omaha,omaha_bomb,indian', '--max-runouts', '3', '--bounty', '200']))
      .toMatchObject({ games: ['holdem', 'omaha', 'omaha_bomb', 'indian'], maxRunouts: 3, bounty: 200 });
    for (const args of [['--players', '10'], ['--hands', '0'], ['--hands', '2.5'], ['--action-delay-ms', '0'], ['--output', 'data.db'], ['--url', 'https://example.com'],
      ['--games', 'unknown'], ['--max-runouts', '4'], ['--bounty', '-1']])
      expect(() => optionsFrom(args)).toThrow();
  });
  test('independently reconciles chip and currency transfers against the public snapshot', () => {
    const { room, ledger } = fixture();
    const view = roomView(room, 'host', new Set());
    expect(() => assertAccounting(view, ledger)).not.toThrow();
    expect(() => assertAccounting(view, ledger.slice(1))).toThrow();
    expect(() => assertAccounting(view, [...ledger, ledger[0]!])).toThrow('Duplicate');
    const wrong = structuredClone(view); wrong.players[0]!.stack++;
    expect(() => assertAccounting(wrong, ledger)).toThrow();
    const badCurrency = structuredClone(ledger); badCurrency[0]!.cashCents++;
    expect(() => assertAccounting(view, badCurrency)).toThrow('currency');
    const swappedFunding = structuredClone(view);
    swappedFunding.players[0]!.buyIns++; swappedFunding.players[1]!.buyIns--;
    expect(() => assertAccounting(swappedFunding, ledger)).toThrow('funding');
    const counter = structuredClone(view); counter.players[0]!.rebuyCount++;
    expect(() => assertAccounting(counter, ledger)).toThrow('rebuy');
  });
  test('detects private-card leaks without exposing cards in failure messages', () => {
    const { room } = fixture();
    const view = roomView(room, 'host', new Set());
    expect(() => assertPrivateView(view, 'host')).not.toThrow();
    const leaked = structuredClone(view); leaked.players[1]!.cards = ['As', 'Kd'];
    expect(() => assertPrivateView(leaked, 'host')).toThrow('unrevealed');
    expect(() => assertPrivateView(view, 'other-user')).toThrow('identity');
    const privateFields = structuredClone(view);
    Object.assign(privateFields.hand!, { deck: ['Ac'] });
    expect(() => assertPrivateView(privateFields, 'host')).toThrow('Private deck');
    const premature = structuredClone(view); premature.hand!.revealed[premature.players[1]!.id] = ['As', 'Kd'];
    expect(() => assertPrivateView(premature, 'host')).toThrow('before a completed showdown');
  });
  test('scripted test policies submit actual legal intentions, never stack edits', () => {
    const { room } = fixture();
    for (const handNumber of [1, 2, 3, 4, 5, 6]) {
      const current: Room = structuredClone(room);
      current.hand!.number = handNumber;
      const actor = current.hand!.actorId!;
      const command = testAction(roomView(current, actor, new Set()));
      expect(command.type).toBe('act');
      expect(() => transition(current, actor, command, { now: Date.now() })).not.toThrow();
    }
  });
  test.each(['omaha', 'omaha_bomb', 'indian'] as const)('privacy checks respect the %s card-visibility contract', game => {
    const { room, ledger } = fixture(game);
    for (const player of room.players) {
      const view = roomView(room, player.id, new Set());
      expect(() => assertPrivateView(view, player.id)).not.toThrow();
      expect(() => assertAccounting(view, ledger)).not.toThrow();
      if (game === 'indian') {
        expect(view.players.find(item => item.id === player.id)?.cards).toEqual([null, null]);
        const leaked = structuredClone(view);
        leaked.players.find(item => item.id === player.id)!.cards = room.hand!.holeCards[player.id]!;
        expect(() => assertPrivateView(leaked, player.id)).toThrow('own hidden card');
      }
    }
  });
});
