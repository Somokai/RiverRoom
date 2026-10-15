import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type {
  AuditRow, ChipTransfer, Command, GameEvent, HandHistory, Identity, LedgerRow,
  Room, RoomSettings, RoomSummary,
} from '../shared/model.js';
import type { Database, Queryable } from './database.js';
import { assertRoom, createRoom, GameError, timeoutRunout, timeoutTurn, transition, type Transition } from './engine.js';
import { normalizeHistory, normalizeRoom } from './state.js';
import { getPlayerStats, recordPlayerStats } from './stats.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
interface RoomRow extends Record<string, unknown> { state: Room }
interface SessionRow extends Record<string, unknown> { id: string; name: string; csrf: string }
interface AuditDbRow extends Record<string, unknown> {
  seq: number; at: Date | string; actor_id: string; command: string;
  payload: { events: GameEvent[]; transfers: ChipTransfer[] };
  previous_hash: string; hash: string;
}

function accountBalances(room: Room | null): Map<string, number> {
  const balances = new Map<string, number>([['bank', 0]]);
  if (!room) return balances;
  for (const player of room.players) {
    balances.set(`player:${player.id}`, player.stack);
    if (!Number.isSafeInteger(player.bountyNet)) throw new Error('Invalid bounty settlement balance.');
    balances.set(`bounty:${player.id}`, player.bountyNet);
    balances.set('bank', balances.get('bank')! + player.cashOuts - player.buyIns);
  }
  if (room.hand) balances.set(`pot:${room.hand.id}`, room.hand.pot);
  return balances;
}
export function verifyTransfers(before: Room | null, after: Room, entries: ChipTransfer[]) {
  const balances = accountBalances(before);
  for (const entry of entries) {
    if (entry.from === entry.to || !Number.isSafeInteger(entry.chips) || entry.chips <= 0) throw new Error('Invalid ledger entry.');
    const bounty = entry.kind === 'bounty';
    if (bounty) {
      const recipient = after.players.find(player => entry.to === `bounty:${player.id}`);
      if (!entry.handId || entry.from !== `bounty:${entry.playerId}` || !after.players.some(player => player.id === entry.playerId) ||
          !recipient || entry.cashCents !== entry.chips * after.settings.chipValueCents)
        throw new Error('Invalid bounty settlement transfer.');
    } else if (entry.from.startsWith('bounty:') || entry.to.startsWith('bounty:')) {
      throw new Error('Only bounty entries may change bounty settlement balances.');
    }
    balances.set(entry.from, (balances.get(entry.from) ?? 0) - entry.chips);
    balances.set(entry.to, (balances.get(entry.to) ?? 0) + entry.chips);
    if (!bounty && entry.from !== 'bank' && balances.get(entry.from)! < 0) throw new Error('Ledger debit exceeds available chips.');
  }
  const expected = accountBalances(after);
  for (const account of new Set([...balances.keys(), ...expected.keys()]))
    if ((balances.get(account) ?? 0) !== (expected.get(account) ?? 0)) throw new Error(`Ledger does not reconcile for ${account}.`);
}

function auditRecord(row: AuditDbRow): AuditRow {
  return {
    seq: row.seq, at: new Date(row.at).toISOString(), actorId: row.actor_id, command: row.command,
    events: row.payload.events, transfers: row.payload.transfers,
    previousHash: row.previous_hash, hash: row.hash,
  };
}

export class Store {
  constructor(public db: Database) {}

