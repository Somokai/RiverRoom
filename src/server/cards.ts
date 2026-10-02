import { randomInt } from 'node:crypto';
import type { Card } from '../shared/model.js';

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const makeDeck = (): Card[] => [...SUITS].flatMap(suit => [...RANKS].map(rank => rank + suit));

export function shuffleDeck(): Card[] {
  const deck = makeDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = deck[i];
    const b = deck[j];
    if (!a || !b) throw new Error('Invalid deck.');
    deck[i] = b;
    deck[j] = a;
  }
  return deck;
}

const labels = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
export interface HandRank { score: number; category: number; label: string; cards: Card[] }

function rankFive(cards: Card[]): HandRank {
  const ranks = cards.map(card => RANKS.indexOf(card[0] ?? '') + 2).sort((a, b) => b - a);
  const frequencies = new Map<number, number>();
  for (const rank of ranks) frequencies.set(rank, (frequencies.get(rank) ?? 0) + 1);
  const groups = [...frequencies].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(card => card[1] === cards[0]?.[1]);
  const unique = [...new Set(ranks)];
  const straight = unique.length === 5 && (unique[0]! - unique[4]! === 4
    ? unique[0]! : unique.join(',') === '14,5,4,3,2' ? 5 : 0);
  let category = 0;
  let kickers = ranks;
  if (flush && straight) { category = 8; kickers = [straight]; }
  else if (groups[0]?.[1] === 4) { category = 7; kickers = [groups[0][0], groups[1]![0]]; }
  else if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) { category = 6; kickers = [groups[0][0], groups[1][0]]; }
  else if (flush) category = 5;
  else if (straight) { category = 4; kickers = [straight]; }
  else if (groups[0]?.[1] === 3) { category = 3; kickers = groups.map(group => group[0]); }
  else if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) { category = 2; kickers = groups.map(group => group[0]); }
  else if (groups[0]?.[1] === 2) { category = 1; kickers = groups.map(group => group[0]); }
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);
  return { score, category, label: category === 8 && straight === 14 ? 'Royal flush' : labels[category]!, cards };
}

export function evaluate(cards: Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length ||
      cards.some(card => !/^[2-9TJQKA][cdhs]$/.test(card))) throw new Error('A hand needs five to seven distinct valid cards.');
  let best: HandRank | null = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const hand = rankFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || hand.score > best.score) best = hand;
          }
  if (!best) throw new Error('Unable to evaluate the hand.');
  return best;
}

export function evaluateOmaha(holeCards: Card[], board: Card[]): HandRank {
  const cards = [...holeCards, ...board];
  if (holeCards.length !== 4 || board.length < 3 || board.length > 5 ||
      new Set(cards).size !== cards.length || cards.some(card => !/^[2-9TJQKA][cdhs]$/.test(card)))
    throw new Error('Omaha needs four hole cards and three to five distinct valid board cards.');
  let best: HandRank | null = null;
  for (let a = 0; a < holeCards.length - 1; a++)
    for (let b = a + 1; b < holeCards.length; b++)
      for (let c = 0; c < board.length - 2; c++)
        for (let d = c + 1; d < board.length - 1; d++)
          for (let e = d + 1; e < board.length; e++) {
            const hand = rankFive([holeCards[a]!, holeCards[b]!, board[c]!, board[d]!, board[e]!]);
            if (!best || hand.score > best.score) best = hand;
          }
  if (!best) throw new Error('Unable to evaluate the Omaha hand.');
  return best;
}

export function evaluateIndian(card: Card): HandRank {
  if (!/^[2-9TJQKA][cdhs]$/.test(card)) throw new Error('Indian poker needs one valid card.');
  const rank = RANKS.indexOf(card[0]!) + 2;
  const name = ({ T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' } as Record<string, string>)[card[0]!] ?? card[0]!;
  return { score: rank, category: 0, label: `${name} high`, cards: [card] };
}
