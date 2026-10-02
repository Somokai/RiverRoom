# River Room

A private, real-time mixed poker room with a complete per-session chip ledger.
Built with React, TypeScript, an authoritative Node.js server, and PostgreSQL.

## Start locally on Windows

Open PowerShell 7 and clone the repository:

```powershell
git clone https://github.com/Somokai/RiverRoom.git
Set-Location .\RiverRoom
.\Start-Local.ps1
```

If you already have a checkout, open PowerShell in that folder and run
`.\Start-Local.ps1`. All commands below assume the repository root.

Open `http://localhost:8080`. Keep the terminal open while playing.
The script builds the application and, if necessary, downloads a portable
Node.js 24 LTS release from the official Node distribution and verifies its
SHA-256 checksum. It does not modify your permanent PATH.

For subsequent launches, `-SkipBuild` skips compilation. `-Port 8081` selects a
different local port. `-CheckOnly` builds without starting a listener.

No Docker or external database is needed locally. PGlite runs real PostgreSQL
inside the process and persists data under `.data\postgres`. Keep that folder:
it contains identities, recovery hashes, private hand state, ledgers, and history.
Do not share it or include it in a source archive. Stop the server before making
a local filesystem backup; copy the **entire** `.data` directory.

Only one process can own a local database directory. A second launch is refused
rather than sharing an unsafe embedded store, including paths that resolve to
the same directory. The server safely recovers a verifiably stale lock after a
crash, but does not guess when ownership is uncertain or overwrite a damaged
nonempty database. The Windows launcher owns the child server's lifetime, so
closing its terminal does not intentionally leave an orphaned game server.
An interrupted active table is restored paused on the next startup.

For a manual Node.js installation:

```powershell
npm ci --ignore-scripts
npm run build
npm start
```

Copy `.env.example` to `.env` for optional configuration. The startup script
binds only to your local computer. For other devices, deploy to Azure rather than
exposing an unencrypted local guest-session endpoint to the internet.

## Local bot testing

The local test command builds the app, runs the
unit/integration and browser suites, then plays real authenticated bot clients
against an isolated local server:

```powershell
pwsh -File .\Test-Local.ps1 `
    -Players 6 -Hands 24 -NativeHands 3
```

The player clients use the same cookie authentication, CSRF checks, HTTP
commands, and private WebSocket views as browser players. Test hands rotate
through check-downs, 3x-BB/half-pot bets, all-ins, three-quarter-pot bets,
folds, and the normal practice-bot strategy. The run also exercises a
replayed command, disconnect/reconnect, cash-out/rejoin/rebuy, host-approved
funding, and the native server bots with the host sitting out.

After every hand, the runner independently reconciles ledger transfers against
each player's stack, funding/cash-outs, rebuy/add-on counters, pot escrow, and
the bank. It checks private-card delivery, completed-hand retention, final
cash-outs, the audit hash chain, and the audit export. A failed check produces
a nonzero exit code rather than reporting success.

This is **test data only**. The runner starts its own loopback server on a free
port, uses an owned temporary database, closes its sessions, stops its server,
and removes that temporary data. It does not open your normal `.data` database,
accept a remote target URL, or provision Azure resources. Card shuffling remains
cryptographic; repeated runs exercise the same scenarios, not the same deck.

The non-secret result report is:

```text
.\.artifacts\local-bot-run.json
```

`-Players` accepts 2-9 and `-Hands` accepts 1-200. `-NativeHands` controls the
additional hands played by the actual server-side practice bots. `-SkipBrowser`
explicitly skips only Playwright, for headless-only checks. If Playwright reports
a missing Chromium installation, install its browser using the command shown
in the error before rerunning the full checks.

With Node 24 already on PATH and a current build, run just the live bot sessions:

```powershell
npm run test:bots -- --players 9 --hands 12 --native-hands 2
```

The direct runner additionally supports `--action-delay-ms` (minimum 100),
`--timeout-seconds`, `--games`, `--max-runouts`, `--bounty`, and `--output` for a JSON report. Its report describes the
bot sessions, not a skipped or failed browser suite.

To exercise all game types with up-to-three-run consent:

```powershell
pwsh -File .\Test-Local.ps1 `
    -Games 'holdem,omaha,omaha_bomb,indian' -MaxRunouts 3 `
    -SevenDeuceBounty 200 -Hands 24 -NativeHands 4
