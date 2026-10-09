# River Room repository instructions

## Interaction style

- Be friendly, upbeat, and collaborative with the user.
- In casual conversation, naturally use friendly nicknames such as "big dog," "chief," "friend," "homie," or similar variations. Rotate them and do not force one into every response.

## Build and verification

Run commands from the repository root with Node.js 24.

```powershell
npm ci --ignore-scripts
npm run check
npm run build
```

- `npm run check` runs the strict TypeScript check; there is no separate lint script.
- `npm run build` runs the type check, compiles the Node server to `dist\server`, and builds the Vite client into `dist\client`.
- `pwsh -File .\Start-Local.ps1 -CheckOnly` is the Windows bootstrap/build check. Without `-CheckOnly`, it starts the production build on loopback with persistent PGlite data in `.data\postgres`.

Vitest runs serially against `tests\**\*.test.ts`:

```powershell
npm test
npm test -- tests\engine.test.ts
npm test -- tests\engine.test.ts -t "session accounting and controls"
npm run test:watch -- tests\engine.test.ts
```

Build the client before running Playwright. The browser suite starts an isolated in-memory server and uses one Chromium worker:

```powershell
npm exec playwright install chromium
npm run build
npm run test:e2e
npm run test:e2e -- tests\browser\poker.spec.ts
npm run test:e2e -- tests\browser\poker.spec.ts --grep "two independent players"
```

Additional end-to-end checks:

```powershell
npm run test:bots -- --players 6 --hands 24 --native-hands 3
pwsh -File .\Test-Local.ps1 -Players 6 -Hands 24 -NativeHands 3
pwsh -File .\Deploy-Azure.ps1 -ValidateOnly
```

`Test-Local.ps1` is the complete local verification path: build, Vitest, Playwright, then authenticated live bot sessions. `npm run test:azure -- --url <https-url>` verifies an explicit deployment and requires `RIVER_ROOM_HOST_KEY` in the process environment.

## Architecture

- `src\shared\model.ts` is the cross-boundary contract: persisted room/hand state, commands, redacted client views, legal actions, ledger/history records, defaults, and shared formatting/rule helpers. `src\shared\emoji.ts` is the shared emoji allowlist.
- `src\server\engine.ts` is the authoritative poker state machine. `transition` clones and normalizes the prior room, applies one typed command, emits domain events and balanced transfers, increments the version, and validates all invariants. Card dealing/evaluation is isolated in `cards.ts`; bot decisions consume only a redacted `RoomView`.
- `src\server\store.ts` is the transactional boundary. It row-locks the room, enforces command-key idempotency and optimistic versions, invokes the engine, verifies transfer reconciliation, then atomically stores the room snapshot, append-only ledger, hash-linked audit row, and completed-hand history.
- `src\server\database.ts` exposes one `Database` interface over persistent/in-memory PGlite for local use and `pg` for production PostgreSQL. Both execute the same PostgreSQL schema. Local persistent stores have exclusive ownership locks and must never be shared by concurrent processes.
- `src\server\app.ts` owns Express, cookie/CSRF/origin protection, Socket.IO presence and private broadcasts, exports, bots, turn/runout deadlines, and auto-deal scheduling. `roomView` in the engine is the privacy boundary used for every HTTP and socket snapshot.
- Seat emotes use the separate transient Socket.IO `emote` event and the fixed phrases in `src\shared\emotes.ts`, not persisted poker commands. Keep their cooldown server-side and their mute preferences browser-local; do not add them to room versions, the journal, or accounting records.
- `src\server\index.ts` validates environment configuration, opens storage, pauses interrupted active play, starts the app, and coordinates bounded graceful shutdown. Production requires PostgreSQL with verified TLS, HTTPS `APP_ORIGIN`, and a host-creation key.
- The React client treats complete `RoomView` snapshots as server authority. `App.tsx` owns identity/lobby flows; `Game.tsx` owns socket subscription, periodic refresh, command submission, and table controls; `Table.tsx` renders seats/cards from the already-redacted view. The client never calculates a replacement game state.
- Azure deployment is split between durable infrastructure in `infra\main.bicep` and the Container App revision in `infra\app.bicep`. Production intentionally stays at one replica because presence, broadcasts, bots, and timers are process-local.

## Repository-specific conventions

- Preserve the command pipeline when adding behavior: update the `Command` union/shared types, Zod schemas in `validation.ts`, the `transition` switch and invariants, redacted projections, client controls, and the relevant engine/service/browser tests.
- Mutate game state only inside engine transitions. Do not update persisted room JSON directly or perform poker/accounting logic in routes, sockets, React components, or SQL.
- Every mutation must remain retry-safe: clients send a UUID `commandId` and the room's `expectedVersion`; transport retries reuse the same payload/key. A reused key with different input is an error, and stale versions return a conflict rather than being merged.
- Keep accounting explicit and integer-only. Chips and cents are safe integers; every movement is a positive `ChipTransfer`; `verifyTransfers` and `assertRoom` must continue to prove account reconciliation, pot commitments, chip conservation, and independently zero-sum bounty balances.
- Bounties are separate `bounty:<playerId>` obligations, not stack or pot movements. Do not mix them into buy-ins, cash-outs, table-chip conservation, or automatic payment behavior.
- Treat privacy as a serialization invariant. Full rooms may contain decks, burns, and all hole cards; `RoomView` must omit those fields and expose cards only according to Hold'em/Omaha showdown rules or Indian poker's reversed visibility. Broadcast separately generated views per user.
- Active hands snapshot `hand.rules`; changes to `nextHandRules` or table settings affect future hands only. Preserve frozen active-hand behavior and pending-blind semantics.
- Persisted snapshots and hand histories are compatibility-sensitive. Increment `ROOM_SCHEMA_VERSION` and extend `normalizeRoom`/`normalizeHistory` when stored shapes change; migrate projections without rewriting append-only audit history. Existing legacy Indian hands must finish under their saved rules.
- Server/shared source compiled with `NodeNext` uses explicit `.js` suffixes in relative imports. Client and test source uses extensionless imports under bundler/Vitest resolution.
- Tests should exercise the same invariants as production. Engine tests commonly inject deterministic decks through `Context.deck`, then call `assertRoom` and `verifyTransfers`; service tests use real in-memory PGlite and actual HTTP/Socket.IO; persistence tests use owned temporary directories, never `.data\postgres`.
- Browser tests prefer accessible roles/labels and independent browser contexts for separate players. They may use API helpers to arrange state, but assertions should verify the real rendered controls and server snapshots.
- Do not scale the deployed app beyond one replica without first adding a shared Socket.IO adapter and single-owner/shared scheduling for timers and bots.
