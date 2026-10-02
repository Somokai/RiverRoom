import { randomUUID } from 'node:crypto';
import type {
  Card, ChipTransfer, Command, FundingRequest, GameEvent, Hand, HandPlayer, HandRules,
  LegalActions, Player, Room, RoomSettings, RoomView, RunoutCount,
} from '../shared/model.js';
import { defaultHandRules, GAME_LABELS, handAnte, isLegacyIndianHand } from '../shared/model.js';
import { evaluate, evaluateIndian, evaluateOmaha, shuffleDeck, type HandRank } from './cards.js';
import { normalizeRoom, ROOM_SCHEMA_VERSION } from './state.js';
import { isPlayerEmoji } from '../shared/emoji.js';

export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface Effects { events: GameEvent[]; transfers: ChipTransfer[] }
export interface Transition extends Effects { room: Room }
export interface Context { now: number; deck?: Card[]; system?: boolean }

const activeHand = (room: Room) => room.hand !== null && room.hand.street !== 'complete';
const playerAccount = (id: string) => `player:${id}`;
const potAccount = (id: string) => `pot:${id}`;
const sessionFundingLimit = 1_000_000_000;
const runoutChoiceMs = 20_000;
const integer = (value: number, min = 1, max = 10_000_000) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const isOmaha = (rules: HandRules) => rules.game === 'omaha' || rules.game === 'omaha_bomb';
const holeCardCount = (rules: HandRules) => isOmaha(rules) ? 4 : 2;
const sameCards = (a: Card[], b: Card[]) => a.length === b.length && a.every((card, index) => card === b[index]);

function event(fx: Effects, ctx: Context, kind: string, message: string, actorId?: string) {
  fx.events.push({ id: randomUUID(), at: ctx.now, kind, message, ...(actorId ? { actorId } : {}) });
}
function findPlayer(room: Room, id: string): Player {
  const player = room.players.find(candidate => candidate.id === id);
  if (!player) throw new GameError('You are not a member of this table.', 403);
  return player;
}
function requireHost(room: Room, actorId: string) {
  if (actorId !== room.hostId) throw new GameError('Only the host can do that.', 403);
}
function join(room: Room, actorId: string, name: string, fx: Effects, ctx: Context) {
  const existing = room.players.find(player => player.id === actorId);
  if (existing !== undefined && existing.seat !== null) throw new GameError('You are already seated.', 409);
  if (!name.trim() || name.length > 24) throw new GameError('Choose a name up to 24 characters.');
  const seat = Array.from({ length: room.settings.maxSeats }, (_, i) => i).find(i => !room.players.some(player => player.seat === i));
  if (seat === undefined) throw new GameError('This table is full.', 409);
  if (existing) { existing.seat = seat; existing.sittingOut = false; }
  else room.players.push({ id: actorId, name: name.trim(), emoji: null, seat, stack: 0, buyIns: 0, cashOuts: 0, rebuyCount: 0, addOnCount: 0, bountyNet: 0, sittingOut: false, timeoutCount: 0, bot: false, joinedAt: ctx.now });
  event(fx, ctx, 'join', `${name.trim()} joined seat ${seat + 1}.`, actorId);
}
function nextSeat(players: Array<{ seat: number }>, after: number): number {
  const ordered = players.map(player => player.seat).sort((a, b) => a - b);
  const next = ordered.find(seat => seat > after) ?? ordered[0];
  if (next === undefined) throw new GameError('No occupied seats.');
  return next;
}
function takeCard(hand: Hand): Card {
  const card = hand.deck.shift();
  if (!card) throw new Error('Deck exhausted.');
  return card;
}

export function validateSettings(settings: RoomSettings) {
  if (!integer(settings.smallBlind) || !integer(settings.bigBlind) || settings.smallBlind >= settings.bigBlind ||
      !integer(settings.ante, 0) || settings.ante > settings.bigBlind ||
      !integer(settings.minBuyIn) || !integer(settings.maxBuyIn) || settings.minBuyIn > settings.maxBuyIn ||
      settings.maxBuyIn < settings.bigBlind || !integer(settings.chipValueCents, 1, 10000) ||
      !integer(settings.maxSeats, 2, 9) || !integer(settings.turnSeconds, 15, 120)) {
    throw new GameError('Check your blinds, buy-in limits, seats, and turn clock.');
  }
}

function validateHandRules(rules: HandRules, frozen = false) {
  if (!rules || !['holdem', 'omaha', 'omaha_bomb', 'indian'].includes(rules.game) ||
      !integer(rules.bombAnte) || !integer(rules.indianAnte) || !integer(rules.omahaAnte, frozen ? 0 : 1) ||
      !integer(rules.sevenDeuceBounty, 0) ||
      !integer(rules.maxRunouts, 1, 3))
    throw new GameError('Choose a valid game, ante, bounty, and one to three runouts.');
}

function transfer(
  fx: Effects, kind: ChipTransfer['kind'], from: string, to: string, chips: number,
  playerId: string, handId: string | null, note: string, cashCents = 0,
) {
  if (!integer(chips, 1, 1_000_000_000)) throw new Error('Invalid chip transfer.');
  fx.transfers.push({ kind, from, to, chips, playerId, handId, note, cashCents });
}

function fund(room: Room, request: FundingRequest, fx: Effects, ctx: Context) {
  const player = findPlayer(room, request.playerId);
  if (room.players.reduce((total, item) => total + item.buyIns, 0) + request.amount > sessionFundingLimit) {
    request.status = 'declined';
    event(fx, ctx, 'funding_declined', `${player.name}'s request was declined: this session reached its lifetime chip funding limit.`, player.id);
    return;
  }
  if (player.seat === null || player.stack + request.amount > room.settings.maxBuyIn ||
      (request.kind !== 'add_on' && request.amount < room.settings.minBuyIn)) {
    request.status = 'declined';
    event(fx, ctx, 'funding_declined', `${player.name}'s funding could not be applied: seat or buy-in limit changed.`);
    return;
  }
  if (request.kind === 'rebuy' && player.stack !== 0) {
    request.status = 'declined';
    event(fx, ctx, 'funding_declined', `${player.name}'s rebuy was declined because chips remain.`);
    return;
  }
  player.stack += request.amount;
  player.buyIns += request.amount;
  if (request.kind === 'rebuy') player.rebuyCount++;
  if (request.kind === 'add_on') player.addOnCount++;
  request.status = 'applied';
  transfer(fx, request.kind, 'bank', playerAccount(player.id), request.amount, player.id, null,
    `${player.name}: ${player.bot ? 'virtual practice ' : ''}${request.kind.replaceAll('_', ' ')}`, request.amount * room.settings.chipValueCents);
  event(fx, ctx, 'funded', `${player.name} received ${request.amount.toLocaleString('en-US')} ${player.bot ? 'virtual practice ' : ''}chips (${request.kind.replaceAll('_', ' ')}).`, player.id);
}
function applyApprovedFunding(room: Room, fx: Effects, ctx: Context) {
  for (const request of room.requests.filter(item => item.status === 'approved')) fund(room, request, fx, ctx);
}
function cashOut(room: Room, player: Player, fx: Effects, ctx: Context) {
  if (player.stack > 0) {
    const amount = player.stack;
    player.stack = 0;
    player.cashOuts += amount;
    transfer(fx, 'cash_out', playerAccount(player.id), 'bank', amount, player.id, null,
      `${player.name} cashed out${player.bot ? ' (virtual practice)' : ''}`, amount * room.settings.chipValueCents);
    event(fx, ctx, 'cash_out', `${player.name} cashed out ${amount.toLocaleString('en-US')} ${player.bot ? 'virtual practice ' : ''}chips.`, player.id);
  }
  player.sittingOut = true;
}