```

The live runner rotates game types while varying its betting scenarios. It
checks Indian face-out visibility, votes through all-in decisions, and reconciles
the separate bounty accounts as well as the in-play stacks.

## The poker night

1. Choose a player name, create a table, and **save your private recovery key**.
   There are no email accounts or password resets. The server stores only a
   SHA-256 hash of the recovery key. A valid cookie keeps you signed in for
   30 days; recovering a profile revokes its other browser sessions.
2. Share the eight-character invite code/link. Invitees create their own
   profiles, join, and request a buy-in. The host approves or declines each
   request. The host's own funding is approved automatically.
3. Deal when at least two funded, active seats are ready. The same room is one
   accounting session. Your profile can participate in several separate rooms.
   The default minimum buy-in is **500 chips**. Existing tables keep their
   configured limits until the host changes the minimum in House rules.
4. Use **1/2 pot, 3/4 pot, full pot**, **2x/2.5x/3x/4x BB**, an exact amount,
   the slider, or all-in. Amounts mean **total raise-to for this street**.
   For example, at 50/100, 3x BB raises **to 300**, not by another 300.
5. Request additional chips at any time. Approved requests enter play only
   between hands. A rebuy is a new buy-in when the stack is zero; an add-on
   increases a nonzero stack. Funding cannot exceed the configured stack cap.
   Winnings are not capped. An all-in rebuy is declined if its player wins
   chips back before the request can be applied.
6. Cash out between hands to release your seat. Rejoining with the same profile
   preserves your session totals. Closing a session completes its active hand,
   cashes out every remaining stack, and preserves read-only records.

### Choose the next hand

The host's **Next hand** controls select the game and house rules for upcoming
deals. The selection stays in effect until changed. A hand snapshots its rules
when dealt: changing the next selection never changes cards, betting limits,
bounties, or runout permissions in an active hand.

| Game | Cards and betting |
|---|---|
| Texas Hold'em | Two private cards; ordinary no-limit betting and blinds |
| Pot-limit Omaha | Four private cards; exactly two hole cards plus three from the board; mandatory round ante, normal blinds and pot-limit betting |
| Double-board PLO bomb pot | Four private cards; configured ante instead of blinds; two flops immediately, with no preflop betting |
| Indian poker (two cards) | Two face-out hole cards; opponents see both but their owner cannot until folding or the hand ends; mandatory round ante, normal blinds and no-limit Hold'em betting |

Indian poker follows the normal Hold'em sequence: preflop, a three-card flop,
turn, and river, with betting on every street. The best five-card hand wins
using any combination of the two hole cards and five board cards (including
playing the board). Your own cards stay hidden while you are live, including
all-in consent; folding reveals both to you immediately, also after reconnect.
Opponents' cards remain visible. Indian hands support one, two, or three
consensual all-in runouts under the same rules as Hold'em.

Configure **Indian round buy-in (ante per player)** or **PLO round buy-in (ante
per player)** in **Next hand**. Both are mandatory, positive whole-chip amounts,
initially one big blind. Every dealt-in player posts the amount automatically
from their existing stack before the normal blinds. This is a per-hand ante,
not an extra cash buy-in or funding request: it replaces the regular table ante,
does not count toward a call, and is recorded separately in the chip ledger.
PLO's pot-limit calculation includes the posted antes. Short stacks post only
their remaining chips and are all-in, with normal side-pot eligibility.
Sitting-out players do not pay. The table minimum buy-in remains 500 by default.

Already-dealt hands keep their original betting and accounting on upgrade.
In particular, a saved one-card Indian hand finishes under its old rules and
is labeled as legacy in the table and history; the next Indian deal uses two
cards. Historical records are projected without rewriting their audit trail.

Bomb pots use one burn card per street followed by cards to both boards. Each
board is evaluated separately under Omaha's exact two-plus-three rule. The
configured big blind still supplies the minimum betting unit. The bomb ante
is independently configurable in chips, initially five big blinds. It is not
charged in addition to the regular PLO ante.

Pot-limit caps are enforced by the server, including raises and the All-in
button. An all-in exceeding the pot cap is not permitted. Preflop pot counts
assume full nominal blinds even if a blind was short; later streets use the
actual pot. Pot presets and the slider use the same legal cap.

### Run it once, twice, or three times

Select a maximum of one, two, or three runouts in the next-hand rules. One is
the default. With multiple runs enabled, a choice opens only after all betting
has finished due to all-ins, with multiple live hands and community cards still
to come. A player merely going all-in does not stop others' side-pot betting.

Each remaining player chooses the greatest number they are willing to play.
The lowest selection governs; missing choices at the 20-second deadline mean
one. A choice of one can resolve the decision immediately. Practice bots accept
the available maximum. Pausing the table freezes the decision, and restarting
preserves its choices in a paused hand.

Only enough runouts to fit the remaining deck are offered. No cards are recycled
or reshuffled. For example, a full nine-player Omaha deal cannot run three full
preflop boards, and a nine-player double-board bomb pot cannot repeat both
remaining boards after its flops. Already-dealt community prefixes are shared;
each run gets distinct remaining cards and burns.

Each side pot is split by board, then by runout, then among tied winners.
Whole-chip remainders go to the earlier board, earlier run, then the tied seat
clockwise left of the button. History and exports retain every board and the
indexed awards, rather than only the first run.

### Seven-deuce offsuit bounty

Set a positive bounty in chips to enable this Hold'em-only house rule; zero
disables it. A player holding exactly seven-deuce of different suits must be the
sole recipient of all positive pot awards for the hand. Ties, partial wins, and
other games do not qualify. Every other dealt-in participant owes the configured
amount, including folded or busted players; spectators and mid-hand arrivals do
not. The winning cards are shown to verify the claim, even after an uncontested
win.

These are **separate settlement obligations**, not bets or automatic payments.
The winner's bounty balance increases and the other participants' balances
decrease. In-play stacks, buy-ins, cash-outs, and the pot are unchanged; an all-in
loser can therefore still owe the full bounty without a negative chip stack.
The ledger records each payer-to-winner obligation and its currency equivalent.
Chip P/L and bounty P/L are shown separately, and total session P/L includes both.
Bounty obligations remain recorded after cash-out or session closure; settle
them outside the app. Bot-related amounts remain virtual.

### Included

- Two to nine seats, live presence, reconnect, invite links, table chat.
- Server-only cryptographic shuffle and hand evaluation.
- Dealer button, small/big blinds, optional per-player antes, heads-up order.
- Legal action enforcement, minimum raises, short all-ins and cumulative
  reopening, all-in runouts, uncalled refunds, main/side pots and split pots.
- Odd chips awarded clockwise from the left of the button.
- Moving button among eligible seats; no dead-button or missed-blind debt system.
- Turn clocks: check when legal, otherwise fold. Two consecutive timeouts mark
  the player to sit out subsequent hands. Sitting out during a hand takes
  effect next hand; it does not waive the current decision.
- Optional automatic next hands, pause/resume, host transfer, next-hand blind
  changes, funding approvals, rebuys, add-ons, and session closure.
- Practice bots that receive only the same redacted view as a human player.
  Bots use a lightweight heuristic, not a solver. Their balances are virtual
  and are labeled as such. Practice creation adds up to three bots, limited by
  the selected table size. Between hands, the host can use a bot's
  **Refill virtual chips** control, enter **Virtual chips to add**, and
  **Confirm virtual refill**. Zero-stack funding is a rebuy; otherwise it is
  an add-on. Normal funding limits, rebuy policy, ledger, and counters apply.
  To observe without playing, choose **Sit out** before dealing with at least
  two funded bots. **Sit back in** rejoins future hands.
- Per-player stack, chips committed, total funding/cash-outs, rebuy/add-on counts,
  and settled profit/loss. During a hand, settled P/L includes that player's
  committed chips so it does not prematurely count a pending wager as a loss.
- Full transfer ledger, hand history, full action journal, CSV and JSON downloads.
- Responsive desktop/mobile table, reduced-motion support, native accessible
  dialogs, optional turn sounds, and no externally hosted images or fonts.

There is **no rake, payment collection, money transfer, public matchmaking,
real-money gaming certification, tournament elimination, or blind-level timer**.
Recorded currency is bookkeeping only. This is an application for private
home-game use, not a licensed online casino or a payment service.

## Ledger and privacy

All mutations execute in a database transaction, locking the room row. The
version prevents stale decisions; a unique command key makes retries idempotent.
Snapshots, transfers, hand results, and audit events commit together.

Every movement is a balanced transfer:

| Event | Debit | Credit |
|---|---|---|
| Buy-in / rebuy / add-on | House bank | Player stack |
| Blind / ante / bet | Player stack | Hand pot |
| Refund / payout | Hand pot | Player stack |
| Cash-out | Player stack | House bank |
| 7-2 bounty obligation | Payer's separate bounty account | Winner's separate bounty account |

The server checks chip conservation and reconciles the transition's transfers
against its before/after balances. Integer chips and integer cents avoid
floating-point accounting. Cash amounts are recorded only on funding and
cash-out entries and bounty equivalents; bets and payouts are chip transfers,
not payments. Bounty entries never mint, burn, or move chips in play.
Each session supports up to one billion chips in lifetime funding; additional
funding is explicitly rejected before it could exceed the safe payout bounds.

Database triggers reject updates/deletes to the ledger, audit, and completed
hand history. Each audit record hashes the previous hash plus its canonical
payload. The UI can verify this chain. This detects inconsistent stored history;
it is **not** an externally witnessed, administrator-proof audit trail. A
privileged database administrator could rewrite both data and hashes.

Players in the session can see each other's stacks, session accounting, public
actions, and deliberately revealed cards. Hold'em/Omaha views contain the
viewer's own cards and public showdown/bounty reveals, not other hidden hands.
Indian poker deliberately reverses visibility during play: opponents' cards
are visible and the viewer's own two cards are withheld until they fold or the
hand finishes. Folding reveals them immediately in that player's HTTP,
WebSocket, and exported views, including after reconnect. Decks and burns are never
sent over the client API or sockets.
Full private snapshots remain in the database, which administrators must protect.

CSV escapes spreadsheet-formula prefixes. Audit JSON includes all audit
transactions, their transfer entries, and a redacted session snapshot.
Export cursors are captured with the snapshot so new bets cannot change the
contents of an export already in progress.
The live table journal keeps its latest 80 events for display; the complete
database journal and exports are not truncated. Financial records are not
automatically deleted when a player logs out or cashes out.

## Deploy to Azure

The provided deployment **creates billable resources**. No resources are
created merely by opening this project or running local tests.

The script checks PostgreSQL region/SKU availability before creating a new
stack. Subscription restrictions can differ by region; an empty allowed-version
list is not solved by guessing another PostgreSQL version. If a previous stack
already exists in a different region, use a new resource group rather than
attempting to relocate those resources.
Advertised capability is not reserved capacity. The app environment is now
provisioned before the database, so a regional Container Apps capacity failure
does not also create an unusable database.

Only an allowlisted container source directory is uploaded: source code, public
assets, package manifests, and build configuration. Local databases, credentials,
backups, reports, and dependencies are not sent to the registry builder. Build
completion is polled without streaming logs, so Unicode build output cannot
abort Windows deployment. An unsuccessful build still stops deployment.
The Dockerfile is resolved inside that source directory, so the deployment
script can be called from any working directory.

An already verified image may be reused with `-SourceRegistryResourceId` and
`-SourceImageDigest 'river-room@sha256:...'`. Both are required together. The
script imports that immutable digest into its regional registry and verifies it
before starting the application, instead of rebuilding a moving source tree.

Prerequisites:

- PowerShell 7.2+, Azure CLI, and `az login`.
- A subscription and region allowing Container Apps, ACR builds, and PostgreSQL
  Flexible Server. Default PostgreSQL SKU: `Standard_B1ms`.
- Resource provisioning and role-assignment permissions, for example Owner,
  or Contributor plus an appropriate role-assignment administrator role.
- The deployment account needs directory access to resolve its own object ID,
  or supply `-DeployerObjectId` explicitly. Service principals must supply their
  **object ID**, not application/client ID, and `-DeployerPrincipalType ServicePrincipal`.

Compile the Bicep templates without provisioning:

```powershell
.\Deploy-Azure.ps1 -ValidateOnly
```

Deploy only when ready to authorize the charges:

```powershell
az login
.\Deploy-Azure.ps1 `
    -SubscriptionId '<your-subscription-id>' `
    -ResourceGroup 'river-room-northcentral-rg' `
    -AppName 'river-room' `
    -Location 'northcentralus' `
    -AcceptAzureCharges
```

