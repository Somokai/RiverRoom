import { defaultHandRules, type HandHistory, type Room } from '../shared/model.js';

export const ROOM_SCHEMA_VERSION = 3;

// Legacy snapshots predate game variants. Their active hands must stay ordinary, single-run Hold'em.
export function normalizeRoom(room: Room): Room {
  if (room.schemaVersion === ROOM_SCHEMA_VERSION) return room;
  if (room.schemaVersion !== undefined && room.schemaVersion !== 1 && room.schemaVersion !== 2)
    throw new Error('This room uses an unsupported saved-state version.');
  if (room.schemaVersion !== 2) {
    room.nextHandRules = defaultHandRules(room.settings);
    for (const player of room.players) player.bountyNet = 0;
    const hand = room.hand;
    if (hand) {
      hand.rules = defaultHandRules(room.settings);
      hand.boards = [[...hand.board]];
      hand.runoutBoards = hand.street === 'complete' ? [hand.boards.map(board => [...board])] : [];
      hand.runoutPrefix = null;
      hand.runoutCount = 1;
      hand.runoutVote = null;
      hand.preflopPotAdjustment = 0;
      hand.bounty = null;
      hand.bountyAfter = Object.fromEntries(room.players.map(player => [player.id, 0]));
      hand.results = hand.results.map((result, index) => ({ ...result, potIndex: index, boardIndex: 0, runoutIndex: 0 }));
    }
  }
  room.nextHandRules.omahaAnte ??= defaultHandRules(room.settings).omahaAnte;
  // Zero records the absence of a variant-specific ante in already-dealt PLO hands.
  if (room.hand) room.hand.rules.omahaAnte ??= 0;
  room.schemaVersion = ROOM_SCHEMA_VERSION;
  return room;
}

export function normalizeHistory(summary: HandHistory): HandHistory {
  if (summary.rules !== undefined) return summary.rules.omahaAnte !== undefined ? summary
    : { ...summary, rules: { ...summary.rules, omahaAnte: 0 } };
  return {
    ...summary, rules: defaultHandRules(), boards: [[...summary.board]],
    runoutBoards: [[[...summary.board]]], runoutCount: 1, bounty: null,
    showdown: Object.keys(summary.revealed).length > 0,
    bountyAfter: Object.fromEntries(Object.keys(summary.balanceAfter).map(id => [id, 0])),
    results: summary.results.map((result, index) => ({ ...result, potIndex: index, boardIndex: 0, runoutIndex: 0 })),
  };
}