function payIntoPot(room: Room, hp: HandPlayer, amount: number, kind: 'blind' | 'ante' | 'bet', fx: Effects, note: string) {
  const hand = room.hand;
  if (!hand) throw new Error('No hand for contribution.');
  const player = findPlayer(room, hp.id);
  const actual = Math.min(amount, player.stack);
  if (actual <= 0) return;
  player.stack -= actual;
  hp.committed += actual;
  if (kind !== 'ante') hp.streetBet += actual;
  hand.pot += actual;
  transfer(fx, kind, playerAccount(player.id), potAccount(hand.id), actual, player.id, hand.id, note);
}

function finishSession(room: Room, fx: Effects, ctx: Context) {
  for (const request of room.requests.filter(item => item.status === 'pending' || item.status === 'approved')) request.status = 'declined';
  for (const player of room.players) cashOut(room, player, fx, ctx);
  room.status = 'closed';
  room.closedAt = ctx.now;
  room.nextHandAt = null;
  room.endAfterHand = false;
  event(fx, ctx, 'session_closed', 'Session finished. Every remaining stack was cashed out.');
}

function settleBounty(room: Room, hand: Hand, fx: Effects, ctx: Context) {
  const amount = hand.rules.sevenDeuceBounty;
  if (hand.rules.game !== 'holdem' || amount === 0) return;
  const awards = hand.results.filter(result => result.amount > 0);
  const winnerId = awards[0]?.winners[0];
  if (!winnerId || awards.some(result => result.winners.length !== 1 || result.winners[0] !== winnerId)) return;
  const cards = hand.holeCards[winnerId]!;
  if (cards.length !== 2 || cards[0]![1] === cards[1]![1] ||
      cards.map(card => card[0]).sort().join('') !== '27') return;
  const payerIds = hand.players.filter(player => player.id !== winnerId).map(player => player.id);
  const totalAmount = amount * payerIds.length;
  const winner = findPlayer(room, winnerId);
  if (!Number.isSafeInteger(winner.bountyNet + totalAmount)) throw new Error('Bounty balance exceeds the safe integer limit.');
  winner.bountyNet += totalAmount;
  for (const payerId of payerIds) {
    const payer = findPlayer(room, payerId);
    if (!Number.isSafeInteger(payer.bountyNet - amount)) throw new Error('Bounty balance exceeds the safe integer limit.');
    payer.bountyNet -= amount;
    transfer(fx, 'bounty', `bounty:${payerId}`, `bounty:${winnerId}`, amount, payerId, hand.id,
      `${payer.name} owes ${winner.name} a 7-2 offsuit bounty (separate settlement)`, amount * room.settings.chipValueCents);
  }
  hand.bounty = { winnerId, payerIds, amount, totalAmount };
  hand.revealed[winnerId] = [...cards];
  event(fx, ctx, 'bounty', `${winner.name} revealed ${cards.join(' ')} to claim the 7-2 offsuit bounty: ${amount} from each of ${payerIds.length} dealt-in opponents. These are separate settlement balances, not in-play chips.`, winnerId);
}

function settle(room: Room, fx: Effects, ctx: Context) {
  const hand = room.hand;
  if (!hand) throw new Error('Missing hand.');
  const alive = hand.players.filter(player => !player.folded);
  if (alive.length === 0) throw new Error('A hand must have a winner.');
  const contributions = [...hand.players].sort((a, b) => b.committed - a.committed);
  const highest = contributions[0];
  const second = contributions[1];
  if (highest && highest.committed > (second?.committed ?? 0)) {
    const refund = highest.committed - (second?.committed ?? 0);
    const player = findPlayer(room, highest.id);
    highest.committed -= refund;
    highest.streetBet = Math.max(0, highest.streetBet - refund);
    player.stack += refund;
    hand.pot -= refund;
    transfer(fx, 'refund', potAccount(hand.id), playerAccount(player.id), refund, player.id, hand.id, 'Uncalled bet returned');
    event(fx, ctx, 'refund', `${refund.toLocaleString('en-US')} uncalled chips returned to ${player.name}.`, player.id);
  }
  hand.awardedPot = hand.pot;
  hand.showdown = alive.length > 1;
  if (hand.runoutBoards.length === 0) hand.runoutBoards = [hand.boards.map(board => [...board])];
  if (hand.showdown) {
    if (!isLegacyIndianHand(hand) && hand.runoutBoards.some(run => run.some(board => board.length !== 5)))
      throw new Error('Showdown requires complete boards.');
    for (const player of alive) hand.revealed[player.id] = [...(hand.holeCards[player.id] ?? [])];
  }
  if (hand.rules.game === 'indian')
    for (const player of hand.players) hand.revealed[player.id] = [...hand.holeCards[player.id]!];
  const levels = [...new Set(hand.players.map(player => player.committed).filter(amount => amount > 0))].sort((a, b) => a - b);
  const boardCount = Math.max(1, hand.boards.length);
  const ranks = new Map<string, HandRank>();
  const rankPlayer = (player: HandPlayer, boardIndex: number, runoutIndex: number) => {
    const key = `${runoutIndex}:${boardIndex}:${player.id}`;
    let rank = ranks.get(key);
    if (!rank) {
      const cards = hand.holeCards[player.id]!;
      const board = hand.runoutBoards[runoutIndex]![boardIndex] ?? [];
      rank = isLegacyIndianHand(hand) ? evaluateIndian(cards[0]!)
        : isOmaha(hand.rules) ? evaluateOmaha(cards, board) : evaluate([...cards, ...board]);
      ranks.set(key, rank);
    }
    return rank;
  };
  let prior = 0;
  for (const [potIndex, level] of levels.entries()) {
    const contributors = hand.players.filter(player => player.committed >= level);
    const potAmount = (level - prior) * contributors.length;
    prior = level;
    const eligible = alive.filter(player => player.committed >= level);
    if (eligible.length === 0) throw new Error('A pot has no eligible winner.');
    for (let boardIndex = 0; boardIndex < boardCount; boardIndex++) {
      const boardAmount = Math.floor(potAmount / boardCount) + (boardIndex < potAmount % boardCount ? 1 : 0);
      for (let runoutIndex = 0; runoutIndex < hand.runoutCount; runoutIndex++) {
        const amount = Math.floor(boardAmount / hand.runoutCount) + (runoutIndex < boardAmount % hand.runoutCount ? 1 : 0);
        let winners = eligible;
        let description = 'Uncontested';
        if (hand.showdown) {
          const scored = eligible.map(player => ({ player, rank: rankPlayer(player, boardIndex, runoutIndex) }));
          const best = Math.max(...scored.map(item => item.rank.score));
          winners = scored.filter(item => item.rank.score === best).map(item => item.player);
          description = scored.find(item => item.rank.score === best)!.rank.label;
        }
        winners = [...winners].sort((a, b) =>
          ((a.seat - hand.buttonSeat + room.settings.maxSeats) % room.settings.maxSeats || room.settings.maxSeats) -
          ((b.seat - hand.buttonSeat + room.settings.maxSeats) % room.settings.maxSeats || room.settings.maxSeats));
        const share = Math.floor(amount / winners.length);
        let odd = amount % winners.length;
        const shares: Record<string, number> = {};
        for (const winner of winners) {
          const payout = share + (odd-- > 0 ? 1 : 0);
          if (payout === 0) continue;
          findPlayer(room, winner.id).stack += payout;
          hand.pot -= payout;
          shares[winner.id] = payout;
          transfer(fx, 'payout', potAccount(hand.id), playerAccount(winner.id), payout, winner.id, hand.id,
            boardCount > 1 || hand.runoutCount > 1 ? `Pot ${potIndex + 1}, board ${boardIndex + 1}, run ${runoutIndex + 1}: ${description}` : description);
        }
        hand.results.push({ potIndex, boardIndex, runoutIndex, amount, eligible: eligible.map(player => player.id), winners: winners.map(player => player.id), shares, description });
      }
    }
  }
  if (hand.pot !== 0) throw new Error('The settled pot did not balance.');
  settleBounty(room, hand, fx, ctx);
  hand.street = 'complete';
  hand.actorId = null;
  hand.deadline = null;
  hand.runoutVote = null;
  hand.completedAt = ctx.now;
  hand.balanceAfter = Object.fromEntries(room.players.map(player => [player.id, player.stack]));
  hand.bountyAfter = Object.fromEntries(room.players.map(player => [player.id, player.bountyNet]));
  const winning = [...new Set(hand.results.flatMap(result => Object.keys(result.shares)))].map(id => findPlayer(room, id).name).join(' & ');
  event(fx, ctx, 'hand_finished', `${winning} won ${hand.awardedPot.toLocaleString('en-US')} chips${hand.showdown ? ' at showdown' : ' uncontested'}.`);
  applyApprovedFunding(room, fx, ctx);
  if (room.endAfterHand) finishSession(room, fx, ctx);
  else room.nextHandAt = room.settings.autoDeal && !room.paused ? ctx.now + 8000 : null;
}