The script creates:

| Component | Configuration |
|---|---|
| Container App | HTTPS, 0.5 vCPU / 1 GiB, one always-on replica, one active revision |
| Managed environment | Consumption workload profile, dedicated VNet subnet |
| PostgreSQL Flexible Server | PostgreSQL 16, 32 GiB initial storage, private subnet/DNS, TLS required |
| Database backups | Seven-day retention, local redundancy, no high availability |
| Container Registry | Basic SKU; remote Linux build, admin credentials disabled |
| Key Vault | RBAC, soft delete, purge protection; secret references, not secrets in source |
| Managed identity | Image pull and access to only the app's two required Key Vault secrets |
| Log Analytics | 30-day retention, 1 GiB daily ingestion cap |

ACR builds the image remotely, so local Docker is unnecessary. Production refuses
to start without an HTTPS origin, PostgreSQL with certificate-verified TLS, and
a sufficiently long host-creation key. PostgreSQL has no public network access.
Set TLS using `DATABASE_SSL=true`; omit `sslmode` and other SSL query parameters
from `DATABASE_URL`. Conflicting connection-string TLS configuration is rejected.
Key Vault and ACR retain public service endpoints protected by identity/RBAC.

The script generates secrets with a cryptographic RNG, passes them as secure
Bicep parameters in an access-restricted temporary folder, deletes that folder,
and reuses the existing secrets on subsequent deployments. It never writes
passwords or the host key to the deployment receipt. Existing sessions survive
redeployments. Only the app image/revision changes unless infrastructure inputs
are changed.

