import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { io, type Socket } from 'socket.io-client';
import { chooseBotAction } from '../server/bot.js';
import {
  DEFAULT_SETTINGS, GAME_LABELS, defaultHandRules, isLegacyIndianHand, presetRaise,
  type Command, type GameVariant, type HandHistory, type Identity, type LedgerRow, type RoomView, type RunoutCount,
} from '../shared/model.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
export interface RunOptions {
  hands: number; players: number; nativeHands: number; delayMs: number; timeoutSeconds: number; output: string;
  games: GameVariant[]; maxRunouts: RunoutCount; bounty: number; buildDir: string;
}
export function optionsFrom(args: string[]): RunOptions {
  const { values } = parseArgs({ args, options: {
    hands: { type: 'string', default: '24' },
    players: { type: 'string', default: '6' },
    'native-hands': { type: 'string', default: '3' },
    'action-delay-ms': { type: 'string', default: '125' },
    'timeout-seconds': { type: 'string', default: '600' },
    output: { type: 'string', default: join('.artifacts', 'local-bot-run.json') },
    games: { type: 'string', default: 'holdem' },
    'max-runouts': { type: 'string', default: '1' },
    bounty: { type: 'string', default: '0' },
    'build-dir': { type: 'string', default: 'dist' },
  } });
  const integer = (value: string | undefined, name: string, min: number, max: number) => {
    const result = Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return result;
  };
  const output = resolve(project, values.output!);
  if (!output.toLowerCase().endsWith('.json')) throw new Error('The bot report output must be a .json file.');
  const games: GameVariant[] = [];
  for (const value of values.games!.split(',')) {
    if (value !== 'holdem' && value !== 'omaha' && value !== 'omaha_bomb' && value !== 'indian')
      throw new Error('games must contain holdem, omaha, omaha_bomb, or indian.');
    games.push(value);
  }
  const maxRunouts = integer(values['max-runouts'], 'max-runouts', 1, 3);
  if (maxRunouts !== 1 && maxRunouts !== 2 && maxRunouts !== 3) throw new Error('Invalid runout count.');
  return {
    hands: integer(values.hands, 'hands', 1, 200),
    players: integer(values.players, 'players', 2, 9),
    nativeHands: integer(values['native-hands'], 'native-hands', 1, 20),
    delayMs: integer(values['action-delay-ms'], 'action-delay-ms', 100, 2000),
    timeoutSeconds: integer(values['timeout-seconds'], 'timeout-seconds', 30, 3600),
    output,
    games, maxRunouts, bounty: integer(values.bounty, 'bounty', 0, 10_000_000),
    buildDir: resolve(project, values['build-dir']!),
  };
}

