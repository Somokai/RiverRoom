import { DEFAULT_SETTINGS, defaultHandRules, turnClockSettings, type HandHistory, type Room } from '../shared/model.js';

export const ROOM_SCHEMA_VERSION = 6;

// Legacy snapshots predate game variants. Their active hands must stay ordinary, single-run Hold'em.
export function normalizeRoom(room: Room): Room {
  if (room.schemaVersion === ROOM_SCHEMA_VERSION) return room;
  if (room.schemaVersion !== undefined && ![1, 2, 3, 4, 5].includes(room.schemaVersion))
    throw new Error('This room uses an unsupported saved-state version.');
  if (room.schemaVersion === undefined || room.schemaVersion === 1) {
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
  room.nextHandRules.postflopCap ??= 0;
  if (room.hand) {
    room.hand.rules.postflopCap ??= 0;
    // Older active hands are uncapped; their prior post-flop contributions need no reconstruction.
    for (const player of room.hand.players) player.postflopCommitted ??= 0;
  }
  room.settings.timeBankSeconds ??= DEFAULT_SETTINGS.timeBankSeconds;
  room.settings.timeBankEveryHands ??= DEFAULT_SETTINGS.timeBankEveryHands;
  for (const player of room.players) {
    player.timeBankMs ??= 0;
    player.timeBankHandsPlayed ??= 0;
  }
  if (room.hand) {
    room.hand.clock ??= turnClockSettings(room.settings);
    room.hand.baseDeadline ??= room.hand.deadline;
  }
  // Schema-three presets keep their absent modifiers: shared rule helpers resolve their original behavior.
  room.schemaVersion = ROOM_SCHEMA_VERSION;
  return room;
}

export function normalizeHistory(summary: HandHistory): HandHistory {
  if (summary.rules !== undefined) return summary.rules.omahaAnte !== undefined && summary.rules.postflopCap !== undefined ? summary
    : { ...summary, rules: { ...summary.rules, omahaAnte: summary.rules.omahaAnte ?? 0, postflopCap: summary.rules.postflopCap ?? 0 } };
  return {
    ...summary, rules: defaultHandRules(), boards: [[...summary.board]],
    runoutBoards: [[[...summary.board]]], runoutCount: 1, bounty: null,
    showdown: Object.keys(summary.revealed).length > 0,
    bountyAfter: Object.fromEntries(Object.keys(summary.balanceAfter).map(id => [id, 0])),
    results: summary.results.map((result, index) => ({ ...result, potIndex: index, boardIndex: 0, runoutIndex: 0 })),
  };
}