The deployment prints the HTTPS URL, verifies `/health/ready`, and writes a
non-secret `deployment.json` receipt in the project folder. It also prints the
Azure CLI command to retrieve the **host-creation key** from Key Vault. Only
people with that key can create new Azure-hosted tables; invited players do not
need it. Player recovery keys are separate.

### Verify the Azure deployment

With Node 24 on PATH, run the bounded HTTPS/WebSocket check against the explicit
deployed URL. Pass the host key through the process environment, never a command
argument or a source file:

```powershell
$deployment = Get-Content .\deployment.json -Raw | ConvertFrom-Json
$env:RIVER_ROOM_HOST_KEY = az keyvault secret show `
    --subscription $deployment.subscriptionId `
    --vault-name $deployment.keyVaultName --name host-key --query value --output tsv
try {
    npm run test:azure -- --url $deployment.url
} finally {
    Remove-Item Env:RIVER_ROOM_HOST_KEY
}
```

This explicitly creates two synthetic profiles and one private verification
table. It checks Secure/HttpOnly cookies, actual WSS delivery and reconnect,
hidden cards, 500-chip funding, pot-limit bets, two-run consent, idempotency,
history, the audit chain, exports, and final cash-outs. Successful sessions are
closed; failure attempts only a safe pause of its own table. No real payments
are made and normal local game data is never loaded or copied.