export function assertPrivateView(room: RoomView, userId: string) {
  assert.equal(room.youId, userId, 'A player received another identity\'s room view.');
  const hand = room.hand;
  const indian = hand?.rules.game === 'indian';
  const legacyIndian = !!hand && isLegacyIndianHand(hand);
  const cardCount = legacyIndian ? 1 : hand?.rules.game === 'omaha' || hand?.rules.game === 'omaha_bomb' ? 4 : 2;
  if (room.hand) {
    for (const field of ['deck', 'burned', 'holeCards']) assert(!Object.hasOwn(room.hand, field), `Private ${field} was sent to a client.`);
    assert.deepEqual(room.hand.board, room.hand.boards[0] ?? [], 'The first-board projection disagrees with the canonical boards.');
    if (Object.keys(room.hand.revealed).length > 0) {
      assert(room.hand.street === 'complete' && (indian || room.hand.showdown || room.hand.bounty), 'Private hands were revealed before a completed showdown or bounty award.');
      if (!legacyIndian && room.hand.showdown) assert.equal(room.hand.board.length, 5, 'A community-card showdown needs a complete board.');
      for (const id of Object.keys(room.hand.revealed)) {
        assert(room.hand.players.some(player => player.id === id && (indian || !player.folded)), 'A folded or absent player\'s hand was revealed.');
        if (!room.hand.showdown && !indian) assert.equal(id, room.hand.bounty?.winnerId, 'An unrelated hand was revealed for a bounty.');
      }
    }
    if (room.hand.bounty) {
      assert.equal(room.hand.rules.game, 'holdem', 'A non-Holdem hand awarded a 7-2 bounty.');
      const cards = room.hand.revealed[room.hand.bounty.winnerId];
      assert(cards?.length === 2 && cards.map(card => card[0]).sort().join('') === '27' && cards[0]![1] !== cards[1]![1],
        'A bounty winner did not show seven-deuce offsuit.');
    }
  }
  for (const player of room.players) {
    if (indian && hand?.street !== 'complete') {
      assert.equal(player.cards.length, player.hand ? cardCount : 0, 'Indian poker dealt the wrong number of cards.');
      if (player.id === userId && !player.hand?.folded) assert(player.cards.every(card => card === null), 'An Indian player saw their own hidden cards.');
      else assert(player.cards.every(card => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card)), 'An Indian opponent card is missing.');
    } else if (player.id === userId || (indian && player.hand)) {
      assert.equal(player.cards.length, player.hand ? cardCount : 0, 'Own card count is incorrect.');
      assert(player.cards.every(card => typeof card === 'string' && /^[2-9TJQKA][cdhs]$/.test(card)), 'Own cards are invalid.');
    } else if (room.hand?.revealed[player.id]) {
      assert.deepEqual(player.cards, room.hand.revealed[player.id], 'Showdown cards disagree with the public result.');
    } else {
      assert(player.cards.every(card => card === null), 'An opponent\'s unrevealed cards were exposed.');
      assert.equal(player.cards.length, player.hand ? cardCount : 0, 'An opponent\'s private card count is incorrect.');
    }
  }
}