function dealBoardStreet(hand: Hand, boards: Card[][]) {
  hand.burned.push(takeCard(hand));
  const count = boards[0]!.length === 0 ? 3 : 1;
  for (const board of boards)
    for (let i = 0; i < count; i++) board.push(takeCard(hand));
}

function runOut(room: Room, count: RunoutCount, fx: Effects, ctx: Context) {
  const hand = room.hand!;
  const prefix = hand.runoutPrefix ?? hand.boards.map(board => [...board]);
  hand.runoutPrefix = prefix;
  hand.runoutCount = count;
  hand.runoutVote = null;
  hand.actorId = null;
  hand.deadline = null;
  hand.runoutBoards = [];
  for (let run = 0; run < count; run++) {
    const boards = prefix.map(board => [...board]);
    while (boards[0]!.length < 5) {
      dealBoardStreet(hand, boards);
      const street = boards[0]!.length === 3 ? 'Flop' : boards[0]!.length === 4 ? 'Turn' : 'River';
      event(fx, ctx, 'street', `${count > 1 ? `Run ${run + 1}/${count}, ` : ''}${street}: ${boards.map(board => board.join(' ')).join(' / ')}`);
    }
    hand.runoutBoards.push(boards);
  }
  hand.boards = hand.runoutBoards[0]!.map(board => [...board]);
  hand.board = [...hand.boards[0]!];
  hand.street = 'river';
  hand.currentBet = 0;
  hand.minRaise = room.settings.bigBlind;
  for (const player of hand.players) { player.streetBet = 0; player.actedAtBet = null; }
  settle(room, fx, ctx);
}

function finishAllInBetting(room: Room, fx: Effects, ctx: Context) {
  const hand = room.hand!;
  if (isLegacyIndianHand(hand) || hand.boards.every(board => board.length === 5)) {
    settle(room, fx, ctx);
    return;
  }
  const length = hand.boards[0]!.length;
  const burns = length === 0 ? 3 : length === 3 ? 2 : 1;
  const perRun = (5 - length) * hand.boards.length + burns;
  const maxRuns = Math.min(hand.rules.maxRunouts, Math.floor(hand.deck.length / perRun)) as RunoutCount;
  if (maxRuns < 1) throw new Error('The deck cannot supply a complete runout with required burns.');
  if (maxRuns < hand.rules.maxRunouts)
    event(fx, ctx, 'runout_restricted', `Remaining deck capacity, including required burns, permits only ${maxRuns === 1 ? 'one runout; running once' : `${maxRuns} runouts`}. No cards will be reused.`);
  if (maxRuns === 1) { runOut(room, 1, fx, ctx); return; }
  hand.runoutPrefix = hand.boards.map(board => [...board]);
  hand.actorId = null;
  hand.deadline = null;
  const eligible = hand.players.filter(player => !player.folded).map(player => player.id);
  hand.runoutVote = { eligible, votes: {}, maxRuns, deadline: room.paused ? null : ctx.now + runoutChoiceMs };
  event(fx, ctx, 'runout_offer', `Betting is complete. Each live player may choose up to ${maxRuns} runouts. The lowest choice wins; a missing vote after 20 seconds means once.`);
  for (const id of eligible) {
    const player = findPlayer(room, id);
    if (player.bot) {
      hand.runoutVote.votes[id] = maxRuns;
      event(fx, ctx, 'runout_vote', `${player.name} automatically accepts up to ${maxRuns} runouts.`, id);
    }
  }
  if (eligible.every(id => Object.hasOwn(hand.runoutVote!.votes, id))) {
    event(fx, ctx, 'runouts', `All live players agreed to ${maxRuns} runouts.`);
    runOut(room, maxRuns, fx, ctx);
  }
}

function voteRunouts(room: Room, actorId: string, command: Extract<Command, { type: 'runouts' }>, fx: Effects, ctx: Context) {
  const hand = room.hand;
  if (!hand || hand.id !== command.handId) throw new GameError('That runout choice belongs to a different hand.', 409);
  const vote = hand.runoutVote;
  if (hand.street === 'complete' || !vote) throw new GameError('This hand is not awaiting runout votes.', 409);
  if (room.paused) throw new GameError('The table is paused.', 409);
  if (vote.deadline === null || ctx.now >= vote.deadline) throw new GameError('The runout choice deadline expired.', 409);
  if (!vote.eligible.includes(actorId)) throw new GameError('Only eligible players still in this hand may choose runouts.', 403);
  if (Object.hasOwn(vote.votes, actorId)) throw new GameError('You already voted on this hand.', 409);
  if (!integer(command.count, 1, vote.maxRuns)) throw new GameError(`Choose one to ${vote.maxRuns} runouts.`);
  vote.votes[actorId] = command.count;
  event(fx, ctx, 'runout_vote', `${findPlayer(room, actorId).name} accepts up to ${command.count} runout${command.count === 1 ? '' : 's'}.`, actorId);
  if (command.count === 1 || vote.eligible.every(id => Object.hasOwn(vote.votes, id))) {
    const count = Math.min(...Object.values(vote.votes)) as RunoutCount;
    event(fx, ctx, 'runouts', `Runout choice resolved: running ${count === 1 ? 'once' : count === 2 ? 'twice' : 'three times'}.`);
    runOut(room, count, fx, ctx);
  }
}

