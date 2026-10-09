export const EMOTES = {
  hello: 'Hello',
  nice_hand: 'Nice hand!',
  sorry: 'Sorry...',
  well_played: 'Well played',
} as const;

export type EmoteId = keyof typeof EMOTES;
export const EMOTE_COOLDOWN_MS = 3000;
export const EMOTE_DURATION_MS = 4000;

export interface TableEmote {
  id: string;
  roomId: string;
  playerId: string;
  emote: EmoteId;
  at: number;
}

export interface EmoteRequest {
  roomId: string;
  emote: EmoteId;
}

export type EmoteResult =
  | { ok: true; event: TableEmote }
  | { ok: false; error: string; retryAfterMs?: number };