export function assertAccounting(room: RoomView, ledger: LedgerRow[]) {
  assert.equal(new Set(ledger.map(entry => entry.id)).size, ledger.length, 'Duplicate ledger entries were returned.');
  const balances = new Map<string, number>();
  const fundingKinds = new Set(['buy_in', 'rebuy', 'add_on', 'cash_out']);
  const players = new Map(room.players.map(player => [player.id, { buyIns: 0, cashOuts: 0, rebuys: 0, addOns: 0 }]));
  for (const entry of ledger) {
    assert(['buy_in', 'rebuy', 'add_on', 'cash_out', 'blind', 'ante', 'bet', 'refund', 'payout', 'bounty'].includes(entry.kind), 'An unknown ledger entry type was returned.');
    assert(Number.isSafeInteger(entry.chips) && entry.chips > 0, 'Ledger chips must be positive whole numbers.');
    assert.notEqual(entry.from, entry.to, 'A ledger transfer cannot pay itself.');
    assert.equal(entry.cashCents, fundingKinds.has(entry.kind) || entry.kind === 'bounty' ? entry.chips * room.settings.chipValueCents : 0,
      'The chip/currency conversion does not reconcile.');
    const totals = players.get(entry.playerId);
    assert(totals, 'The ledger refers to an unknown player.');
    const account = `player:${entry.playerId}`;
    if (entry.kind === 'bounty') {
      assert(entry.handId, 'A bounty is missing its originating hand.');
      assert.equal(entry.from, `bounty:${entry.playerId}`, 'A bounty debit belongs to the wrong participant.');
      assert(room.players.some(player => entry.to === `bounty:${player.id}`), 'A bounty credit belongs to an unknown participant.');
    } else if (fundingKinds.has(entry.kind)) {
      assert.equal(entry.from, entry.kind === 'cash_out' ? account : 'bank', 'The funding debit belongs to the wrong account.');
      assert.equal(entry.to, entry.kind === 'cash_out' ? 'bank' : account, 'The funding credit belongs to the wrong account.');
      if (entry.kind === 'cash_out') totals.cashOuts += entry.chips;
      else totals.buyIns += entry.chips;
      if (entry.kind === 'rebuy') totals.rebuys++;
      if (entry.kind === 'add_on') totals.addOns++;
    } else {
      assert(entry.handId, 'A poker transfer is missing its hand ID.');
      const payout = entry.kind === 'refund' || entry.kind === 'payout';
      assert.equal(entry.from, payout ? `pot:${entry.handId}` : account, 'The wager/payout debit belongs to the wrong account.');
      assert.equal(entry.to, payout ? account : `pot:${entry.handId}`, 'The wager/payout credit belongs to the wrong account.');
    }
    balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.chips);
    balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.chips);
  }
  const accounted = new Set<string>(['bank']);
  for (const player of room.players) {
    assert(Number.isSafeInteger(player.stack) && player.stack >= 0, 'A stack is negative or fractional.');
    const account = `player:${player.id}`;
    accounted.add(account);
    assert.equal(balances.get(account) ?? 0, player.stack, `The ledger does not match ${player.name}'s stack.`);
    accounted.add(`bounty:${player.id}`);
    assert.equal(balances.get(`bounty:${player.id}`) ?? 0, player.bountyNet, 'A bounty balance disagrees with the settlement ledger.');
    assert.equal(player.net, player.chipNet + player.bountyNet, 'Total session P/L does not include the separate bounty balance.');
    const totals = players.get(player.id)!;
    assert.equal(totals.buyIns, player.buyIns, `The ledger does not match ${player.name}'s funding.`);
    assert.equal(totals.cashOuts, player.cashOuts, `The ledger does not match ${player.name}'s cash-outs.`);
    assert.equal(totals.rebuys, player.rebuyCount, 'A rebuy counter disagrees with the ledger.');
    assert.equal(totals.addOns, player.addOnCount, 'An add-on counter disagrees with the ledger.');
  }
  for (const [account, chips] of balances) {
    if (accounted.has(account)) continue;
    assert(account.startsWith('pot:'), 'An unexpected account exists in the ledger.');
    assert.equal(chips, account === `pot:${room.hand?.id}` ? room.hand?.pot ?? 0 : 0, 'Pot escrow does not reconcile.');
  }
  const funded = room.players.reduce((sum, player) => sum + player.buyIns, 0);
  const cashedOut = room.players.reduce((sum, player) => sum + player.cashOuts, 0);
  assert.equal(balances.get('bank') ?? 0, cashedOut - funded, 'The bank account does not reconcile.');
  assert.equal(room.players.reduce((sum, player) => sum + player.stack, 0) + (room.hand?.pot ?? 0), funded - cashedOut,
    'Session chip conservation failed.');
  assert.equal([...balances.values()].reduce((sum, value) => sum + value, 0), 0, 'The ledger is not balanced.');
  assert.equal(room.players.reduce((sum, player) => sum + player.bountyNet, 0), 0, 'Bounty obligations are not zero-sum.');
}

export function testAction(room: RoomView, pattern = room.hand?.number ?? 0): Extract<Command, { type: 'act' }> {
  const legal = room.legal;
  assert(legal.canAct && room.hand, 'The test bot was asked to act out of turn.');
  const player = room.players.find(item => item.id === room.youId)!;
  const fallback = (): Extract<Command, { type: 'act' }> => ({ type: 'act', action: legal.canCheck ? 'check' : 'call' });
  switch (pattern % 6) {
    case 1: return fallback();
    case 2:
      if (legal.canRaise && room.hand.currentBet <= room.settings.bigBlind)
        return { type: 'act', action: 'raise', amount: presetRaise(legal, player.hand?.streetBet ?? 0, room.settings.bigBlind,
          room.hand.street === 'preflop' ? { bb: 3 } : { pot: 0.5 }) };
      return fallback();
    case 3: return legal.canRaise ? { type: 'act', action: 'raise', amount: legal.maxRaiseTo } : fallback();
    case 4:
      if (legal.canRaise && room.hand.currentBet === 0)
        return { type: 'act', action: 'raise', amount: presetRaise(legal, player.hand?.streetBet ?? 0, room.settings.bigBlind, { pot: 0.75 }) };
      return fallback();
    case 5: return { type: 'act', action: 'fold' };
    default: return chooseBotAction(room);
  }
}

