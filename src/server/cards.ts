import { randomInt } from 'node:crypto';
import type { Card } from '../shared/model.js';
import { RANKS } from '../shared/handEvaluation.js';

export { RANKS, evaluate, evaluateOmaha, evaluateIndian, type HandRank } from '../shared/handEvaluation.js';
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
