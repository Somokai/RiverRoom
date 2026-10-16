import { evaluate, evaluateIndian, evaluateOmaha, RANKS, type HandRank } from '../shared/handEvaluation';
import { boardRuns, isIndian, isLegacyIndianHand, isOmaha, type Card, type HandView, type RoomView } from '../shared/model';
import { boardCardKey, holeCardKey } from './tableMotion';

const rankNames = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
const pluralRanks = ['twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
const rankValue = (card: Card) => RANKS.indexOf(card[0]!);
const name = (card: Card) => rankNames[rankValue(card)]!;
const plural = (card: Card) => pluralRanks[rankValue(card)]!;
const capitalize = (value: string) => value[0]!.toUpperCase() + value.slice(1);

export function orderedHandCards(rank: HandRank): Card[] {
  const counts = new Map<string, number>();
  for (const card of rank.cards) counts.set(card[0]!, (counts.get(card[0]!) ?? 0) + 1);
  const wheel = (rank.category === 4 || rank.category === 8) &&
    rank.cards.some(card => card[0] === 'A') && rank.cards.some(card => card[0] === '5');
  const value = (card: Card) => wheel && card[0] === 'A' ? -1 : rankValue(card);
  return [...rank.cards].sort((a, b) => (counts.get(b[0]!)! - counts.get(a[0]!)!) || value(b) - value(a));
}

export function describeHand(rank: HandRank): string {
  if (rank.cards.length === 1) return rank.label;
  const cards = orderedHandCards(rank);
  const top = cards[0]!;
  switch (rank.category) {
    case 0: return `${capitalize(name(top))} high`;
    case 1: return `Pair of ${plural(top)}`;
    case 2: return `Two pair, ${plural(top)} and ${plural(cards[2]!)}`;
    case 3: return `Three of a kind, ${plural(top)}`;
    case 4: return `Straight, ${name(top)} high`;
    case 5: return `Flush, ${name(top)} high`;
    case 6: return `Full house, ${plural(top)} full of ${plural(cards[3]!)}`;
    case 7: return `Four of a kind, ${plural(top)}`;
    case 8: return rank.label === 'Royal flush' ? rank.label : `Straight flush, ${name(top)} high`;
    default: throw new Error('Unknown hand category.');
  }
}

function rankVisible(hand: HandView, hole: Card[], board: Card[]): HandRank {
  return isLegacyIndianHand(hand) ? evaluateIndian(hole[0]!)
    : isOmaha(hand.rules) ? evaluateOmaha(hole, board) : evaluate([...hole, ...board]);
}

export function currentHands(room: RoomView): Array<{ boardIndex: number; description: string }> {
  const hand = room.hand;
  const hero = room.players.find(player => player.id === room.youId);
  if (!hand || hand.street === 'complete' || !hero?.hand || hero.hand.folded || isIndian(hand.rules) ||
      hero.cards.some(card => card === null)) return [];
  const hole = hero.cards.filter((card): card is Card => card !== null);
  if (hole.length !== (isOmaha(hand.rules) ? 4 : 2)) return [];
  return hand.boards.map((board, boardIndex) => {
    if (board.length >= 3) return { boardIndex, description: describeHand(rankVisible(hand, hole, board)) };
    if (isOmaha(hand.rules)) return { boardIndex, description: 'Omaha hand forms on the flop' };
    return { boardIndex, description: hole[0]![0] === hole[1]![0]
      ? `Pair of ${plural(hole[0]!)}` : `${capitalize(name([...hole].sort((a, b) => rankValue(b) - rankValue(a))[0]!))} high` };
  });
}

export interface WinningHand {
  key: string;
  playerId: string;
  runoutIndex: number;
  boardIndex: number;
  amount: number;
  pots: number[];
  split: boolean;
  description: string;
  cards: Array<{ card: Card; source: string; hole: boolean }>;
  playsBoard: boolean;
}

export function winningHands(room: RoomView): WinningHand[] {
  const hand = room.hand;
  if (!hand || hand.street !== 'complete') return [];
  const wins = new Map<string, WinningHand>();
  const runs = boardRuns(hand);
  for (const result of hand.results) {
    for (const playerId of result.winners) {
      const key = `${result.runoutIndex}:${result.boardIndex}:${playerId}`;
      const previous = wins.get(key);
      if (previous) {
        previous.amount += result.shares[playerId] ?? 0;
        previous.pots.push(result.potIndex);
        previous.split ||= result.winners.length > 1;
        continue;
      }
      const board = runs[result.runoutIndex]?.[result.boardIndex] ?? [];
      const publicCards = hand.revealed[playerId] ?? [];
      const expected = isLegacyIndianHand(hand) ? 1 : isOmaha(hand.rules) ? 4 : 2;
      // Never use even the viewer's private cards to explain an unrevealed win.
      const rank = hand.showdown && result.description !== 'Uncontested' && publicCards.length === expected
        ? rankVisible(hand, publicCards, board) : null;
      const player = room.players.find(item => item.id === playerId);
      const cards = rank ? orderedHandCards(rank).map(card => {
        const boardIndex = board.indexOf(card);
        const hole = boardIndex < 0;
        return { card, hole, source: hole ? holeCardKey(playerId, player?.cards.indexOf(card) ?? -1)
          : boardCardKey(result.runoutIndex, result.boardIndex, boardIndex) };
      }) : [];
      wins.set(key, {
        key, playerId, runoutIndex: result.runoutIndex, boardIndex: result.boardIndex,
        amount: result.shares[playerId] ?? 0, pots: [result.potIndex], split: result.winners.length > 1,
        description: rank ? describeHand(rank) : result.description,
        cards, playsBoard: cards.length === 5 && cards.every(card => !card.hole),
      });
    }
  }
  return [...wins.values()].sort((a, b) => a.runoutIndex - b.runoutIndex || a.boardIndex - b.boardIndex);
}