interface Counters { privacyViews: number; socketViews: number; ledgerCheckpoints: number; commands: number; duplicateReplays: number; reconnects: number; runoutVotes: number }
interface SessionResult {
  kind: 'authenticated-client-bots' | 'native-practice-bots';
  hands: number; ledgerEntries: number; auditRecords: number; showdowns: number; sidePots: number; refunds: number;
  rebuys: number; addOns: number; chipsFunded: number; chipsCashedOut: number;
  bounties: number; games: Partial<Record<GameVariant, number>>; multipleRunoutHands: number;
  runoutCounts: Record<'1' | '2' | '3', number>;
  players: Array<{ name: string; buyIns: number; cashOuts: number; chipProfitLoss: number; bountyNet: number; profitLoss: number; rebuys: number }>;
}
interface RunReport {
  status: 'passed' | 'failed'; startedAt: string; finishedAt: string; durationMs: number;
  options: Omit<RunOptions, 'output'>; checks: Counters; sessions: SessionResult[]; error?: string;
}
class TestClient {
  user: Identity | null = null;
  private cookie = '';
  private socket: Socket | null = null;
  private socketFault: Error | null = null;
  constructor(private base: string, private signal: AbortSignal, private counters: Counters) {}
  ensureHealthy() { if (this.socketFault) throw this.socketFault; this.signal.throwIfAborted(); }
  async request<T>(path: string, body?: object): Promise<T> {
    this.ensureHealthy();
    const response = await fetch(`${this.base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: this.base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.user ? { 'X-CSRF-Token': this.user.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    });
    const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
    if (cookie) this.cookie = cookie;
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} on ${path}: ${typeof result.error === 'string' ? result.error : 'Unexpected API error'}`);
    return result as T;
  }
  async register(name: string) {
    this.user = (await this.request<{ user: Identity }>('/auth/guest', { name })).user;
    assert(this.user?.id && this.user.csrf && this.cookie, 'Guest authentication did not return a usable session.');
  }
  checked(room: RoomView): RoomView {
    assertPrivateView(room, this.user!.id);
    this.counters.privacyViews++;
    return room;
  }
  async room(id: string) { return this.checked((await this.request<{ room: RoomView }>(`/rooms/${id}`)).room); }
  async command(room: RoomView, command: Command, commandId = randomUUID()) {
    const result = await this.request<{ room: RoomView; duplicate: boolean }>(`/rooms/${room.id}/commands`,
      { command, commandId, expectedVersion: room.version });
    this.counters.commands++;
    this.checked(result.room);
    return result;
  }
  async connect(roomId: string) {
    this.disconnect();
    const socket = io(this.base, {
      transports: ['websocket'], reconnection: false, auth: { csrf: this.user!.csrf },
      extraHeaders: { Cookie: this.cookie, Origin: this.base },
    });
    this.socket = socket;
    socket.on('room', (room: RoomView) => {
      try { this.checked(room); this.counters.socketViews++; }
      catch (error) { this.socketFault = error instanceof Error ? error : new Error('Socket privacy validation failed.'); }
    });
    socket.on('server_error', (message: string) => { this.socketFault = new Error(`Server reported: ${message}`); });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('The test bot could not subscribe to live updates.')), 15000);
      socket.on('connect_error', error => { clearTimeout(timer); this.socketFault = error; reject(error); });
      socket.once('connect', () => socket.emit('subscribe', roomId, (ack: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        if (ack.ok) done(); else reject(new Error(ack.error ?? 'The table subscription was rejected.'));
      }));
    });
    this.ensureHealthy();
  }
  disconnect() { this.socket?.removeAllListeners(); this.socket?.disconnect(); this.socket = null; }
}

