import { randomInt } from 'node:crypto';
import type { Command, RoomView } from '../shared/model.js';
import { isLegacyIndianHand, presetRaise } from '../shared/model.js';
import { evaluate, evaluateOmaha, makeDeck, RANKS } from './cards.js';

// A bot only receives a redacted view; in Indian poker even its own cards are hidden.
export function chooseBotAction(
  view: RoomView,
  random: () => number = () => randomInt(10000) / 10000,
): Extract<Command, { type: 'act' }> {
  const legal = view.legal;
  const hand = view.hand;
  const player = view.players.find(item => item.id === view.youId);
  if (!hand || !player || !legal.canAct) throw new Error('Bot is not ready to act.');
  const cards = player.cards.filter((card): card is string => card !== null);
  const omaha = hand.rules.game === 'omaha' || hand.rules.game === 'omaha_bomb';
  const draw = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Bot randomness must be between 0 (inclusive) and 1 (exclusive).');
    return value;
  };
  let strength = 0.3;
  if (hand.rules.game === 'indian' && !isLegacyIndianHand(hand)) {
    const opponents = view.players.filter(item => item.id !== view.youId && item.hand);
    const live = opponents.filter(item => !item.hand!.folded);
    if (!live.length || opponents.some(item => item.cards.length !== 2 || item.cards.some(card => card === null)))
      throw new Error('Indian poker bot needs the visible opponent hands.');
    const visible = new Set([...hand.board, ...opponents.flatMap(item => item.cards)]);
    const unseen = makeDeck().filter(card => !visible.has(card));
    let equity = 0;
    // Sample only unknown cards consistent with this public view, never the server's deck.
    for (let sample = 0; sample < 24; sample++) {
      const deck = [...unseen];
      for (let index = 0; index < 7 - hand.board.length; index++) {
        const picked = index + Math.floor(draw() * (deck.length - index));
        [deck[index], deck[picked]] = [deck[picked]!, deck[index]!];
      }
      const board = [...hand.board, ...deck.slice(2, 7 - hand.board.length)];
      const own = evaluate([...deck.slice(0, 2), ...board]).score;
      const others = live.map(item => evaluate([...item.cards.filter((card): card is string => card !== null), ...board]).score);
      const best = Math.max(own, ...others);
      if (own === best) equity += 1 / (1 + others.filter(score => score === best).length);
    }
    strength = equity / 24;
  } else if (isLegacyIndianHand(hand)) {
    const opponents = view.players.filter(item => item.id !== view.youId && item.hand);
    const seen = opponents.flatMap(item => item.cards).filter((card): card is string => card !== null);
    const liveRanks = opponents.filter(item => !item.hand!.folded)
      .flatMap(item => item.cards).filter((card): card is string => card !== null).map(card => RANKS.indexOf(card[0]!));
    const highest = Math.max(-1, ...liveRanks);
    const tied = liveRanks.filter(rank => rank === highest).length;
    let winningCards = 0;
    for (let rank = 0; rank < RANKS.length; rank++) {
      const remaining = 4 - seen.filter(card => RANKS.indexOf(card[0]!) === rank).length;
      if (rank > highest) winningCards += remaining;
      else if (rank === highest) winningCards += remaining / (tied + 1);
    }
    strength = winningCards / (52 - seen.length);
  } else if (hand.board.length >= 3) {
    const strengths = hand.boards.map(board => {
      const rank = omaha ? evaluateOmaha(cards, board) : evaluate([...cards, ...board]);
      return [0.18, 0.44, 0.64, 0.76, 0.84, 0.9, 0.95, 0.98, 0.995][rank.category]!;
    });
    strength = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
  } else {
    const pairs: number[] = [];
    for (let a = 0; a < cards.length - 1; a++)
      for (let b = a + 1; b < cards.length; b++) {
        const first = RANKS.indexOf(cards[a]![0]!);
        const second = RANKS.indexOf(cards[b]![0]!);
        let value = 0.16 + (first + second) / 52;
        if (first === second) value += 0.22;
        if (cards[a]![1] === cards[b]![1]) value += 0.06;
        if (Math.abs(first - second) === 1) value += 0.04;
        pairs.push(value);
      }
    strength = Math.max(...pairs);
  }
  const roll = draw();
  const odds = legal.toCall / Math.max(1, hand.pot + legal.toCall);
  if (legal.canRaise && ((strength > 0.6 && roll < 0.38) || roll < 0.035)) {
    return { type: 'act', action: 'raise', amount: presetRaise(legal, player.hand?.streetBet ?? 0, view.settings.bigBlind,
      hand.street === 'preflop' ? { bb: 3 } : { pot: strength > 0.8 ? 0.75 : 0.5 }) };
  }
  if (legal.canCheck) return { type: 'act', action: 'check' };
  if (odds < strength * 0.75 || (legal.toCall <= view.settings.bigBlind && roll < 0.85))
    return { type: 'act', action: 'call' };
  return { type: 'act', action: 'fold' };
}