function advanceStreet(room: Room, fx: Effects, ctx: Context) {
  const hand = room.hand;
  if (!hand) throw new Error('Missing hand.');
  if (isLegacyIndianHand(hand) || hand.street === 'river') { settle(room, fx, ctx); return; }
  dealBoardStreet(hand, hand.boards);
  hand.board = [...hand.boards[0]!];
  hand.street = hand.street === 'preflop' ? 'flop' : hand.street === 'flop' ? 'turn' : 'river';
  hand.currentBet = 0;
  hand.minRaise = room.settings.bigBlind;
  for (const player of hand.players) { player.streetBet = 0; player.actedAtBet = null; player.lastAction = player.folded ? 'Folded' : ''; }
  event(fx, ctx, 'street', `${hand.street[0]!.toUpperCase()}${hand.street.slice(1)}: ${hand.boards.map(board => board.join(' ')).join(' / ')}`);
  selectNextActor(room, hand.buttonSeat, fx, ctx);
}

function selectNextActor(room: Room, afterSeat: number, fx: Effects, ctx: Context) {
  const hand = room.hand;
  if (!hand || hand.street === 'complete' || hand.runoutVote) return;
  const alive = hand.players.filter(player => !player.folded);
  if (alive.length === 1) { settle(room, fx, ctx); return; }
  const withChips = alive.filter(player => findPlayer(room, player.id).stack > 0);
  if (withChips.length === 0) { finishAllInBetting(room, fx, ctx); return; }
  if (withChips.length === 1) {
    const only = withChips[0]!;
    const otherMax = Math.max(...alive.filter(player => player.id !== only.id).map(player => player.streetBet));
    if (only.streetBet >= otherMax) { finishAllInBetting(room, fx, ctx); return; }
    hand.currentBet = otherMax;
  }
  const pending = withChips.filter(player => player.actedAtBet === null || player.streetBet < hand.currentBet);
  if (pending.length === 0) { advanceStreet(room, fx, ctx); return; }
  const seat = nextSeat(pending, afterSeat);
  hand.actorId = pending.find(player => player.seat === seat)!.id;
  hand.turnStartedAt = ctx.now;
  hand.deadline = room.paused ? null : ctx.now + room.settings.turnSeconds * 1000;
}

function deal(room: Room, fx: Effects, ctx: Context) {
  if (activeHand(room)) throw new GameError('Finish the current hand first.');
  if (room.paused) throw new GameError('Resume the table before dealing.');
  applyApprovedFunding(room, fx, ctx);
  const eligible = room.players.filter((player): player is Player & { seat: number } =>
    player.seat !== null && player.stack > 0 && !player.sittingOut);
  if (eligible.length < 2) throw new GameError('Two funded, active seats are needed to deal.');
  if (room.pendingBlinds) {
    Object.assign(room.settings, room.pendingBlinds);
    room.pendingBlinds = null;
    event(fx, ctx, 'blinds', `Blinds are now ${room.settings.smallBlind}/${room.settings.bigBlind}; ante ${room.settings.ante}.`);
  }
  const button = nextSeat(eligible, room.dealerSeat ?? -1);
  const rules = { ...room.nextHandRules };
  validateHandRules(rules);
  const hasBlinds = rules.game !== 'omaha_bomb';
  const sb = hasBlinds ? eligible.length === 2 ? button : nextSeat(eligible, button) : null;
  const bb = sb === null ? null : nextSeat(eligible, sb);
  room.dealerSeat = button;
  room.handNumber++;
  room.nextHandAt = null;
  const deck = ctx.deck ? [...ctx.deck] : shuffleDeck();
  if (deck.length !== 52 || new Set(deck).size !== 52 || deck.some(card => !/^[2-9TJQKA][cdhs]$/.test(card))) throw new Error('Invalid full deck.');
  const hand: Hand = {
    id: randomUUID(), number: room.handNumber, street: 'preflop', board: [], deck, burned: [], holeCards: {},
    rules, boards: rules.game === 'omaha_bomb' ? [[], []] : [[]],
    runoutBoards: [], runoutPrefix: null, runoutCount: 1, runoutVote: null, preflopPotAdjustment: 0, bounty: null,
    players: eligible.map(player => ({ id: player.id, seat: player.seat, committed: 0, streetBet: 0, folded: false, actedAtBet: null, lastAction: '' })),
    buttonSeat: button, smallBlindSeat: sb, bigBlindSeat: bb, currentBet: hasBlinds ? room.settings.bigBlind : 0,
    minRaise: room.settings.bigBlind, actorId: null, pot: 0, awardedPot: 0,
    turnStartedAt: ctx.now, deadline: null, startedAt: ctx.now, completedAt: null,
    showdown: false, results: [], revealed: {}, balanceAfter: {}, bountyAfter: {},
  };
  room.hand = hand;
  const dealOrder = [...hand.players].sort((a, b) =>
    ((a.seat - button + room.settings.maxSeats) % room.settings.maxSeats || room.settings.maxSeats) -
    ((b.seat - button + room.settings.maxSeats) % room.settings.maxSeats || room.settings.maxSeats));
  for (let round = 0; round < holeCardCount(rules); round++)
    for (const player of dealOrder) (hand.holeCards[player.id] ??= []).push(takeCard(hand));
  event(fx, ctx, 'deal', `Hand #${hand.number}: ${GAME_LABELS[rules.game]}. ${eligible.find(player => player.seat === button)!.name} has the button.`);
  const ante = handAnte(rules, room.settings);
  for (const player of hand.players) if (ante) payIntoPot(room, player, ante, 'ante', fx,
    rules.game === 'omaha_bomb' ? 'Bomb pot ante' : rules.game === 'indian' ? 'Indian poker round buy-in (ante)'
      : rules.game === 'omaha' ? 'PLO round buy-in (ante)' : 'Ante');
  if (ante) event(fx, ctx, 'antes_posted', `${GAME_LABELS[rules.game]}: ${ante.toLocaleString('en-US')} chips per player posted as an ante; short stacks post their remaining chips. Ante chips are in the pot, not part of a call or raise.`);
  if (hasBlinds) {
    const smallBlind = hand.players.find(player => player.seat === sb)!;
    const bigBlind = hand.players.find(player => player.seat === bb)!;
    payIntoPot(room, smallBlind, room.settings.smallBlind, 'blind', fx, 'Small blind');
    payIntoPot(room, bigBlind, room.settings.bigBlind, 'blind', fx, 'Big blind');
    hand.preflopPotAdjustment = room.settings.smallBlind - smallBlind.streetBet + room.settings.bigBlind - bigBlind.streetBet;
    event(fx, ctx, 'blinds_posted', `Blinds posted: ${room.settings.smallBlind} / ${room.settings.bigBlind}.`);
  }
  if (rules.game === 'omaha_bomb') advanceStreet(room, fx, ctx);
  else selectNextActor(room, bb ?? button, fx, ctx);
}