The report is `.\.artifacts\azure-verification.json`.
It does not contain host/recovery keys, session cookies, CSRF tokens, invite
codes, or private cards. The optional programmatic `afterFunding` hook can be
used for an explicitly coordinated server restart; a health-only run or a run
without that hook does not claim restart persistence was tested.

Keep `minReplicas = maxReplicas = 1`. Room transactions are protected by the
database, but presence, broadcasts, and timers deliberately use one application
process. Scaling out needs a shared socket adapter and scheduler ownership.
On restart, active or automatically progressing tables pause; hosts resume
them after reconnecting. This deployment favors a small private game over
continuous-availability infrastructure.

Custom domains require updating `APP_ORIGIN` to the exact HTTPS origin as well
as configuring the certificate/domain in Container Apps. Never disable origin,
CSRF, or certificate checks to work around a configuration mismatch.

Review your Azure budget and resource pricing before deploying. The database,
registry, logging, and always-on application can incur charges even when nobody
is playing. To stop charges, remove the dedicated resource group **only after
exporting needed records and confirming you no longer need the database**.
Purge-protected Key Vault names may remain reserved during their retention window.
Visual Studio subscription credits are for development/testing, not production
hosting. Their spending cap or offer restrictions can suspend resources; this
script does not upgrade billing or disable the cap. Use an appropriate
subscription before relying on an always-on production service. Offer terms:
`https://azure.microsoft.com/en-us/pricing/member-offers/credit-for-visual-studio-subscribers/`.

