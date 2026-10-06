export type Card = string;
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';
export type FundingKind = 'buy_in' | 'rebuy' | 'add_on';
export type GameVariant = 'holdem' | 'omaha' | 'omaha_bomb' | 'indian';
export type RunoutCount = 1 | 2 | 3;
export const GAME_LABELS: Record<GameVariant, string> = {
  holdem: "Texas Hold'em", omaha: 'Pot-limit Omaha', omaha_bomb: 'Double-board PLO bomb pot', indian: 'Indian poker (two cards)',
};

export interface HandRules {
  game: GameVariant;
  bombAnte: number;
  indianAnte: number;
  omahaAnte: number;
  sevenDeuceBounty: number;
  maxRunouts: RunoutCount;
}
export function defaultHandRules(settings: Pick<RoomSettings, 'bigBlind'> = DEFAULT_SETTINGS): HandRules {
  return {
    game: 'holdem', bombAnte: Math.min(10_000_000, settings.bigBlind * 5),
    indianAnte: settings.bigBlind, omahaAnte: settings.bigBlind, sevenDeuceBounty: 0, maxRunouts: 1,
  };
}
export function handAnte(rules: HandRules, settings: Pick<RoomSettings, 'ante'>): number {
  return rules.game === 'omaha_bomb' ? rules.bombAnte : rules.game === 'indian' ? rules.indianAnte
    : rules.game === 'omaha' && rules.omahaAnte > 0 ? rules.omahaAnte : settings.ante;
}

// Saved one-card Indian hands have no community-board slots; finish them under their original rules.
export function isLegacyIndianHand(hand: Pick<Hand, 'rules' | 'boards'>): boolean {
  return hand.rules.game === 'indian' && hand.boards.length === 0;
}
export function handGameLabel(hand: Pick<Hand, 'rules' | 'boards'>): string {
  return isLegacyIndianHand(hand) ? 'Indian poker (legacy one card)' : GAME_LABELS[hand.rules.game];
}
export interface RunoutVote {
  eligible: string[];
  votes: Record<string, RunoutCount>;
  maxRuns: RunoutCount;
  deadline: number | null;
}
export interface BountyAward {
  winnerId: string;
  payerIds: string[];
  amount: number;
  totalAmount: number;
}

export interface RoomSettings {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minBuyIn: number;
  maxBuyIn: number;
  chipValueCents: number;
  currency: 'USD' | 'EUR' | 'GBP' | 'CAD';
  maxSeats: number;
  turnSeconds: number;
  autoDeal: boolean;
  allowRebuys: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  smallBlind: 50, bigBlind: 100, ante: 0,
  minBuyIn: 500, maxBuyIn: 20000, chipValueCents: 1,
  currency: 'USD', maxSeats: 9, turnSeconds: 45,
  autoDeal: true, allowRebuys: true,
};

export interface Player {
  id: string;
  name: string;
  emoji?: string | null;
  seat: number | null;
  stack: number;
  buyIns: number;
  cashOuts: number;
  rebuyCount: number;
  addOnCount: number;
  bountyNet: number;
  sittingOut: boolean;
  timeoutCount: number;
  bot: boolean;
  joinedAt: number;
}

export interface HandPlayer {
  id: string;
  seat: number;
  committed: number;
  streetBet: number;
  folded: boolean;
  actedAtBet: number | null;
  lastAction: string;
}

export interface PotResult {
  potIndex: number;
  boardIndex: number;
  runoutIndex: number;
  amount: number;
  eligible: string[];
  winners: string[];
  shares: Record<string, number>;
  description: string;
}

export interface Hand {
  id: string;
  number: number;
  street: Street;
  board: Card[];
  rules: HandRules;
  boards: Card[][];
  runoutBoards: Card[][][];
  runoutPrefix: Card[][] | null;
  runoutCount: RunoutCount;
  runoutVote: RunoutVote | null;
  preflopPotAdjustment: number;
  bounty: BountyAward | null;
  deck: Card[];
  burned: Card[];
  holeCards: Record<string, Card[]>;
  players: HandPlayer[];
  buttonSeat: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  currentBet: number;
  minRaise: number;
  actorId: string | null;
  pot: number;
  awardedPot: number;
  turnStartedAt: number;
  deadline: number | null;
  startedAt: number;
  completedAt: number | null;
  showdown: boolean;
  results: PotResult[];
  revealed: Record<string, Card[]>;
  balanceAfter: Record<string, number>;
  bountyAfter: Record<string, number>;
}

export interface FundingRequest {
  id: string;
  playerId: string;
  kind: FundingKind;
  amount: number;
  status: 'pending' | 'approved' | 'applied' | 'declined';
  createdAt: number;
}

export interface GameEvent {
  id: string;
  at: number;
  kind: string;
  message: string;
  actorId?: string;
}