async function ledger(client: TestClient, roomId: string) {
  const entries: LedgerRow[] = [];
  let cursor: number | null = null;
  do {
    const page: { entries: LedgerRow[]; nextCursor: number | null } = await client.request(
      `/rooms/${roomId}/ledger${cursor === null ? '' : `?before=${cursor}`}`);
    entries.push(...page.entries); cursor = page.nextCursor;
  } while (cursor !== null);
  return entries;
}
async function checkpoint(client: TestClient, room: RoomView, counters: Counters) {
  assertAccounting(room, await ledger(client, room.id));
  counters.ledgerCheckpoints++;
}
async function resultFor(client: TestClient, room: RoomView, kind: SessionResult['kind'], counters: Counters): Promise<SessionResult> {
  const entries = await ledger(client, room.id);
  assertAccounting(room, entries); counters.ledgerCheckpoints++;
  assert.equal(room.status, 'closed', 'The test session did not close.');
  assert(room.players.every(player => player.stack === 0), 'A test stack remained after cash-out.');
  const integrity = await client.request<{ valid: boolean; count: number }>(`/rooms/${room.id}/integrity`);
  assert(integrity.valid, 'The audit hash chain failed verification.');
  const hands: HandHistory[] = [];
  let cursor: number | null = null;
  do {
    const page: { entries: HandHistory[]; nextCursor: number | null } = await client.request(`/rooms/${room.id}/hands${cursor === null ? '' : `?before=${cursor}`}`);
    hands.push(...page.entries); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(hands.length, room.handNumber, 'Completed hand history was truncated or lost.');
  const exported = await client.request<{ room: RoomView; audit: unknown[] }>(`/rooms/${room.id}/export.json`);
  assertPrivateView(exported.room, client.user!.id);
  assert.equal(exported.audit.length, integrity.count, 'The JSON export is missing audit records.');
  return {
    kind, hands: hands.length, ledgerEntries: entries.length, auditRecords: integrity.count,
    showdowns: hands.filter(hand => hand.showdown).length,
    sidePots: hands.reduce((sum, hand) => sum + Math.max(0, new Set(hand.results.map(pot => pot.potIndex)).size - 1), 0),
    bounties: hands.filter(hand => hand.bounty).length,
    games: Object.fromEntries(Object.keys(GAME_LABELS).map(game => [game, hands.filter(hand => hand.rules.game === game).length])),
    multipleRunoutHands: hands.filter(hand => hand.runoutCount > 1).length,
    runoutCounts: {
      '1': hands.filter(hand => hand.runoutCount === 1).length,
      '2': hands.filter(hand => hand.runoutCount === 2).length,
      '3': hands.filter(hand => hand.runoutCount === 3).length,
    },
    refunds: entries.filter(entry => entry.kind === 'refund').length,
    rebuys: room.players.reduce((sum, player) => sum + player.rebuyCount, 0),
    addOns: room.players.reduce((sum, player) => sum + player.addOnCount, 0),
    chipsFunded: room.players.reduce((sum, player) => sum + player.buyIns, 0),
    chipsCashedOut: room.players.reduce((sum, player) => sum + player.cashOuts, 0),
    players: room.players.map(player => ({ name: player.name, buyIns: player.buyIns, cashOuts: player.cashOuts,
      chipProfitLoss: player.cashOuts - player.buyIns, bountyNet: player.bountyNet,
      profitLoss: player.cashOuts - player.buyIns + player.bountyNet, rebuys: player.rebuyCount })),
  };
}
async function createTable(host: TestClient, seats: number, name: string) {
  return host.checked((await host.request<{ room: RoomView }>('/rooms', {
    name, settings: { ...DEFAULT_SETTINGS, maxSeats: seats, minBuyIn: 1000, autoDeal: false, turnSeconds: 120 },
    buyIn: 4000, commandId: randomUUID(),
  })).room);
}
async function fundGuest(host: TestClient, player: TestClient, room: RoomView, amount: number) {
  room = (await player.command(room, { type: 'fund', amount })).room;
  const pending = room.requests.find(request => request.playerId === player.user!.id && request.status === 'pending');
  if (pending) room = (await host.command(room, { type: 'approve', requestId: pending.id, approve: true })).room;
  return room;
}

async function clientSession(clients: TestClient[], options: RunOptions, counters: Counters) {
  const host = clients[0]!;
  let room = await createTable(host, clients.length, 'Isolated local client-bot test');
  for (let i = 1; i < clients.length; i++) {
    const player = clients[i]!;
    room = player.checked((await player.request<{ room: RoomView }>('/rooms/join', { code: room.code, commandId: randomUUID() })).room);
    room = await fundGuest(host, player, room, 4000 + i * 500);
  }
  for (const player of clients) await player.connect(room.id);
  const replayId = randomUUID();
  const beforeAddOn = room;
  const addOn: Command = { type: 'fund', amount: 500 };
  room = (await host.command(room, addOn, replayId)).room;
  const retry = await host.command(beforeAddOn, addOn, replayId);
  assert(retry.duplicate && retry.room.version === room.version, 'A retried add-on changed the game twice.');
  counters.duplicateReplays++;
  await checkpoint(host, room, counters);
  for (let hand = 1; hand <= options.hands; hand++) {
    for (const player of clients) {
      if (room.players.find(item => item.id === player.user!.id)!.stack === 0)
        room = await fundGuest(host, player, room, 4000 + clients.indexOf(player) * 500);
    }
    room = (await host.command(room, { type: 'next_hand', rules: {
      ...defaultHandRules(room.settings), game: options.games[(hand - 1) % options.games.length]!,
      maxRunouts: options.maxRunouts, sevenDeuceBounty: options.bounty,
    } })).room;
    room = (await host.command(room, { type: 'deal' })).room;
    assert(room.hand && room.hand.number === hand, 'The requested client-bot hand did not start.');
    let turns = 0;
    while (room.hand?.street !== 'complete') {
      assert(++turns <= 400, 'A test hand exceeded 400 actions without finishing.');
      for (const player of clients) player.ensureHealthy();
      if (room.hand?.runoutVote) {
        const vote = room.hand.runoutVote;
        const voter = clients.find(client => vote.eligible.includes(client.user!.id) && vote.votes[client.user!.id] === undefined);
        assert(voter, 'No authenticated participant can resolve the pending runout choice.');
        room = (await voter.command(room, { type: 'runouts', handId: room.hand.id, count: vote.maxRuns })).room;
        counters.runoutVotes++;
        continue;
      }
      const actor = clients.find(player => player.user!.id === room.hand?.actorId);
      assert(actor, 'The next actor has no authenticated test client.');
      const view = await actor.room(room.id);
      room = (await actor.command(view, testAction(view, Math.floor((hand - 1) / options.games.length) + 1))).room;
      await sleep(options.delayMs);
    }
    await checkpoint(host, room, counters);
    if (hand === 1) {
      const returning = clients.at(-1)!;
      await returning.connect(room.id);
      await returning.room(room.id);
      counters.reconnects++;
      room = (await returning.command(room, { type: 'cash_out' })).room;
      room = returning.checked((await returning.request<{ room: RoomView }>('/rooms/join',
        { code: room.code, commandId: randomUUID() })).room);
      room = await fundGuest(host, returning, room, 4000 + (clients.length - 1) * 500);
      await checkpoint(host, room, counters);
    }
    if (hand % 5 === 0 || hand === options.hands) console.log(`Client bots: ${hand}/${options.hands} hands completed and reconciled.`);
  }
  room = (await host.command(room, { type: 'close' })).room;
  for (const player of clients) { player.ensureHealthy(); player.disconnect(); }
  assert.equal(room.handNumber, options.hands, 'The requested number of client-bot hands did not finish.');
  return resultFor(host, room, 'authenticated-client-bots', counters);
}

async function nativeSession(host: TestClient, options: RunOptions, counters: Counters) {
  let room = await createTable(host, 4, 'Isolated native practice-bot test');
  for (let i = 0; i < 3; i++) room = (await host.command(room, { type: 'add_bot' })).room;
  const firstBot = room.players.find(player => player.bot)!;
  room = (await host.command(room, { type: 'fund_bot', playerId: firstBot.id, amount: 500 })).room;
  room = (await host.command(room, { type: 'sit_out', value: true })).room;
  await host.connect(room.id);
  for (let hand = 1; hand <= options.nativeHands; hand++) {
    for (const player of room.players.filter(player => player.bot && player.stack === 0))
      room = (await host.command(room, { type: 'fund_bot', playerId: player.id, amount: 10000 })).room;
    room = (await host.command(room, { type: 'next_hand', rules: {
      ...defaultHandRules(room.settings), game: options.games[(hand - 1) % options.games.length]!,
      maxRunouts: options.maxRunouts, sevenDeuceBounty: options.bounty,
    } })).room;
    room = (await host.command(room, { type: 'deal' })).room;
    assert(room.hand && room.hand.number === hand, 'The requested native-bot hand did not start.');
    assert(!room.hand?.players.some(player => player.id === host.user!.id), 'The observing host was dealt into a bot-only hand.');
    while (room.hand?.street !== 'complete') {
      host.ensureHealthy();
      await sleep(800);
      room = await host.room(room.id);
    }
    await checkpoint(host, room, counters);
    console.log(`Native server bots: ${hand}/${options.nativeHands} hands completed and reconciled.`);
  }
  room = (await host.command(room, { type: 'close' })).room;
  host.ensureHealthy(); host.disconnect();
  assert.equal(room.handNumber, options.nativeHands, 'The requested native-bot hands did not finish.');
  return resultFor(host, room, 'native-practice-bots', counters);
}

async function freePort() {
  const listener = createServer();
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const address = listener.address();
  assert(address && typeof address !== 'string', 'No local test port was allocated.');
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  return address.port;
}
const isAlive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
function waitForExit(child: ChildProcess, milliseconds: number) {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise<boolean>(done => {
    const handler = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { child.off('exit', handler); done(false); }, milliseconds);
    child.once('exit', handler);
  });
}
async function stopServer(child: ChildProcess) {
  if (!isAlive(child)) {
    assert.equal(child.exitCode, 0, 'The local test server exited unexpectedly.');
    return;
  }
  const stopped = waitForExit(child, 10000);
  if (child.connected) child.send({ type: 'river-room:shutdown' });
  else child.kill('SIGTERM');
  if (!await stopped) {
    child.kill('SIGKILL');
    await waitForExit(child, 5000);
    throw new Error('The local test server did not shut down gracefully; its owned process was terminated.');
  }
  assert.equal(child.exitCode, 0, 'The local server reported an error during shutdown.');
}