export function legalActions(room: Room, playerId: string): LegalActions {
  const hand = room.hand;
  const player = room.players.find(item => item.id === playerId);
  const hp = hand?.players.find(item => item.id === playerId);
  const bettingLimit = hand && isOmaha(hand.rules) ? 'pot_limit' : 'no_limit';
  const empty: LegalActions = {
    canAct: false, canCheck: false, canRaise: false, toCall: 0, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0,
    allInTo: 0, canAllIn: false, bettingLimit, potLimitTo: null, potAfterCall: hand?.pot ?? 0, reason: 'Waiting for your turn',
  };
  if (!hand || !player || !hp || hand.street === 'complete' || room.status === 'closed') return empty;
  const toCall = Math.max(0, hand.currentBet - hp.streetBet);
  const callAmount = Math.min(player.stack, toCall);
  const allInTo = hp.streetBet + player.stack;
  // TDA 56: nominal blind deficits stay in every preflop pot/re-pot calculation, never in the real pot.
  const countedPot = hand.pot + (bettingLimit === 'pot_limit' && hand.street === 'preflop' ? hand.preflopPotAdjustment : 0);
  const potLimitTo = bettingLimit === 'pot_limit' ? hp.streetBet + toCall + countedPot + toCall : null;
  const maxRaiseTo = Math.min(allInTo, potLimitTo ?? allInTo);
  const minRaiseTo = hand.currentBet + hand.minRaise;
  const opponentsWithChips = hand.players.some(item => item.id !== playerId && !item.folded && findPlayer(room, item.id).stack > 0);
  const reopened = hp.actedAtBet === null || hand.currentBet - hp.actedAtBet >= hand.minRaise;
  const fullRaiseOrAllIn = maxRaiseTo >= minRaiseTo || maxRaiseTo === allInTo;
  const canAct = hand.actorId === playerId && !hand.runoutVote && !room.paused && !hp.folded && player.stack > 0;
  const canRaise = canAct && opponentsWithChips && reopened && fullRaiseOrAllIn && maxRaiseTo > hand.currentBet;
  return {
    canAct, canCheck: canAct && toCall === 0,
    canRaise, toCall, callAmount, maxRaiseTo, minRaiseTo, allInTo,
    canAllIn: canAct && (allInTo <= hand.currentBet || (canRaise && allInTo <= maxRaiseTo)),
    bettingLimit, potLimitTo, potAfterCall: countedPot + callAmount,
    reason: room.paused ? 'The table is paused' : hand.runoutVote ? 'Waiting for runout choices'
      : !reopened ? 'A short all-in did not reopen raising'
      : !opponentsWithChips ? 'No opponent can call another raise'
      : !fullRaiseOrAllIn ? 'The pot limit is below a full minimum raise; only a genuine all-in may be smaller'
      : 'Waiting for your turn',
  };
}

function act(room: Room, actorId: string, command: Extract<Command, { type: 'act' }>, fx: Effects, ctx: Context) {
  const hand = room.hand;
  const legal = legalActions(room, actorId);
  if (!hand || !legal.canAct) throw new GameError(room.paused ? 'The table is paused.' : 'It is not your turn.', 409);
  if (hand.deadline !== null && ctx.now >= hand.deadline && (command.action === 'call' || command.action === 'raise'))
    throw new GameError('Your turn clock expired. Wait for the table to update.', 409);
  const player = findPlayer(room, actorId);
  const hp = hand.players.find(item => item.id === actorId)!;
  let text = '';
  if (command.action === 'fold') {
    hp.folded = true;
    hp.lastAction = 'Folded';
    text = `${player.name} folded.`;
  } else if (command.action === 'check') {
    if (!legal.canCheck) throw new GameError('There is a bet to call.');
    hp.lastAction = 'Check';
    text = `${player.name} checked.`;
  } else if (command.action === 'call') {
    if (legal.toCall === 0) throw new GameError('Nothing to call. You may check.');
    payIntoPot(room, hp, legal.callAmount, 'bet', fx, 'Call');
    hp.lastAction = player.stack === 0 ? 'All-in call' : 'Call';
    text = `${player.name} called ${legal.callAmount.toLocaleString('en-US')}${player.stack === 0 ? ' (all-in)' : ''}.`;
  } else {
    const amount = command.amount ?? 0;
    if (!legal.canRaise) throw new GameError(legal.reason);
    if (!integer(amount, 1, 1_000_000_000) || amount > legal.maxRaiseTo || amount <= hand.currentBet) throw new GameError('That raise amount is not available.');
    if (amount < legal.minRaiseTo && amount !== legal.allInTo) throw new GameError(`The minimum raise-to is ${legal.minRaiseTo}. Only an all-in may be smaller.`);
    const increment = amount - hand.currentBet;
    payIntoPot(room, hp, amount - hp.streetBet, 'bet', fx, `Raise to ${amount}`);
    if (increment >= hand.minRaise) hand.minRaise = increment;
    hand.currentBet = amount;
    hp.lastAction = player.stack === 0 ? 'All-in' : 'Raise';
    text = `${player.name} raised to ${amount.toLocaleString('en-US')}${player.stack === 0 ? ' (all-in)' : ''}.`;
  }
  hp.actedAtBet = hand.currentBet;
  if (!ctx.system) player.timeoutCount = 0;
  event(fx, ctx, 'action', text, actorId);
  selectNextActor(room, hp.seat, fx, ctx);
}