  async identity(token: string | undefined): Promise<Identity | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.db.query<SessionRow>(
      `SELECT u.id, u.name, s.csrf FROM rr_sessions s JOIN rr_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > NOW()`, [digest(token)]);
    return result.rows[0] ?? null;
  }
  private async newSession(tx: Queryable, id: string, name: string) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await tx.query(
      "INSERT INTO rr_sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '30 days')",
      [digest(token), id, csrf]);
    return { user: { id, name, csrf }, token };
  }
  async createIdentity(name: string) {
    return this.db.transaction(async tx => {
      const id = randomUUID();
      const recoveryCode = `RR-${randomBytes(24).toString('base64url')}`;
      await tx.query('INSERT INTO rr_users(id,name,recovery_hash) VALUES($1,$2,$3)', [id, name, digest(recoveryCode)]);
      return { ...await this.newSession(tx, id, name), recoveryCode };
    });
  }
  async recover(recoveryCode: string) {
    return this.db.transaction(async tx => {
      const result = await tx.query<SessionRow>('SELECT id,name FROM rr_users WHERE recovery_hash=$1 FOR UPDATE', [digest(recoveryCode.trim())]);
      const user = result.rows[0];
      if (!user) throw new GameError('That recovery key is not valid.', 401);
      await tx.query('DELETE FROM rr_sessions WHERE user_id=$1', [user.id]);
      return this.newSession(tx, user.id, user.name);
    });
  }
  async logout(token: string) { await this.db.query('DELETE FROM rr_sessions WHERE token_hash=$1', [digest(token)]); }

  async playerStats(userId: string) { return getPlayerStats(this.db, userId); }

  async getRoom(idOrCode: string, tx: Queryable = this.db, lock = false): Promise<Room> {
    const result = await tx.query<RoomRow>(
      `SELECT state FROM rr_rooms WHERE id=$1 OR code=$2${lock ? ' FOR UPDATE' : ''}`,
      [idOrCode, idOrCode.toUpperCase()]);
    const room = result.rows[0]?.state;
    if (!room) throw new GameError('Table not found. Check the invite code.', 404);
    return normalizeRoom(room);
  }
  requireMember(room: Room, userId: string) {
    if (!room.players.some(player => player.id === userId)) throw new GameError('Join this table to view its records.', 403);
  }
  async rooms(userId: string): Promise<RoomSummary[]> {
    const rows = await this.db.query<RoomRow>(
      `SELECT r.state FROM rr_rooms r JOIN rr_members m ON m.room_id=r.id
       WHERE m.user_id=$1 ORDER BY r.updated_at DESC LIMIT 100`, [userId]);
    return rows.rows.map(({ state }) => {
      const room = normalizeRoom(state);
      const player = room.players.find(item => item.id === userId)!;
      const committed = room.hand?.street !== 'complete' ? room.hand?.players.find(item => item.id === userId)?.committed ?? 0 : 0;
      const chipNet = player.stack + committed + player.cashOuts - player.buyIns;
      return {
        id: room.id, name: room.name, code: room.code, status: room.status,
        playerCount: room.players.filter(item => item.seat !== null).length,
        handNumber: room.handNumber, stack: player.stack,
        net: chipNet + player.bountyNet, chipNet, bountyNet: player.bountyNet, buyIns: player.buyIns,
        host: room.hostId === userId, createdAt: room.createdAt,
      };
    });
  }

  private async record(tx: Queryable, before: Room | null, result: Transition, actorId: string, command: string) {
    const room = result.room;
    assertRoom(room);
    verifyTransfers(before, room, result.transfers);
    await tx.query('UPDATE rr_rooms SET state=$2::jsonb,version=$3,status=$4,updated_at=NOW() WHERE id=$1',
      [room.id, JSON.stringify(room), room.version, room.status]);
    for (const player of room.players) {
      await tx.query('INSERT INTO rr_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room.id, player.id]);
    }
    const previous = (await tx.query<{ seq: number; hash: string }>(
      'SELECT seq,hash FROM rr_audit WHERE room_id=$1 ORDER BY seq DESC LIMIT 1', [room.id])).rows[0];
    const seq = (previous?.seq ?? 0) + 1;
    const at = new Date().toISOString();
    const previousHash = previous?.hash ?? '0'.repeat(64);
    const payload = { events: result.events, transfers: result.transfers };
    const hash = digest(canonical({ roomId: room.id, seq, at, actorId, command, previousHash, ...payload }));
    await tx.query(
      'INSERT INTO rr_audit(room_id,seq,at,actor_id,command,payload,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
      [room.id, seq, at, actorId, command, JSON.stringify(payload), previousHash, hash]);
    for (const entry of result.transfers)
      await tx.query('INSERT INTO rr_ledger(room_id,transaction_id,at,entry) VALUES($1,$2,$3,$4::jsonb)',
        [room.id, `${room.id}:${seq}`, at, JSON.stringify(entry)]);
    const hand = room.hand;
    if (hand?.street === 'complete' && (before?.hand?.id !== hand.id || before.hand.street !== 'complete')) {
      const summary: HandHistory = {
        id: hand.id, number: hand.number, board: hand.board, buttonSeat: hand.buttonSeat,
        rules: hand.rules, boards: hand.boards, runoutBoards: hand.runoutBoards, runoutCount: hand.runoutCount,
        bounty: hand.bounty, bountyAfter: hand.bountyAfter, showdown: hand.showdown,
        pot: hand.awardedPot, completedAt: hand.completedAt!, results: hand.results,
        revealed: hand.revealed, balanceAfter: hand.balanceAfter,
      };
      await tx.query('INSERT INTO rr_hands(room_id,hand_id,hand_number,summary) VALUES($1,$2,$3,$4::jsonb)',
        [room.id, hand.id, hand.number, JSON.stringify(summary)]);
    }
    await recordPlayerStats(tx, before, result, actorId, command);
  }

  async create(user: Identity, input: { name: string; settings: RoomSettings; buyIn: number; commandId: string }): Promise<Room> {
    // A caller's create key is stable across retries, so a lost response cannot create two sessions.
    const id = digest(`${user.id}:${input.commandId}`).slice(0, 32);
    const fingerprint = digest(canonical({ name: input.name, settings: input.settings, buyIn: input.buyIn }));
    return this.db.transaction(async tx => {
      await tx.query('SELECT id FROM rr_users WHERE id=$1 FOR UPDATE', [user.id]);
      const existing = (await tx.query<RoomRow>('SELECT state FROM rr_rooms WHERE id=$1', [id])).rows[0];
      if (existing) {
        const command = (await tx.query<{ digest: string }>(
          'SELECT digest FROM rr_commands WHERE room_id=$1 AND actor_id=$2 AND command_id=$3', [id, user.id, input.commandId])).rows[0];
        if (!command || command.digest !== fingerprint) throw new GameError('That creation key was already used for a different table request.', 409);
        return normalizeRoom(existing.state);
      }
      const count = (await tx.query<{ count: number | string }>(
        "SELECT COUNT(*) AS count FROM rr_rooms WHERE state->>'hostId'=$1 AND status='open'", [user.id])).rows[0];
      if (Number(count?.count ?? 0) >= 20) throw new GameError('Close an existing session before opening another.');
      let code: string;
      for (;;) {
        code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
        if (!(await tx.query('SELECT id FROM rr_rooms WHERE code=$1', [code])).rows.length) break;
      }
      const result = createRoom({ id, code, hostId: user.id, hostName: user.name, ...input }, { now: Date.now() });
      await tx.query('INSERT INTO rr_rooms(id,code,state,version,status) VALUES($1,$2,$3::jsonb,$4,$5)',
        [id, code, JSON.stringify(result.room), result.room.version, result.room.status]);
      await this.record(tx, null, result, user.id, 'create');
      await tx.query('INSERT INTO rr_commands(room_id,actor_id,command_id,digest) VALUES($1,$2,$3,$4)',
        [id, user.id, input.commandId, fingerprint]);
      return result.room;
    });
  }

  async execute(
    id: string, actorId: string, commandId: string, command: Command,
    expectedVersion: number | undefined, system = false,
  ): Promise<{ room: Room; duplicate: boolean }> {
    return this.db.transaction(async tx => {
      const room = await this.getRoom(id, tx, true);
      const fingerprint = digest(canonical(command));
      const previous = (await tx.query<{ digest: string }>(
        'SELECT digest FROM rr_commands WHERE room_id=$1 AND actor_id=$2 AND command_id=$3',
        [room.id, actorId, commandId])).rows[0];
      if (previous) {
        if (previous.digest !== fingerprint) throw new GameError('That request key was already used for another action.', 409);
        return { room, duplicate: true };
      }
      if (command.type !== 'join') {
        this.requireMember(room, actorId);
        if (expectedVersion !== room.version) throw new GameError('The table changed. Your view has been refreshed; choose your action again.', 409);
      }
      if (command.type === 'join' && room.players.some(player => player.id === actorId && player.seat !== null)) {
        return { room, duplicate: true };
      }
      const result = transition(room, actorId, command, { now: Date.now(), system });
      await this.record(tx, room, result, actorId, command.type === 'act' ? command.action : command.type);
      await tx.query('INSERT INTO rr_commands(room_id,actor_id,command_id,digest) VALUES($1,$2,$3,$4)',
        [room.id, actorId, commandId, fingerprint]);
      return { room: result.room, duplicate: false };
    });
  }

  async openRooms(): Promise<Room[]> {
    return (await this.db.query<RoomRow>("SELECT state FROM rr_rooms WHERE status='open'")).rows.map(row => normalizeRoom(row.state));
  }
  async timeout(id: string, expectedVersion: number): Promise<Room | null> {
    return this.db.transaction(async tx => {
      const room = await this.getRoom(id, tx, true);
      if (room.version !== expectedVersion) return null;
      const voting = Boolean(room.hand?.runoutVote);
      const result = voting ? timeoutRunout(room, Date.now()) : timeoutTurn(room, Date.now());
      if (!result) return null;
      const actor = voting ? 'system' : room.hand?.actorId;
      if (!actor) throw new Error('A timed-out turn has no actor.');
      await this.record(tx, room, result, actor, voting ? 'runout_timeout' : 'turn_timeout');
      return result.room;
    });
  }
  async pauseAfterRestart() {
    for (const room of await this.openRooms()) {
      if (!room.hand || room.paused || (room.hand.street === 'complete' && !room.nextHandAt)) continue;
      await this.execute(room.id, room.hostId, `restart-${randomUUID()}`, { type: 'pause', value: true }, room.version, true);
    }
  }
  async ledger(roomId: string, before?: number, limit = 100): Promise<{ entries: LedgerRow[]; nextCursor: number | null }> {
    const rows = await this.db.query<{ id: string | number; at: Date | string; transaction_id: string; entry: ChipTransfer }>(
      'SELECT id,at,transaction_id,entry FROM rr_ledger WHERE room_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',
      [roomId, before ?? null, limit + 1]);
    const data = rows.rows.slice(0, limit).map(row => ({ ...row.entry, id: Number(row.id), at: new Date(row.at).toISOString(), transactionId: row.transaction_id }));
    return { entries: data, nextCursor: rows.rows.length > limit ? data.at(-1)!.id : null };
  }
  async audit(roomId: string, before?: number, limit = 100): Promise<{ entries: AuditRow[]; nextCursor: number | null }> {
    const rows = await this.db.query<AuditDbRow>(
      'SELECT seq,at,actor_id,command,payload,previous_hash,hash FROM rr_audit WHERE room_id=$1 AND ($2::integer IS NULL OR seq<$2) ORDER BY seq DESC LIMIT $3',
      [roomId, before ?? null, limit + 1]);
    const entries = rows.rows.slice(0, limit).map(auditRecord);
    return { entries, nextCursor: rows.rows.length > limit ? entries.at(-1)!.seq : null };
  }
  async hands(roomId: string, before?: number): Promise<{ entries: HandHistory[]; nextCursor: number | null }> {
    const rows = await this.db.query<{ summary: HandHistory }>(
      'SELECT summary FROM rr_hands WHERE room_id=$1 AND ($2::integer IS NULL OR hand_number<$2) ORDER BY hand_number DESC LIMIT 31',
      [roomId, before ?? null]);
    const entries = rows.rows.slice(0, 30).map(row => normalizeHistory(row.summary));
    return { entries, nextCursor: rows.rows.length > 30 ? entries.at(-1)!.number : null };
  }
  async exportSnapshot(roomId: string, userId: string) {
    return this.db.transaction(async tx => {
      const room = await this.getRoom(roomId, tx, true);
      this.requireMember(room, userId);
      const end = (await tx.query<{ audit_seq: number; ledger_id: number | string }>(
        `SELECT (SELECT COALESCE(MAX(seq),0) FROM rr_audit WHERE room_id=$1) AS audit_seq,
                (SELECT COALESCE(MAX(id),0) FROM rr_ledger WHERE room_id=$1) AS ledger_id`, [room.id])).rows[0]!;
      return { room, auditBefore: end.audit_seq + 1, ledgerBefore: Number(end.ledger_id) + 1 };
    });
  }
  async verifyAudit(roomId: string) {
    let previousHash = '0'.repeat(64);
    let count = 0;
    let after = 0;
    for (;;) {
      const rows = (await this.db.query<AuditDbRow>(
        'SELECT seq,at,actor_id,command,payload,previous_hash,hash FROM rr_audit WHERE room_id=$1 AND seq>$2 ORDER BY seq LIMIT 500',
        [roomId, after])).rows;
      for (const raw of rows) {
        const row = auditRecord(raw);
        const expected = digest(canonical({ roomId, seq: row.seq, at: row.at, actorId: row.actorId, command: row.command, previousHash, events: row.events, transfers: row.transfers }));
        if (row.seq !== count + 1 || row.previousHash !== previousHash || row.hash !== expected) return { valid: false, count, brokenAt: row.seq };
        previousHash = row.hash; count++; after = row.seq;
      }
      if (rows.length < 500) return { valid: true, count, head: previousHash };
    }
  }
}