export async function runLocalBots(options: RunOptions): Promise<RunReport> {
  const started = performance.now();
  const { output: _output, ...reportedOptions } = options;
  const counters: Counters = { privacyViews: 0, socketViews: 0, ledgerCheckpoints: 0, commands: 0, duplicateReplays: 0, reconnects: 0, runoutVotes: 0 };
  const report: RunReport = { status: 'failed', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0,
    options: reportedOptions, checks: counters, sessions: [] };
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutSeconds * 1000)]);
  const interrupted = () => abort.abort(new Error('The local bot test was cancelled.'));
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const clients: TestClient[] = [];
  let directory: string | null = null;
  let server: ChildProcess | null = null;
  let serverLog = '';
  let serverError = false;
  try {
    const entry = resolve(options.buildDir, 'server', 'index.js');
    await access(entry);
    directory = await mkdtemp(join(tmpdir(), 'river-room-bot-run-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const environment: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      APP_ORIGIN: base, DATA_DIR: join(directory, 'postgres'), DATABASE_SSL: 'false',
      DISABLE_SCHEDULER: 'false', TRUST_PROXY: '0',
      RIVER_ROOM_CLIENT_DIR: resolve(options.buildDir, 'client'),
    };
    for (const key of ['DATABASE_URL', 'HOST_KEY', 'RIVER_ROOM_PARENT_STDIN']) delete environment[key];
    server = spawn(process.execPath, [entry], {
      cwd: project, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      env: environment,
    });
    let spawnError: Error | null = null;
    let ownedReady = false;
    server.on('error', error => { spawnError = error; });
    server.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ready' &&
          'port' in message && message.port === port && 'host' in message && message.host === '127.0.0.1')
        ownedReady = true;
    });
    const capture = (data: Buffer) => {
      serverLog = (serverLog + data.toString()).slice(-6000);
      if (/(?:Game scheduler failed:|Room broadcast failed:|Database connection error:|"event"\s*:\s*"request_error"|River Room failed:)/.test(serverLog))
        serverError = true;
    };
    server.stdout?.on('data', capture); server.stderr?.on('data', capture);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (!isAlive(server)) throw new Error(`The isolated test server exited during startup. ${serverLog}`);
      if (!ownedReady) { await sleep(500); continue; }
      try {
        const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        ready = response.ok && (await response.json()).status === 'ready';
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
      }
      if (ready) break;
      await sleep(500);
    }
    assert(ready, `The isolated server did not become ready. ${serverLog}`);
    const homepage = await fetch(base, { signal });
    assert(homepage.ok && (await homepage.text()).includes('River Room'), 'The built local UI was not served.');
    console.log(`Local bot test: ${options.players} authenticated clients, ${options.hands} hands, isolated temporary database.`);
    for (let i = 0; i < options.players; i++) {
      const client = new TestClient(base, signal, counters);
      clients.push(client);
      await client.register(`Test Bot ${String(i + 1).padStart(2, '0')}`);
    }
    report.sessions.push(await clientSession(clients, options, counters));
    report.sessions.push(await nativeSession(clients[0]!, options, counters));
    assert(counters.socketViews > 0 && counters.privacyViews > 0, 'No real private socket delivery was checked.');
    assert(report.sessions.every(session => session.chipsFunded === session.chipsCashedOut), 'Final cash-outs do not match total funding.');
    report.status = 'passed';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const client of clients) client.disconnect();
    if (server) {
      try { await stopServer(server); }
      catch (error) { report.status = 'failed'; report.error = `${report.error ? `${report.error}; ` : ''}${error instanceof Error ? error.message : String(error)}`; }
    }
    if (directory && (!server || !isAlive(server))) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { report.status = 'failed'; report.error = `${report.error ? `${report.error}; ` : ''}Could not remove owned test data: ${error instanceof Error ? error.message : String(error)}`; }
    }
    if (serverError) {
      report.status = 'failed';
      report.error = `${report.error ? `${report.error}; ` : ''}The local server logged an error during the run or shutdown.`;
      console.error(serverLog);
    }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    report.finishedAt = new Date().toISOString(); report.durationMs = Math.round(performance.now() - started);
    await mkdir(dirname(options.output), { recursive: true });
    const temporary = `${options.output}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, options.output);
    } finally { await rm(temporary, { force: true }); }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    const report = await runLocalBots(options);
    console.log(`Bot run ${report.status}. Report: ${options.output}`);
    if (report.status !== 'passed') { console.error(report.error); process.exitCode = 1; }
    else console.log(`${report.sessions.reduce((sum, session) => sum + session.hands, 0)} completed hands; ${report.checks.privacyViews} private views; all in-play chips cashed out and bounty obligations reconciled.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
