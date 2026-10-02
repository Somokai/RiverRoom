import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Identity, Room, RoomView } from '../shared/model.js';
import { GameError, roomView } from './engine.js';
import { Store } from './store.js';
import { chooseBotAction } from './bot.js';
import { commandEnvelope, createSchema, displayName } from './validation.js';

export interface AppConfig {
  origin: string;
  hostKey?: string;
  production: boolean;
  trustProxy: boolean;
  scheduler: boolean;
  staticDirectory?: string;
}
interface SocketData { user: Identity; roomId?: string; token: string }
interface ClientEvents { subscribe: (roomId: string, ack: (result: { ok: boolean; error?: string }) => void) => void }
interface ServerEvents { room: (room: RoomView) => void; server_error: (message: string) => void }
type AuthRequest = Request & { identity?: Identity; sessionToken?: string };

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function makeApp(store: Store, config: AppConfig) {
  const app = express();
  const http = createServer(app);
  const origin = new URL(config.origin).origin;
  const secure = origin.startsWith('https://');
  const cookieName = secure ? '__Host-river-session' : 'river-session';
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", secure ? 'wss:' : 'ws:'],
      fontSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: secure ? [] : null,
    } },
    strictTransportSecurity: secure ? undefined : false,
  }));
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60000, limit: config.production ? 300 : 2000, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute.' } }));
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers.origin !== origin || !req.is('application/json')) return next(new GameError('Request origin or content type is not allowed.', 403));
    next();
  });
  app.use('/api', async (req: AuthRequest, _res, next) => {
    req.sessionToken = readCookie(req.headers.cookie, cookieName);
    req.identity = await store.identity(req.sessionToken) ?? undefined;
    next();
  });
  const requireUser = (req: AuthRequest, _res: Response, next: NextFunction) =>
    req.identity ? next() : next(new GameError('Sign in to your player profile first.', 401));
  const csrf = (req: AuthRequest, _res: Response, next: NextFunction) =>
    req.identity && constantEqual(String(req.headers['x-csrf-token'] ?? ''), req.identity.csrf)
      ? next() : next(new GameError('Your session changed. Refresh and try again.', 403));
  const setSession = (res: Response, token: string) =>
    res.cookie(cookieName, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 30 * 86400000 });

  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>(http, {
    maxHttpBufferSize: 2048,
    allowRequest: (req, done) => done(null, !req.headers.origin || req.headers.origin === origin),
  });
  io.use(async (socket, next) => {
    try {
      const token = readCookie(socket.request.headers.cookie, cookieName);
      const user = await store.identity(token);
      const supplied: unknown = socket.handshake.auth.csrf;
      if (!user || !token || typeof supplied !== 'string' || !constantEqual(supplied, user.csrf)) return next(new Error('Session expired.'));
      socket.data.user = user; socket.data.token = token;
      next();
    } catch (error) { console.error('Socket authentication failed:', error instanceof Error ? error.message : 'unknown'); next(new Error('Unable to authenticate.')); }
  });
  async function broadcast(roomId: string) {
    const sockets = await io.in(roomId).fetchSockets();
    if (!sockets.length) return;
    const room = await store.getRoom(roomId);
    const connected = new Set(sockets.map(socket => socket.data.user.id));
    for (const socket of sockets) socket.emit('room', roomView(room, socket.data.user.id, connected));
  }
  function safelyBroadcast(roomId: string) {
    void broadcast(roomId).catch(error => {
      console.error('Room broadcast failed:', error instanceof Error ? error.message : 'unknown');
      io.to(roomId).emit('server_error', 'The table update could not be delivered. Reconnecting will restore the saved state.');
    });
  }
  io.on('connection', socket => {
    void socket.join(`user:${socket.data.user.id}`);
    let subscriptions = 0;
    socket.on('subscribe', async (roomId, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      try {
        if (++subscriptions > 120 || typeof roomId !== 'string' || roomId.length > 80) throw new GameError('Too many subscription requests.');
        const user = await store.identity(socket.data.token);
        if (!user) throw new GameError('Session expired.', 401);
        const room = await store.getRoom(roomId);
        store.requireMember(room, user.id);
        const old = socket.data.roomId;
        if (old) await socket.leave(old);
        socket.data.roomId = room.id;
        await socket.join(room.id);
        if (old && old !== room.id) safelyBroadcast(old);
        await broadcast(room.id);
        respond({ ok: true });
      } catch (error) { respond({ ok: false, error: error instanceof GameError ? error.message : 'Unable to subscribe to this table.' }); }
    });
    socket.on('disconnect', () => { if (socket.data.roomId) safelyBroadcast(socket.data.roomId); });
  });

  app.get('/health/live', (_req, res) => { res.json({ status: 'alive' }); });
  app.get('/health/ready', async (_req, res) => {
    await store.db.query('SELECT 1');
    res.json({ status: 'ready' });
  });
  app.get('/api/me', (req: AuthRequest, res) => { res.json({ user: req.identity ?? null, hostKeyRequired: Boolean(config.hostKey) }); });
  const authLimit = rateLimit({ windowMs: 60000, limit: config.production ? 15 : 200, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait a minute.' } });
  app.post('/api/auth/guest', authLimit, async (req: AuthRequest, res) => {
    if (req.identity) { res.json({ user: req.identity }); return; }
    const { name } = z.object({ name: displayName }).parse(req.body);
    const result = await store.createIdentity(name);
    setSession(res, result.token);
    res.json({ user: result.user, recoveryCode: result.recoveryCode });
  });
  app.post('/api/auth/recover', authLimit, async (req, res) => {
    const { recoveryCode } = z.object({ recoveryCode: z.string().min(16).max(128) }).parse(req.body);
    const result = await store.recover(recoveryCode);
    io.in(`user:${result.user.id}`).disconnectSockets(true);
    setSession(res, result.token);
    res.json({ user: result.user });
  });
  app.post('/api/auth/logout', requireUser, csrf, async (req: AuthRequest, res) => {
    await store.logout(req.sessionToken!);
    io.in(`user:${req.identity!.id}`).disconnectSockets(true);
    res.clearCookie(cookieName, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/rooms', requireUser, async (req: AuthRequest, res) => { res.json({ rooms: await store.rooms(req.identity!.id) }); });
  app.post('/api/rooms', requireUser, csrf, async (req: AuthRequest, res) => {
    const input = createSchema.parse(req.body);
    if (config.hostKey && !constantEqual(input.hostKey ?? '', config.hostKey)) throw new GameError('The host-creation key is incorrect.', 403);
    const room = await store.create(req.identity!, input);
    res.status(201).json({ room: roomView(room, req.identity!.id, new Set()) });
  });
  app.post('/api/rooms/join', requireUser, csrf, async (req: AuthRequest, res) => {
    const input = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{8}$/), commandId: z.string().uuid() }).parse(req.body);
    const result = await store.execute(input.code, req.identity!.id, input.commandId, { type: 'join', name: req.identity!.name }, undefined);
    safelyBroadcast(result.room.id);
    res.json({ room: roomView(result.room, req.identity!.id, new Set()) });
  });
  app.get('/api/rooms/:id', requireUser, async (req: AuthRequest, res) => {
    const room = await store.getRoom(String(req.params.id));
    store.requireMember(room, req.identity!.id);
    const sockets = await io.in(room.id).fetchSockets();
    res.json({ room: roomView(room, req.identity!.id, new Set(sockets.map(socket => socket.data.user.id))) });
  });
  app.post('/api/rooms/:id/commands', requireUser, csrf, async (req: AuthRequest, res) => {
    const input = commandEnvelope.parse(req.body);
    const result = await store.execute(String(req.params.id), req.identity!.id, input.commandId, input.command, input.expectedVersion);
    safelyBroadcast(result.room.id);
    const sockets = await io.in(result.room.id).fetchSockets();
    res.json({ room: roomView(result.room, req.identity!.id, new Set(sockets.map(socket => socket.data.user.id))), duplicate: result.duplicate });
  });
  const authorizeRoom = async (req: AuthRequest) => {
    const room = await store.getRoom(String(req.params.id));
    store.requireMember(room, req.identity!.id);
    return room;
  };
  const cursor = (req: Request) => req.query.before === undefined ? undefined : z.coerce.number().int().positive().parse(req.query.before);
  app.get('/api/rooms/:id/ledger', requireUser, async (req: AuthRequest, res) => { const room = await authorizeRoom(req); res.json(await store.ledger(room.id, cursor(req))); });
  app.get('/api/rooms/:id/audit', requireUser, async (req: AuthRequest, res) => { const room = await authorizeRoom(req); res.json(await store.audit(room.id, cursor(req))); });
  app.get('/api/rooms/:id/hands', requireUser, async (req: AuthRequest, res) => { const room = await authorizeRoom(req); res.json(await store.hands(room.id, cursor(req))); });
  app.get('/api/rooms/:id/integrity', requireUser, async (req: AuthRequest, res) => { const room = await authorizeRoom(req); res.json(await store.verifyAudit(room.id)); });
  app.get('/api/rooms/:id/export.csv', requireUser, async (req: AuthRequest, res) => {
    const snapshot = await store.exportSnapshot(String(req.params.id), req.identity!.id);
    const room = snapshot.room;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="river-room-${room.code}-ledger.csv"`);
    res.write('\uFEFFid,utc,transaction,type,player,from,to,chips,cash_amount,currency,note\r\n');
    let before: number | undefined = snapshot.ledgerBefore;
    do {
      const page = await store.ledger(room.id, before, 500);
      for (const entry of page.entries) {
        res.write([entry.id, entry.at, entry.transactionId, entry.kind, room.players.find(player => player.id === entry.playerId)?.name ?? entry.playerId,
          entry.from, entry.to, entry.chips, (entry.cashCents / 100).toFixed(2), room.settings.currency, entry.note].map(csvCell).join(',') + '\r\n');
      }
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
    res.end();
  });
  app.get('/api/rooms/:id/export.json', requireUser, async (req: AuthRequest, res) => {
    const snapshot = await store.exportSnapshot(String(req.params.id), req.identity!.id);
    const room = snapshot.room;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="river-room-${room.code}-audit.json"`);
    res.write(JSON.stringify({ room: roomView(room, req.identity!.id, new Set()), exportedAt: new Date().toISOString() }).slice(0, -1) + ',"audit":[');
    let before: number | undefined = snapshot.auditBefore; let first = true;
    do {
      const page = await store.audit(room.id, before, 500);
      for (const entry of page.entries) { res.write((first ? '' : ',') + JSON.stringify(entry)); first = false; }
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
    res.end(']}');
  });
  app.use('/api', (_req, _res, next) => next(new GameError('API route not found.', 404)));
  const staticDirectory = config.staticDirectory ?? fileURLToPath(new URL('../client/', import.meta.url));
  if (existsSync(staticDirectory)) {
    app.use(express.static(staticDirectory, { index: false, maxAge: 3600000 }));
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: staticDirectory });
    });
  }
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(issue => issue.message).join(' ') }); return; }
    if (error instanceof GameError) { res.status(error.status).json({ error: error.message }); return; }
    const requestId = randomUUID();
    console.error(JSON.stringify({ event: 'request_error', requestId, message: error instanceof Error ? error.message : 'Unknown error' }));
    res.status(500).json({ error: `Unable to confirm this request. Refresh the table and check the ledger before retrying. Reference: ${requestId}` });
  });

  let ticking: Promise<void> | null = null;
  let closing = false;
  let closed: Promise<void> | null = null;
  const runTick = async () => {
    try {
      for (const room of await store.openRooms()) {
        if (closing) break;
        if (room.paused) continue;
        const now = Date.now();
        const hand = room.hand;
        if (hand?.runoutVote) {
          if (hand.runoutVote.deadline !== null && hand.runoutVote.deadline <= now)
            if (await store.timeout(room.id, room.version)) await broadcast(room.id);
        } else if (hand?.actorId && hand.street !== 'complete') {
          const actor = room.players.find(player => player.id === hand.actorId)!;
          if (hand.deadline && hand.deadline <= now) {
            if (await store.timeout(room.id, room.version)) await broadcast(room.id);
          } else if (actor.bot && now - hand.turnStartedAt >= 1400) {
            const command = chooseBotAction(roomView(room, actor.id, new Set()));
            try {
              await store.execute(room.id, actor.id, `bot-${hand.id}-${room.version}`, command, room.version, true);
              await broadcast(room.id);
            } catch (error) { if (!(error instanceof GameError && error.status === 409)) throw error; }
          }
        } else if (room.nextHandAt && room.nextHandAt <= now && room.players.filter(player => player.seat !== null && player.stack > 0 && !player.sittingOut).length >= 2) {
          try {
            await store.execute(room.id, room.hostId, `auto-deal-${room.version}`, { type: 'deal' }, room.version, true);
            await broadcast(room.id);
          } catch (error) { if (!(error instanceof GameError && error.status === 409)) throw error; }
        }
      }
    } catch (error) {
      console.error('Game scheduler failed:', error instanceof Error ? error.message : 'unknown');
      io.emit('server_error', 'Automatic play is temporarily unavailable. The saved table has not been discarded.');
    } finally { ticking = null; }
  };
  const timer = config.scheduler ? setInterval(() => {
    if (!ticking && !closing) ticking = Promise.resolve().then(runTick);
  }, 600) : null;
  timer?.unref();
  return {
    app, http, io, broadcast,
    close: () => {
      if (closed) return closed;
      closing = true;
      if (timer) clearInterval(timer);
      closed = Promise.all([
        ticking,
        new Promise<void>(resolve => io.close(() => resolve())),
      ]).then(() => {});
      return closed;
    },
  };
}