export interface ChipTransfer {
  kind: FundingKind | 'cash_out' | 'blind' | 'ante' | 'bet' | 'refund' | 'payout' | 'bounty';
  from: string;
  to: string;
  chips: number;
  cashCents: number;
  playerId: string;
  handId: string | null;
  note: string;
}

export interface Room {
  schemaVersion: number;
  id: string;
  code: string;
  name: string;
  hostId: string;
  createdAt: number;
  status: 'open' | 'closed';
  closedAt: number | null;
  version: number;
  settings: RoomSettings;
  nextHandRules: HandRules;
  pendingBlinds: { smallBlind: number; bigBlind: number; ante: number } | null;
  players: Player[];
  requests: FundingRequest[];
  hand: Hand | null;
  handNumber: number;
  dealerSeat: number | null;
  paused: boolean;
  endAfterHand: boolean;
  nextHandAt: number | null;
  events: GameEvent[];
}

export type Command =
  | { type: 'join'; name: string }
  | { type: 'deal' }
  | { type: 'act'; action: 'fold' | 'check' | 'call' | 'raise'; amount?: number }
  | { type: 'fund'; amount: number }
  | { type: 'approve'; requestId: string; approve: boolean }
  | { type: 'cash_out' }
  | { type: 'sit_out'; value: boolean }
  | { type: 'pause'; value: boolean }
  | { type: 'settings'; smallBlind: number; bigBlind: number; ante: number; autoDeal: boolean; turnSeconds: number; allowRebuys: boolean; minBuyIn?: number }
  | { type: 'next_hand'; rules: HandRules }
  | { type: 'runouts'; handId: string; count: RunoutCount }
  | { type: 'add_bot'; name?: string }
  | { type: 'fund_bot'; playerId: string; amount: number }
  | { type: 'remove_bot'; playerId: string }
  | { type: 'transfer_host'; playerId: string }
  | { type: 'close' }
  | { type: 'emoji'; emoji: string | null }
  | { type: 'chat'; message: string };

export interface LegalActions {
  canAct: boolean;
  canCheck: boolean;
  canRaise: boolean;
  toCall: number;
  callAmount: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  allInTo: number;
  canAllIn: boolean;
  bettingLimit: 'no_limit' | 'pot_limit';
  potLimitTo: number | null;
  potAfterCall: number;
  reason: string;
}

export interface PlayerView extends Player {
  connected: boolean;
  cards: Array<Card | null>;
  hand: HandPlayer | null;
  net: number;
  chipNet: number;
}

export interface HandView extends Omit<Hand, 'deck' | 'burned' | 'holeCards' | 'players'> {
  players: HandPlayer[];
}

export interface RoomView extends Omit<Room, 'players' | 'hand'> {
  players: PlayerView[];
  hand: HandView | null;
  youId: string;
  legal: LegalActions;
  serverTime: number;
}

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  status: 'open' | 'closed';
  playerCount: number;
  handNumber: number;
  stack: number;
  net: number;
  chipNet: number;
  bountyNet: number;
  buyIns: number;
  host: boolean;
  createdAt: number;
}

export interface Identity {
  id: string;
  name: string;
  csrf: string;
}

export interface LedgerRow extends ChipTransfer {
  id: number;
  at: string;
  transactionId: string;
}

export interface AuditRow {
  seq: number;
  at: string;
  actorId: string;
  command: string;
  events: GameEvent[];
  transfers: ChipTransfer[];
  previousHash: string;
  hash: string;
}

export interface HandHistory {
  id: string;
  number: number;
  board: Card[];
  rules: HandRules;
  boards: Card[][];
  runoutBoards: Card[][][];
  runoutCount: RunoutCount;
  bounty: BountyAward | null;
  showdown: boolean;
  buttonSeat: number;
  pot: number;
  completedAt: number;
  results: PotResult[];
  revealed: Record<string, Card[]>;
  balanceAfter: Record<string, number>;
  bountyAfter: Record<string, number>;
}

export function boardRuns(hand: Pick<Hand, 'boards' | 'runoutBoards'>): Card[][][] {
  return hand.runoutBoards.length ? hand.runoutBoards : [hand.boards];
}

const chipFormatter = new Intl.NumberFormat('en-US');
const currencyFormatters = new Map<string, Intl.NumberFormat>();
export const chips = (value: number) => chipFormatter.format(value);
export function money(value: number, currency: string = 'USD') {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(value / 100);
}

export function presetRaise(
  legal: LegalActions,
  streetBet: number,
  bigBlind: number,
  preset: { pot: number } | { bb: number },
): number {
  const requested = 'pot' in preset
    ? streetBet + legal.toCall + Math.floor(legal.potAfterCall * preset.pot)
    : Math.round(bigBlind * preset.bb);
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, requested));
}