function assertHandCards(hand: Hand) {
  const legacyIndian = isLegacyIndianHand(hand);
  const boardCount = legacyIndian ? 0 : hand.rules.game === 'omaha_bomb' ? 2 : 1;
  const validLength = (length: number) => [0, 3, 4, 5].includes(length);
  const burnsAt = (length: number) => length === 0 ? 0 : length - 2;
  const validateBoards = (boards: Card[][]) => {
    if (boards.length !== boardCount || boards.some(board => !validLength(board.length) || board.length !== boards[0]!.length))
      throw new Error('Invalid community board shape.');
  };
  validateBoards(hand.boards);
  if (!sameCards(hand.board, hand.boards[0] ?? [])) throw new Error('Legacy board is not the primary board projection.');
  const holeIds = Object.keys(hand.holeCards);
  if (holeIds.length !== hand.players.length || hand.players.some(player => hand.holeCards[player.id]?.length !== (legacyIndian ? 1 : holeCardCount(hand.rules))))
    throw new Error('Invalid dealt hole cards.');
  for (const [id, cards] of Object.entries(hand.revealed))
    if (!hand.holeCards[id] || !sameCards(cards, hand.holeCards[id]!)) throw new Error('Revealed cards do not match the dealt cards.');
  if (hand.rules.game === 'indian' && hand.street !== 'complete' && Object.keys(hand.revealed).length)
    throw new Error('An active Indian hand cannot reveal the owner cards.');
  if (hand.runoutPrefix) {
    validateBoards(hand.runoutPrefix);
    if (hand.runoutPrefix.some((prefix, index) => prefix.length === 5 ||
        !sameCards(prefix, hand.boards[index]!.slice(0, prefix.length))))
      throw new Error('Runout prefix was not preserved.');
  }
  if (!integer(hand.runoutCount, 1, hand.rules.maxRunouts) ||
      (hand.runoutCount > 1 && !hand.runoutPrefix)) throw new Error('Invalid runout count or missing shared prefix.');
  let boardCards = hand.boards.flat();
  let expectedBurns = burnsAt(hand.boards[0]?.length ?? 0);
  if (hand.runoutBoards.length) {
    if (hand.runoutBoards.length !== hand.runoutCount) throw new Error('Runout count does not match its boards.');
    for (const run of hand.runoutBoards) {
      validateBoards(run);
      if (run.some((board, index) => board.length !== hand.boards[index]!.length ||
          !sameCards(hand.runoutPrefix?.[index] ?? [], board.slice(0, hand.runoutPrefix?.[index]?.length ?? 0))))
        throw new Error('Runout boards do not preserve the shared prefix.');
    }
    if (hand.boards.some((board, index) => !sameCards(board, hand.runoutBoards[0]![index]!)))
      throw new Error('Primary boards do not match the first runout.');
    const prefix = hand.runoutPrefix ?? hand.boards.map(() => []);
    // Prefixes are projections of the same physical cards; only the distinct tails are counted per run.
    boardCards = [...prefix.flat(), ...hand.runoutBoards.flatMap(run => run.flatMap((board, index) => board.slice(prefix[index]!.length)))];
    const prefixBurns = burnsAt(prefix[0]?.length ?? 0);
    expectedBurns = prefixBurns + hand.runoutCount * (expectedBurns - prefixBurns);
  } else if (hand.runoutCount !== 1 || hand.street === 'complete') {
    throw new Error('Missing completed runout boards.');
  }
  if (legacyIndian && (hand.runoutCount !== 1 || hand.runoutVote || hand.runoutPrefix || hand.burned.length))
    throw new Error('Legacy one-card Indian poker has no community runouts or burns.');
  if (hand.burned.length !== expectedBurns) throw new Error('Wrong number of burn cards for the dealt streets and runouts.');
  if (!legacyIndian) {
    const expectedLength = ({ preflop: 0, flop: 3, turn: 4, river: 5 } as const)[hand.street as Exclude<Hand['street'], 'complete'>];
    if ((hand.street !== 'complete' && hand.board.length !== expectedLength) ||
        (hand.showdown && hand.board.length !== 5)) throw new Error('Community cards do not match the hand street.');
  }
  const cards = [...hand.deck, ...hand.burned, ...boardCards, ...Object.values(hand.holeCards).flat()];
  if (cards.length !== 52 || new Set(cards).size !== 52 || cards.some(card => !/^[2-9TJQKA][cdhs]$/.test(card)))
    throw new Error('Duplicate, invalid, or missing physical cards.');
}

export function assertRoom(room: Room) {
  if (room.schemaVersion !== ROOM_SCHEMA_VERSION) throw new Error('Room must be normalized before validation.');
  validateHandRules(room.nextHandRules);
  const seats = room.players.flatMap(player => player.seat === null ? [] : [player.seat]);
  if (new Set(seats).size !== seats.length || new Set(room.players.map(player => player.id)).size !== room.players.length) throw new Error('Duplicate player or seat.');
  if (room.players.some(player => player.emoji !== undefined && player.emoji !== null && !isPlayerEmoji(player.emoji)))
    throw new Error('Invalid player emoji.');
  if (room.players.some(player => !integer(player.stack, 0, 1_000_000_000) || !integer(player.buyIns, 0, 1_000_000_000) || !integer(player.cashOuts, 0, 1_000_000_000))) throw new Error('Invalid account balance.');
  if (room.players.some(player => !Number.isSafeInteger(player.bountyNet))) throw new Error('Invalid signed bounty balance.');
  if (room.players.reduce((sum, player) => sum + BigInt(player.bountyNet), 0n) !== 0n) throw new Error('Bounty balances are not zero-sum.');
  const issued = room.players.reduce((sum, player) => sum + player.buyIns - player.cashOuts, 0);
  const held = room.players.reduce((sum, player) => sum + player.stack, 0) + (room.hand?.pot ?? 0);
  if (issued !== held) throw new Error(`Chip conservation violated: issued ${issued}, held ${held}.`);
  const hand = room.hand;
  if (hand) {
    validateHandRules(hand.rules, true);
    if (new Set(hand.players.map(player => player.id)).size !== hand.players.length ||
        new Set(hand.players.map(player => player.seat)).size !== hand.players.length ||
        !integer(hand.pot, 0, sessionFundingLimit) || !integer(hand.awardedPot, 0, sessionFundingLimit) ||
        !integer(hand.preflopPotAdjustment, 0, sessionFundingLimit) ||
        hand.players.some(player => !room.players.some(member => member.id === player.id) ||
          !integer(player.committed, 0, sessionFundingLimit) || !integer(player.streetBet, 0, player.committed)))
      throw new Error('Invalid hand commitments or pot balance.');
    const commitments = hand.players.reduce((sum, player) => sum + player.committed, 0);
    if (commitments !== (activeHand(room) ? hand.pot : hand.awardedPot)) throw new Error('Pot commitments do not balance.');
    assertHandCards(hand);
    if (Object.values(hand.bountyAfter).some(value => !Number.isSafeInteger(value)) ||
        Object.values(hand.bountyAfter).reduce((sum, value) => sum + BigInt(value), 0n) !== 0n)
      throw new Error('Invalid bounty settlement snapshot.');
    if (hand.runoutVote) {
      const vote = hand.runoutVote;
      const alive = hand.players.filter(player => !player.folded);
      const withChips = alive.filter(player => findPlayer(room, player.id).stack > 0);
      const perRun = (5 - hand.board.length) * hand.boards.length + (hand.board.length === 0 ? 3 : hand.board.length === 3 ? 2 : 1);
      if (hand.street === 'complete' || hand.actorId !== null || hand.deadline !== null ||
          hand.board.length === 5 || alive.length < 2 || withChips.length > 1 ||
          (withChips.length === 1 && alive.some(player => player.streetBet > withChips[0]!.streetBet)) ||
          !integer(vote.maxRuns, 2, hand.rules.maxRunouts) || vote.maxRuns * perRun > hand.deck.length ||
          new Set(vote.eligible).size !== alive.length ||
          vote.eligible.length !== alive.length || alive.some(player => !vote.eligible.includes(player.id)) ||
          Object.entries(vote.votes).some(([id, count]) => !vote.eligible.includes(id) || !integer(count, 1, vote.maxRuns)) ||
          (room.paused ? vote.deadline !== null : !Number.isSafeInteger(vote.deadline)) ||
          !hand.runoutPrefix || hand.runoutPrefix.some((prefix, index) => !sameCards(prefix, hand.boards[index]!)))
        throw new Error('Invalid all-in runout vote state.');
    }
    if (hand.street === 'complete') {
      if (hand.pot !== 0 || hand.actorId !== null || hand.deadline !== null || hand.runoutVote ||
          hand.results.reduce((sum, result) => sum + result.amount, 0) !== hand.awardedPot ||
          hand.results.some(result => !integer(result.amount, 0, sessionFundingLimit) ||
            !integer(result.potIndex, 0, hand.players.length - 1) ||
            !integer(result.boardIndex, 0, Math.max(1, hand.boards.length) - 1) ||
            !integer(result.runoutIndex, 0, hand.runoutCount - 1) ||
            result.winners.some(id => !result.eligible.includes(id)) ||
            Object.entries(result.shares).some(([id, amount]) => !result.winners.includes(id) || !integer(amount, 1, sessionFundingLimit)) ||
            Object.values(result.shares).reduce((sum, amount) => sum + amount, 0) !== result.amount))
        throw new Error('Completed pot awards do not balance.');
    }
    if (hand.bounty && (hand.rules.game !== 'holdem' || hand.street !== 'complete' ||
        !integer(hand.bounty.amount) || hand.bounty.amount !== hand.rules.sevenDeuceBounty ||
        hand.bounty.totalAmount !== hand.bounty.amount * hand.bounty.payerIds.length ||
        new Set(hand.bounty.payerIds).size !== hand.players.length - 1 ||
        hand.bounty.payerIds.length !== hand.players.length - 1 ||
        !hand.players.some(player => player.id === hand.bounty!.winnerId) ||
        hand.players.some(player => player.id !== hand.bounty!.winnerId && !hand.bounty!.payerIds.includes(player.id))))
      throw new Error('Invalid seven-deuce bounty award.');
  }
}

