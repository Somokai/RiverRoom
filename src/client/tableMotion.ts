import { boardRuns, handAnte, type HandView, type RoomView } from '../shared/model';

export const CHIP_FLIGHT_MS = 560;
export const CARD_FLIGHT_MS = 420;
export const CARD_REVEAL_MS = 240;
export const holeCardKey = (playerId: string, index: number) => `hole:${playerId}:${index}`;
export const boardCardKey = (run: number, board: number, index: number) => `board:${run}:${board}:${index}`;

export type ChipLocation = 'stack' | 'wager' | 'pot';
export interface ChipMotion {
  kind: 'bet' | 'ante' | 'collect' | 'refund' | 'payout';
  playerId: string;
  amount: number;
  delay: number;
  from: ChipLocation;
  to: ChipLocation;
}
export interface CardMotion {
  kind: 'deal' | 'reveal';
  key: string;
  delay: number;
}
export interface TableMotionPlan {
  chips: ChipMotion[];
  cards: CardMotion[];
}

const betting = (hand: HandView | null) => !!hand && hand.street !== 'complete' && !hand.runoutVote;

export function streetWagers(room: RoomView): Record<string, number> {
  if (!betting(room.hand)) return {};
  return Object.fromEntries(room.hand!.players.filter(player => player.streetBet > 0).map(player => [player.id, player.streetBet]));
}

export function collectedPot(room: RoomView): number {
  if (!room.hand) return 0;
  if (room.hand.street === 'complete') return room.hand.awardedPot;
  return room.hand.pot - Object.values(streetWagers(room)).reduce((sum, amount) => sum + amount, 0);
}

export function planTableMotion(before: RoomView | null, after: RoomView): TableMotionPlan {
  const plan: TableMotionPlan = { chips: [], cards: [] };
  // A reconnect or skipped snapshot is a new baseline, not a replay of unseen actions.
  if (!before || before.id !== after.id || before.youId !== after.youId || after.version !== before.version + 1) return plan;
  const hand = after.hand;
  if (!hand) return plan;
  const freshHand = before.hand?.id !== hand.id;
  const previousHand = freshHand ? null : before.hand;
  const completed = hand.street === 'complete' && previousHand?.street !== 'complete';
  if (freshHand && hand.number !== before.handNumber + 1) return plan;

  const previousBetting = betting(previousHand);
  const streetEnded = previousBetting && (previousHand?.street !== hand.street || !betting(hand));
  const collect = streetEnded || (freshHand && !betting(hand));
  const wagers = new Map<string, number>();
  const move = (kind: ChipMotion['kind'], playerId: string, amount: number, from: ChipLocation, to: ChipLocation, delay = 0) => {
    if (amount > 0) plan.chips.push({ kind, playerId, amount, from, to, delay });
  };
  for (const player of hand.players) {
    const previous = previousHand?.players.find(item => item.id === player.id);
    const difference = player.committed - (previous?.committed ?? 0);
    const ante = freshHand ? Math.min(handAnte(hand.rules, after.settings), player.committed) : 0;
    const bet = Math.max(0, difference - ante);
    const previousWager = previousBetting ? previous?.streetBet ?? 0 : 0;
    const refund = Math.max(0, -difference);
    const wagerRefund = Math.min(refund, previousWager);
    move('ante', player.id, ante, 'stack', 'pot');
    move('bet', player.id, bet, 'stack', 'wager');
    move('refund', player.id, wagerRefund, 'wager', 'stack');
    move('refund', player.id, refund - wagerRefund, 'pot', 'stack');
    wagers.set(player.id, previousWager + bet - wagerRefund);
  }

  if (collect) {
    const delay = plan.chips.some(chip => chip.to === 'wager' || chip.from === 'wager') ? CHIP_FLIGHT_MS + 60 : 0;
    for (const [playerId, amount] of wagers) move('collect', playerId, amount, 'wager', 'pot', delay);
  }
  const chipsEnd = plan.chips.reduce((end, chip) => Math.max(end, chip.delay + CHIP_FLIGHT_MS), 0);
  let cardsAt = chipsEnd ? chipsEnd + 40 : 0;
  if (freshHand) {
    const order = [...hand.players].sort((a, b) =>
      ((a.seat - hand.buttonSeat + after.settings.maxSeats) % after.settings.maxSeats || after.settings.maxSeats) -
      ((b.seat - hand.buttonSeat + after.settings.maxSeats) % after.settings.maxSeats || after.settings.maxSeats));
    const count = Math.max(...order.map(player => after.players.find(item => item.id === player.id)?.cards.length ?? 0));
    const total = order.reduce((sum, player) => sum + (after.players.find(item => item.id === player.id)?.cards.length ?? 0), 0);
    const stagger = Math.min(85, 1000 / Math.max(1, total - 1));
    let dealt = 0;
    for (let index = 0; index < count; index++) {
      for (const player of order) {
        if (index >= (after.players.find(item => item.id === player.id)?.cards.length ?? 0)) continue;
        plan.cards.push({ kind: 'deal', key: holeCardKey(player.id, index), delay: 100 + dealt++ * stagger });
      }
    }
    cardsAt = Math.max(cardsAt, 100 + Math.max(0, dealt - 1) * stagger + CARD_FLIGHT_MS + 80);
  }

  const runs = boardRuns(hand);
  const oldRuns = previousHand ? boardRuns(previousHand) : [];
  // Extra runs share already-public prefixes; switching tabs must not redeal them.
  for (const [runIndex, boards] of runs.entries()) {
    let dealt = 0;
    for (const [boardIndex, cards] of boards.entries()) {
      const previous = oldRuns[runIndex]?.[boardIndex] ?? previousHand?.boards[boardIndex] ?? [];
      for (let index = previous.length; index < cards.length; index++)
        plan.cards.push({ kind: 'deal', key: boardCardKey(runIndex, boardIndex, index), delay: cardsAt + dealt++ * 100 });
    }
  }
  let revealAt = plan.cards.reduce((end, card) => Math.max(end, card.delay + CARD_FLIGHT_MS), cardsAt);
  if (!freshHand) {
    for (const player of after.players) {
      const previous = before.players.find(item => item.id === player.id);
      if (!previous?.hand) continue;
      for (const [index, card] of player.cards.entries()) {
        if (card !== null && previous.cards[index] === null)
          plan.cards.push({ kind: 'reveal', key: holeCardKey(player.id, index), delay: revealAt });
      }
    }
  }
  revealAt = plan.cards.reduce((end, card) => Math.max(end, card.delay + (card.kind === 'deal' ? CARD_FLIGHT_MS : CARD_REVEAL_MS)), 0);
  if (completed) {
    const payouts = new Map<string, number>();
    for (const result of hand.results)
      for (const [playerId, amount] of Object.entries(result.shares)) payouts.set(playerId, (payouts.get(playerId) ?? 0) + amount);
    const payoutAt = Math.max(chipsEnd ? chipsEnd + 80 : 0, revealAt ? revealAt + 120 : 0);
    for (const [playerId, amount] of payouts)
      move('payout', playerId, amount, 'pot', 'stack', payoutAt);
  }
  return plan;
}
