import { isLegacyIndianHand, type GameVariant, type PlayerStats, type PlayerStatsCounts, type Room } from '../shared/model.js';
import type { Queryable } from './database.js';
import type { Transition } from './engine.js';

export async function recordPlayerStats(tx: Queryable, before: Room | null, result: Transition, actorId: string, command: string) {
  const { room, events, transfers } = result;
  const hand = room.hand;
  if (!hand || isLegacyIndianHand(hand)) return;
  const previous = before?.hand;
  const newHand = previous?.id !== hand.id;
  if (newHand) {
    const humans = hand.players.filter(player => !room.players.find(member => member.id === player.id)!.bot).map(player => player.id);
    await tx.query(
      `INSERT INTO rr_player_hand_stats(room_id,hand_id,user_id,game,started_at)
       SELECT $1,$2,user_id,$4,$5::timestamptz FROM unnest($3::text[]) AS players(user_id)`,
      [room.id, hand.id, humans, hand.rules.game, new Date(hand.startedAt).toISOString()]);
  }
  if (!newHand && previous && previous.street !== 'complete' && events.some(event => event.kind === 'action' && event.actorId === actorId)) {
    const preflop = previous.street === 'preflop';
    const paid = transfers.some(entry => entry.kind === 'bet' && entry.playerId === actorId && entry.handId === hand.id);
    await tx.query(
      `UPDATE rr_player_hand_stats SET preflop_opportunity=preflop_opportunity OR $4,
         vpip=vpip OR $5, pfr=pfr OR $6,
         postflop_bets_raises=postflop_bets_raises+$7, postflop_calls=postflop_calls+$8
       WHERE room_id=$1 AND hand_id=$2 AND user_id=$3 AND completed_at IS NULL`,
      [room.id, hand.id, actorId, preflop, preflop && paid, preflop && paid && command === 'raise',
        !preflop && paid && command === 'raise' ? 1 : 0, !preflop && paid && command === 'call' ? 1 : 0]);
  }
  if (hand.board.length >= 3 && (newHand || previous!.board.length < 3)) {
    await tx.query(
      `UPDATE rr_player_hand_stats SET saw_flop=TRUE
       WHERE room_id=$1 AND hand_id=$2 AND user_id=ANY($3::text[]) AND completed_at IS NULL`,
      [room.id, hand.id, hand.players.filter(player => !player.folded).map(player => player.id)]);
  }
  if (hand.street === 'complete' && (newHand || previous!.street !== 'complete')) {
    const showdowns = hand.showdown ? hand.players.filter(player => !player.folded).map(player => player.id) : [];
    const winners = [...new Set(hand.results.flatMap(pot => Object.entries(pot.shares).filter(([, chips]) => chips > 0).map(([id]) => id)))];
    // Only rows created at the deal are finalized; pre-upgrade hands must not become partial samples.
    await tx.query(
      `UPDATE rr_player_hand_stats SET completed_at=$3::timestamptz,
         showdown=user_id=ANY($4::text[]), showdown_won=user_id=ANY($4::text[]) AND user_id=ANY($5::text[]),
         hand_won=user_id=ANY($5::text[])
       WHERE room_id=$1 AND hand_id=$2 AND completed_at IS NULL`,
      [room.id, hand.id, new Date(hand.completedAt!).toISOString(), showdowns, winners]);
  }
}

function emptyCounts(): PlayerStatsCounts {
  return { hands: 0, preflopOpportunities: 0, vpipHands: 0, pfrHands: 0, postflopBetsRaises: 0,
    postflopCalls: 0, flopsSeen: 0, showdowns: 0, showdownsWon: 0, handsWon: 0 };
}
const counters: Array<keyof PlayerStatsCounts> = ['hands', 'preflopOpportunities', 'vpipHands', 'pfrHands',
  'postflopBetsRaises', 'postflopCalls', 'flopsSeen', 'showdowns', 'showdownsWon', 'handsWon'];
type StatsRow = Record<keyof PlayerStatsCounts, number | string> & {
  game: GameVariant; first_hand: Date | string; last_hand: Date | string;
};

export async function getPlayerStats(db: Queryable, userId: string): Promise<PlayerStats> {
  const rows = await db.query<StatsRow>(
    `SELECT game, MIN(started_at) AS first_hand, MAX(completed_at) AS last_hand, COUNT(*) AS hands,
       COUNT(*) FILTER (WHERE preflop_opportunity) AS "preflopOpportunities",
       COUNT(*) FILTER (WHERE vpip) AS "vpipHands", COUNT(*) FILTER (WHERE pfr) AS "pfrHands",
       SUM(postflop_bets_raises) AS "postflopBetsRaises", SUM(postflop_calls) AS "postflopCalls",
       COUNT(*) FILTER (WHERE saw_flop) AS "flopsSeen", COUNT(*) FILTER (WHERE showdown) AS showdowns,
       COUNT(*) FILTER (WHERE showdown_won) AS "showdownsWon", COUNT(*) FILTER (WHERE hand_won) AS "handsWon"
     FROM rr_player_hand_stats WHERE user_id=$1 AND completed_at IS NOT NULL GROUP BY game`, [userId]);
  const games: GameVariant[] = ['holdem', 'omaha', 'omaha_bomb', 'indian'];
  const stats: PlayerStats = { userId, trackedSince: null, lastHandAt: null, totals: emptyCounts(),
    games: games.map(game => ({ game, counts: emptyCounts() })) };
  for (const row of rows.rows) {
    const group = stats.games.find(group => group.game === row.game);
    if (!group) throw new Error('Unsupported game in player statistics.');
    for (const key of counters) {
      const value = Number(row[key]);
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(stats.totals[key] + value))
        throw new Error('Invalid player statistics counter.');
      group.counts[key] = value;
      stats.totals[key] += value;
    }
    const first = new Date(row.first_hand).toISOString();
    const last = new Date(row.last_hand).toISOString();
    if (stats.trackedSince === null || first < stats.trackedSince) stats.trackedSince = first;
    if (stats.lastHandAt === null || last > stats.lastHandAt) stats.lastHandAt = last;
  }
  return stats;
}