function finalize(room: Room, fx: Effects): Transition {
  room.events = [...room.events, ...fx.events].slice(-80);
  room.requests = room.requests.filter((request, index) => request.status === 'pending' || request.status === 'approved' || index >= room.requests.length - 50);
  room.version++;
  assertRoom(room);
  return { room, ...fx };
}

export function createRoom(input: { id: string; code: string; name: string; hostId: string; hostName: string; settings: RoomSettings; buyIn: number }, ctx: Context): Transition {
  validateSettings(input.settings);
  const room: Room = {
    schemaVersion: ROOM_SCHEMA_VERSION, id: input.id, code: input.code, name: input.name, hostId: input.hostId, createdAt: ctx.now,
    status: 'open', closedAt: null, version: 0, settings: { ...input.settings }, nextHandRules: defaultHandRules(input.settings), pendingBlinds: null,
    players: [], requests: [], hand: null, handNumber: 0, dealerSeat: null, paused: false,
    endAfterHand: false, nextHandAt: null, events: [],
  };
  const joined = transition(room, input.hostId, { type: 'join', name: input.hostName }, ctx);
  const funded = transition(joined.room, input.hostId, { type: 'fund', amount: input.buyIn }, ctx);
  return { room: funded.room, events: [...joined.events, ...funded.events], transfers: [...joined.transfers, ...funded.transfers] };
}

export function transition(original: Room, actorId: string, command: Command, ctx: Context): Transition {
  const room = normalizeRoom(structuredClone(original));
  const fx: Effects = { events: [], transfers: [] };
  if (room.status === 'closed') throw new GameError('This session is closed. Its records are still available.', 409);
  if (command.type !== 'join') findPlayer(room, actorId);
  switch (command.type) {
    case 'join': {
      join(room, actorId, command.name, fx, ctx);
      break;
    }
    case 'act': act(room, actorId, command, fx, ctx); break;
    case 'deal': requireHost(room, actorId); deal(room, fx, ctx); break;
    case 'next_hand':
      requireHost(room, actorId);
      validateHandRules(command.rules);
      room.nextHandRules = { ...command.rules };
      event(fx, ctx, 'next_hand', `Next-hand rules selected: ${GAME_LABELS[command.rules.game]}; bomb ante ${command.rules.bombAnte}, Indian round ante ${command.rules.indianAnte}, PLO round ante ${command.rules.omahaAnte}, Hold'em 7-2 offsuit bounty ${command.rules.sevenDeuceBounty}, up to ${command.rules.maxRunouts} runout${command.rules.maxRunouts === 1 ? '' : 's'}. Current-hand rules are unchanged.`, actorId);
      break;
    case 'runouts': voteRunouts(room, actorId, command, fx, ctx); break;
    case 'fund':
    case 'fund_bot': {
      if (command.type === 'fund_bot') {
        requireHost(room, actorId);
        if (activeHand(room)) throw new GameError('Refill practice bots between hands.');
      }
      const player = findPlayer(room, command.type === 'fund_bot' ? command.playerId : actorId);
      if (command.type === 'fund_bot' && !player.bot) throw new GameError('Only practice bots can receive virtual refills.');
      const kind = player.buyIns === 0 ? 'buy_in' : player.stack === 0 ? 'rebuy' : 'add_on';
      if (player.seat === null) throw new GameError('Take a seat first.');
      if (room.players.reduce((total, item) => total + item.buyIns, 0) + command.amount > sessionFundingLimit)
        throw new GameError('This session reached its 1,000,000,000-chip lifetime funding limit. Cash out and open a new session.');
      if (kind === 'rebuy' && !room.settings.allowRebuys) throw new GameError('Rebuys are disabled at this table.');
      if (!integer(command.amount) || command.amount + player.stack > room.settings.maxBuyIn ||
          (kind !== 'add_on' && command.amount < room.settings.minBuyIn)) throw new GameError(`Choose a valid amount. Buy-in: ${room.settings.minBuyIn}-${room.settings.maxBuyIn}; add-ons cannot exceed the stack cap.`);
      if (room.requests.some(request => request.playerId === player.id && ['pending', 'approved'].includes(request.status)))
        throw new GameError(command.type === 'fund_bot' ? 'This bot already has a funding request waiting.' : 'You already have a funding request waiting.');
      const request: FundingRequest = { id: randomUUID(), playerId: player.id, kind, amount: command.amount, status: actorId === room.hostId ? 'approved' : 'pending', createdAt: ctx.now };
      room.requests.push(request);
      event(fx, ctx, 'funding_requested', command.type === 'fund_bot'
        ? `Host approved ${command.amount.toLocaleString('en-US')} virtual practice chips for ${player.name} (${kind.replaceAll('_', ' ')}).`
        : `${player.name} requested ${command.amount.toLocaleString('en-US')} chips (${kind.replaceAll('_', ' ')}).`, actorId);
      if (request.status === 'approved' && !activeHand(room)) fund(room, request, fx, ctx);
      break;
    }
    case 'approve': {
      requireHost(room, actorId);
      const request = room.requests.find(item => item.id === command.requestId && item.status === 'pending');
      if (!request) throw new GameError('That request is no longer pending.', 409);
      request.status = command.approve ? 'approved' : 'declined';
      event(fx, ctx, 'funding_reviewed', `${findPlayer(room, request.playerId).name}'s request was ${request.status}${activeHand(room) && command.approve ? '; chips arrive after this hand' : ''}.`, actorId);
      if (command.approve && !activeHand(room)) fund(room, request, fx, ctx);
      break;
    }
    case 'cash_out': {
      if (activeHand(room)) throw new GameError('Cash-outs are available between hands.');
      const player = findPlayer(room, actorId);
      cashOut(room, player, fx, ctx);
      player.seat = null;
      for (const request of room.requests.filter(item => item.playerId === actorId && ['pending', 'approved'].includes(item.status))) request.status = 'declined';
      break;
    }
    case 'sit_out': {
      const player = findPlayer(room, actorId);
      player.sittingOut = command.value;
      player.timeoutCount = 0;
      event(fx, ctx, 'sit_out', `${player.name} ${command.value ? 'will sit out after this hand' : 'is ready to play'}.`, actorId);
      break;
    }
    case 'pause':
      requireHost(room, actorId);
      room.paused = command.value;
      if (activeHand(room)) {
        const hand = room.hand!;
        hand.turnStartedAt = ctx.now;
        if (hand.runoutVote) {
          hand.deadline = null;
          hand.runoutVote.deadline = command.value ? null : ctx.now + runoutChoiceMs;
        } else hand.deadline = command.value || !hand.actorId ? null : ctx.now + room.settings.turnSeconds * 1000;
      } else room.nextHandAt = !command.value && room.settings.autoDeal && room.hand ? ctx.now + 8000 : null;
      event(fx, ctx, 'pause', `Table ${command.value ? 'paused' : 'resumed'} by the host.`, actorId);
      break;
    case 'settings': {
      requireHost(room, actorId);
      validateSettings({ ...room.settings, ...command, minBuyIn: command.minBuyIn === undefined ? room.settings.minBuyIn : command.minBuyIn });
      const blinds = { smallBlind: command.smallBlind, bigBlind: command.bigBlind, ante: command.ante };
      if (activeHand(room)) room.pendingBlinds = blinds;
      else Object.assign(room.settings, blinds);
      room.settings.autoDeal = command.autoDeal;
      room.settings.turnSeconds = command.turnSeconds;
      room.settings.allowRebuys = command.allowRebuys;
      if (command.minBuyIn !== undefined) room.settings.minBuyIn = command.minBuyIn;
      room.nextHandAt = !activeHand(room) && room.hand && command.autoDeal && !room.paused ? ctx.now + 8000 : null;
      event(fx, ctx, 'settings', `Table settings updated. Blinds ${command.smallBlind}/${command.bigBlind}, ante ${command.ante}${activeHand(room) ? ' from the next hand' : ''}.${command.minBuyIn === undefined ? '' : ` Minimum buy-in is now ${command.minBuyIn}; existing balances are unchanged.`}`, actorId);
      break;
    }
    case 'add_bot': {
      requireHost(room, actorId);
      const id = `bot-${randomUUID()}`;
      const names = ['Atlas', 'Cleo', 'Milo', 'Nova', 'Juno', 'Finn', 'Luna', 'Remy'];
      const name = command.name?.trim() || names.find(candidate => !room.players.some(player => player.name === candidate)) || 'River Bot';
      join(room, id, name, fx, ctx);
      const bot = findPlayer(room, id);
      bot.bot = true;
      const request: FundingRequest = { id: randomUUID(), playerId: id, kind: 'buy_in', amount: Math.min(room.settings.maxBuyIn, Math.max(room.settings.minBuyIn, room.settings.bigBlind * 100)), status: 'approved', createdAt: ctx.now };
      room.requests.push(request);
      if (!activeHand(room)) fund(room, request, fx, ctx);
      event(fx, ctx, 'bot_added', `${name} is a practice bot; its bookkeeping is virtual.`, actorId);
      break;
    }
    case 'remove_bot': {
      requireHost(room, actorId);
      if (activeHand(room)) throw new GameError('Remove bots between hands.');
      const player = findPlayer(room, command.playerId);
      if (!player.bot) throw new GameError('That is not a bot.');
      cashOut(room, player, fx, ctx);
      player.seat = null;
      event(fx, ctx, 'bot_removed', `${player.name} left the table.`, actorId);
      break;
    }
    case 'transfer_host': {
      requireHost(room, actorId);
      const target = findPlayer(room, command.playerId);
      if (target.bot || target.seat === null) throw new GameError('Choose a seated human player.');
      room.hostId = target.id;
      event(fx, ctx, 'host_changed', `${target.name} is now the host.`, actorId);
      break;
    }
    case 'close':
      requireHost(room, actorId);
      if (activeHand(room)) {
        room.endAfterHand = true;
        event(fx, ctx, 'closing', 'Session will finish and cash out all stacks after this hand.', actorId);
      } else finishSession(room, fx, ctx);
      break;
    case 'emoji': {
      if (command.emoji !== null && !isPlayerEmoji(command.emoji)) throw new GameError('Choose an emoji from the picker.');
      const player = findPlayer(room, actorId);
      player.emoji = command.emoji;
      event(fx, ctx, 'emoji', command.emoji ? `${player.name} chose ${command.emoji} as their table emoji.` : `${player.name} removed their table emoji.`, actorId);
      break;
    }
    case 'chat': {
      const message = command.message.trim();
      if (!message || message.length > 240) throw new GameError('Messages must be 1-240 characters.');
      event(fx, ctx, 'chat', `${findPlayer(room, actorId).name}: ${message}`, actorId);
      break;
    }
  }
  return finalize(room, fx);
}