### Updates and troubleshooting

Rerun the same deployment command, with the same resource group/app name, to
build a uniquely tagged image and update the existing service.

```powershell
az containerapp logs show --resource-group river-room-northcentral-rg --name river-room --follow
```

- A new managed identity's permissions can take time to propagate. The script
  retries app provisioning a limited number of times, then fails explicitly.
- A region may lack capacity/quota for the selected SKU. Choose a supported
  region/SKU; do not replace a live database just to bypass an error.
- Reusing an existing deployment requires access to its stored secrets. A
  permission failure stops deployment rather than generating replacement secrets.
- Export important sessions regularly and monitor Azure database backups.
  Test restores before relying on this deployment for valuable records.
- Local compilation alone does not prove subscription permissions, quota, regional
  availability, or a successful live Azure deployment.

## Development and verification

```powershell
npm run check
npm test
npm run build
npm exec playwright install chromium
npm run test:e2e
```

The unit/integration suite covers hand ranking, action order, short all-ins,
side pots, ties/odd chips, refunds, funding, ownership, cookie recovery,
request deduplication, concurrent updates, append-only records, audit
verification, private socket delivery, and actual local-database reopen.
Randomized multiway hands check conservation and legal bot actions throughout.
Browser tests exercise independent player contexts and a mobile viewport
against the production-built client.

Source layout:

- `src\server\engine.ts` - authoritative rules, transitions, and invariants.
- `src\server\cards.ts` - secure shuffle and five-to-seven-card evaluator.
- `src\server\store.ts` - transactional persistence, auth, ledger, and audit.
- `src\server\app.ts` - HTTP API, sockets, presence, bots, and turn scheduler.
- `src\client` - React interface, table, account controls, and records.
- `src\testing\run-bots.ts` - isolated real-client and native-bot session checks.
- `Test-Local.ps1` - Windows build, regression, browser, and live-bot entry point.
- `infra` - infrastructure and application Bicep templates.

The lockfile pins dependency versions and integrity hashes without a private
registry URL. Docker builds explicitly use the public npm registry. Local npm
uses your normal configured registry, including a corporate proxy if required.

Rule references used for the implementations:

- Omaha: `https://www.pokerstars.com/poker/games/omaha/`
- Double-board bomb pots: `https://www.pokerstars.com/poker/learn/news/what-is-a-bomb-pot-in-poker/`
- Pot-limit sizing/reopening: `https://www.pokertda.com/view-poker-tda-rules/`
- Legacy one-card Indian poker (saved-hand compatibility only): `https://www.pagat.com/poker/variants/indian.html`

The two-card Indian Hold'em variant, mandatory Indian/PLO round antes,
selectable bounty settlement, runout-consent policy, and split-rounding order
above are explicit house rules for this application.