export function timeoutTurn(original: Room, now: number): Transition | null {
  const room = normalizeRoom(structuredClone(original));
  const hand = room.hand;
  if (!hand || room.status === 'closed' || room.paused || hand.runoutVote || !hand.actorId ||
      hand.deadline === null || hand.deadline > now || hand.street === 'complete') return null;
  const player = findPlayer(room, hand.actorId);
  player.timeoutCount++;
  if (player.timeoutCount >= 2) player.sittingOut = true;
  return transition(room, player.id, { type: 'act', action: legalActions(room, player.id).canCheck ? 'check' : 'fold' }, { now, system: true });
}

export function timeoutRunout(original: Room, now: number): Transition | null {
  const room = normalizeRoom(structuredClone(original));
  const hand = room.hand;
  const vote = hand?.runoutVote;
  if (!hand || !vote || room.status === 'closed' || room.paused || hand.street === 'complete' ||
      vote.deadline === null || vote.deadline > now) return null;
  const fx: Effects = { events: [], transfers: [] };
  const ctx: Context = { now, system: true };
  const missing = vote.eligible.filter(id => !Object.hasOwn(vote.votes, id));
  for (const id of missing) vote.votes[id] = 1;
  const count = Math.min(...vote.eligible.map(id => vote.votes[id]!)) as RunoutCount;
  event(fx, ctx, 'runout_timeout', `Runout deadline expired.${missing.length ? ` ${missing.map(id => findPlayer(room, id).name).join(', ')} defaulted to one runout.` : ''} Running ${count === 1 ? 'once' : count === 2 ? 'twice' : 'three times'}.`);
  runOut(room, count, fx, ctx);
  return finalize(room, fx);
}

export function roomView(original: Room, userId: string, connected: Set<string>, now = Date.now()): RoomView {
  const room = normalizeRoom(structuredClone(original));
  findPlayer(room, userId);
  const hand = room.hand;
  let publicHand: RoomView['hand'] = null;
  if (hand) {
    const { deck: _deck, burned: _burned, holeCards: _holeCards, ...safe } = hand;
    publicHand = safe;
  }
  return {
    ...room,
    hand: publicHand,
    players: room.players.map(player => {
      const hp = hand?.players.find(item => item.id === player.id) ?? null;
      const visible = hand?.rules.game === 'indian'
        ? player.id !== userId || hp?.folded || hand.street === 'complete' ? hand.holeCards[player.id] : undefined
        : hand?.revealed[player.id] ?? (player.id === userId ? hand?.holeCards[player.id] : undefined);
      const chipNet = player.stack + (activeHand(room) ? hp?.committed ?? 0 : 0) + player.cashOuts - player.buyIns;
      return {
        ...player, connected: player.bot || connected.has(player.id), hand: hp,
        cards: visible ? [...visible] : hp ? Array.from({ length: isLegacyIndianHand(hand!) ? 1 : holeCardCount(hand!.rules) }, () => null) : [],
        chipNet, net: chipNet + player.bountyNet,
      };
    }),
    legal: legalActions(room, userId), youId: userId, serverTime: now,
  };
}
