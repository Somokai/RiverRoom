import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, defaultHandRules, type Command, type GameVariant, type HandHistory, type HandView, type Identity, type LedgerRow, type RoomView } from '../../src/shared/model';

function handView(base: RoomView, game: GameVariant = 'holdem'): RoomView {
  const room = structuredClone(base);
  const rules = { ...defaultHandRules(room.settings), game, omahaAnte: 25 };
  const anteOnly = game === 'omaha_bomb';
  const cardCount = game.startsWith('omaha') ? 4 : 2;
  const ante = game === 'indian' ? rules.indianAnte : game === 'omaha_bomb' ? rules.bombAnte : game === 'omaha' ? rules.omahaAnte : 0;
  const host = { ...room.players[0]!, seat: 0, cards: [] };
  room.players = [host, { ...host, id: 'fixture-riley', name: 'Riley', seat: 1 }];
  const participants = room.players.map((player, index) => ({
    id: player.id, seat: index, committed: ante + (anteOnly ? 0 : index ? 100 : 50),
    streetBet: anteOnly ? 0 : index ? 100 : 50, folded: false, actedAtBet: null, lastAction: anteOnly ? 'Ante' : index ? 'Big blind' : 'Small blind',
  }));
  const boards = game === 'omaha_bomb' ? [['2h', '3c', '4s'], ['5d', '6h', '7c']] : [[]];
  const pot = participants.reduce((sum, player) => sum + player.committed, 0);
  const hand: HandView = {
    id: 'fixture-hand-1', number: 1, rules, boards, board: boards[0] ?? [],
    runoutBoards: [], runoutPrefix: null, runoutCount: 1, runoutVote: null, preflopPotAdjustment: 0, bounty: null,
    street: game === 'omaha_bomb' ? 'flop' : 'preflop', players: participants, buttonSeat: 0,
    smallBlindSeat: anteOnly ? null : 0, bigBlindSeat: anteOnly ? null : 1,
    currentBet: anteOnly ? 0 : 100, minRaise: 100, actorId: room.youId, pot, awardedPot: 0,
    turnStartedAt: Date.now(), deadline: Date.now() + 120000, startedAt: Date.now(), completedAt: null,
    showdown: false, results: [], revealed: {}, balanceAfter: {}, bountyAfter: {},
  };
  room.players = room.players.map((player, index) => ({
    ...player, stack: 10000 - participants[index]!.committed, buyIns: 10000, cashOuts: 0,
    bountyNet: 0, chipNet: 0, net: 0, sittingOut: false, connected: true, hand: participants[index]!,
    cards: index === 0 ? game === 'indian' ? [null, null] : ['As', 'Ks', 'Qd', 'Jd'].slice(0, cardCount)
      : game === 'indian' ? ['Kh', 'Qh'] : Array.from({ length: cardCount }, () => null),
  }));
  const potLimit = game === 'omaha' || game === 'omaha_bomb';
  const cap = potLimit ? anteOnly ? pot : pot + 150 : 10000 - ante;
  room.legal = {
    canAct: true, canCheck: anteOnly, canRaise: true, toCall: anteOnly ? 0 : 50,
    callAmount: anteOnly ? 0 : 50, minRaiseTo: anteOnly ? 100 : 200, maxRaiseTo: cap,
    allInTo: 10000 - ante, canAllIn: !potLimit, bettingLimit: potLimit ? 'pot_limit' : 'no_limit',
    potLimitTo: potLimit ? cap : null, potAfterCall: pot + (anteOnly ? 0 : 50), reason: '',
  };
  room.hand = hand;
  room.handNumber = 1;
  room.nextHandRules = { ...rules };
  room.nextHandAt = null;
  room.paused = false;
  room.version = 100000;
  return room;
}

// The real isolated test session supplies authentication/socket connectivity; snapshots isolate UI contracts from random deals.
async function openFixture(page: Page, origin: string, seed: (base: RoomView) => RoomView = base => handView(base)) {
  const signedIn = await page.request.post('/api/auth/guest', { headers: { Origin: origin }, data: { name: 'Mixed host' } });
  expect(signedIn.ok()).toBe(true);
  const { user } = await signedIn.json() as { user: Identity };
  const created = await page.request.post('/api/rooms', {
    headers: { Origin: origin, 'X-CSRF-Token': user.csrf },
    data: { name: 'Mixed-game UI fixture', settings: { ...DEFAULT_SETTINGS, autoDeal: false, turnSeconds: 120 }, buyIn: 10000, commandId: crypto.randomUUID() },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { room: base } = await created.json() as { room: RoomView };
  const state = {
    room: seed(base), commands: [] as Command[], ledger: [] as LedgerRow[], hands: [] as HandHistory[],
    rejectNextHand: false, errors: [] as string[],
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route(`**/api/rooms/${base.id}`, async route => {
    state.room.serverTime = Date.now();
    await route.fulfill({ json: { room: state.room } });
  });
  await page.route('**/api/rooms', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const room = state.room;
    const hero = room.players.find(player => player.id === room.youId)!;
    await route.fulfill({ json: { rooms: [{
      id: room.id, code: room.code, name: room.name, status: room.status, playerCount: room.players.length,
      handNumber: room.handNumber, stack: hero.stack, net: hero.net, chipNet: hero.chipNet, bountyNet: hero.bountyNet,
      buyIns: hero.buyIns, host: true, createdAt: room.createdAt,
    }] } });
  });
  await page.route(`**/api/rooms/${base.id}/ledger*`, route => route.fulfill({ json: { entries: state.ledger, nextCursor: null } }));
  await page.route(`**/api/rooms/${base.id}/hands*`, route => route.fulfill({ json: { entries: state.hands, nextCursor: null } }));
  await page.route(`**/api/rooms/${base.id}/commands`, async route => {
    const { command } = route.request().postDataJSON() as { command: Command };
    state.commands.push(command);
    if (command.type === 'next_hand' && state.rejectNextHand) {
      return route.fulfill({ status: 409, json: { error: 'The queued rules changed. Refresh and try again.' } });
    }
    if (command.type === 'next_hand') state.room.nextHandRules = { ...command.rules };
    if (command.type === 'act' && command.action === 'fold') {
      const hero = state.room.players.find(player => player.id === state.room.youId)!;
      hero.hand!.folded = true;
      if (state.room.hand!.rules.game === 'indian') hero.cards = ['As', 'Ks'];
      state.room.hand!.actorId = state.room.players[1]!.id;
      state.room.legal.canAct = state.room.legal.canRaise = false;
    }
    if (command.type === 'settings') {
      const { type: _, ...settings } = command;
      state.room.settings = { ...state.room.settings, ...settings };
    }
    if (command.type === 'runouts' && state.room.hand?.runoutVote) state.room.hand.runoutVote.votes[state.room.youId] = command.count;
    if (command.type === 'pause') {
      state.room.paused = command.value;
      if (state.room.hand?.runoutVote) state.room.hand.runoutVote.deadline = command.value ? null : Date.now() + 20000;
    }
    state.room.version++;
    state.room.serverTime = Date.now();
    await route.fulfill({ json: { room: state.room, duplicate: false } });
  });
  await page.goto(`/?table=${base.id}`);
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  await expect(page.getByRole('heading', { name: 'Mixed-game UI fixture' })).toBeVisible();
  return state;
}

for (const game of ['holdem', 'omaha_bomb'] as const) {
  for (const seats of [2, 3, 4, 5, 6, 7, 8, 9]) {
    test(`player displays are 20% larger without overlaps: ${game}, ${seats} seats`, async ({ page, baseURL }, testInfo) => {
      const state = await openFixture(page, baseURL!, base => {
        const room = handView(base, game);
        room.settings.maxSeats = seats;
        const hero = room.players[0]!;
        const opponent = room.players[1]!;
        room.players = Array.from({ length: seats }, (_, seat) => {
          const player = structuredClone(seat === 0 ? hero : opponent);
          player.id = seat === 0 ? hero.id : `fixture-seat-${seat}`;
          player.name = seat === 0 ? 'Player with a long name' : `Player ${seat + 1}`;
          player.emoji = '\u{1F47B}';
          player.seat = seat;
          player.hand = { ...player.hand!, id: player.id, seat };
          return player;
        });
        room.hand!.players = room.players.map(player => player.hand!);
        room.hand!.street = 'flop';
        if (game === 'holdem') room.hand!.boards = [['2h', '3c', '4s']];
        room.hand!.board = room.hand!.boards[0]!;
        return room;
      });
      const table = page.getByRole('region', { name: 'Poker table' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const failures: string[] = [];
      for (const width of [1600, 1440, 1200, 1024, 980, 768, 600, 390, 320]) {
        await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
        const sizes = await table.locator('.seat-panel, .seat-name, .player-emoji, .seat-stack, .seat-avatar, .position-badge')
          .evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const transform = new DOMMatrix(getComputedStyle(element.closest('.seat')!).transform);
            return { width: rect.width, height: rect.height, originalWidth: parseFloat(style.width), originalHeight: parseFloat(style.height), scaleX: transform.a, scaleY: transform.d };
          }));
        for (const size of sizes) {
          expect(size.scaleX).toBe(1.2);
          expect(size.scaleY).toBe(1.2);
          expect(size.width).toBeCloseTo(size.originalWidth * 1.2, 1);
          expect(size.height).toBeCloseTo(size.originalHeight * 1.2, 1);
        }
        const layout = await page.evaluate(() => {
          const rectangle = (element: Element) => {
            const { left, top, right, bottom } = element.getBoundingClientRect();
            return { left, top, right, bottom };
          };
          return {
            viewport: innerWidth, scroll: document.documentElement.scrollWidth,
            panels: [...document.querySelectorAll('.seat-panel')].map(rectangle),
            cards: [...document.querySelectorAll('.seat')].map(seat => [...seat.querySelectorAll('.seat-cards .playing-card')].map(rectangle)),
            bets: [...document.querySelectorAll('.seat-bet')].map(rectangle),
            boards: [...document.querySelectorAll('.community .board-cards')].map(rectangle),
            metadata: rectangle(document.querySelector('.table-meta')!),
            actions: rectangle(document.querySelector('.action-console')!),
          };
        });
        const overlaps = (a: typeof layout.metadata, b: typeof layout.metadata) =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        if (layout.scroll > layout.viewport + 1) failures.push(`Horizontal overflow at ${width}px`);
        for (const [index, panel] of layout.panels.entries()) {
          if (panel.left < 0 || panel.right > width + 1) failures.push(`Seat ${index} outside viewport at ${width}px`);
          if (panel.bottom >= layout.actions.top) failures.push(`Seat ${index} touches controls at ${width}px`);
          for (const [otherIndex, other] of layout.panels.slice(index + 1).entries())
            if (overlaps(panel, other)) failures.push(`Seats ${index}/${index + otherIndex + 1} overlap at ${width}px`);
          for (const board of layout.boards)
            if (overlaps(panel, board)) failures.push(`Seat ${index} overlaps board at ${width}px`);
          for (const [otherIndex, cards] of layout.cards.entries()) {
            if (otherIndex !== index && cards.some(card => overlaps(panel, card)))
              failures.push(`Seat ${index} overlaps seat ${otherIndex}'s cards at ${width}px`);
          }
        }
        const cards = layout.cards.flat();
        if (cards.some(card => card.top <= layout.metadata.bottom)) failures.push(`Hole cards overlap metadata at ${width}px`);
        if (cards.some(card => layout.boards.some(board => overlaps(card, board)))) failures.push(`Hole cards overlap board at ${width}px`);
        if (layout.bets.some(bet => bet.bottom >= layout.actions.top)) failures.push(`Bets overlap controls at ${width}px`);
        if (width === 1440 || width === 390)
          await table.screenshot({ path: testInfo.outputPath(`player-displays-${width}.png`), animations: 'disabled' });
      }
      expect(failures).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }
}

test('localized turn, auto-deal and runout clocks keep ticking across dialogs and pause changes', async ({ page, baseURL }) => {
  await page.clock.install();
  const state = await openFixture(page, baseURL!);
  const clock = page.locator('.hero-seat .seat-action');
  await expect(clock).toHaveText(/\d+s to act/);
  const initial = parseInt((await clock.textContent())!);
  await page.getByRole('button', { name: 'Choose table emoji', exact: true }).click();
  await page.clock.runFor(1250);
  expect(parseInt((await clock.textContent())!)).toBeLessThan(initial);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pause table', exact: true }).click();
  await expect(clock).toHaveText('Turn paused');
  await page.clock.runFor(1000);
  await expect(clock).toHaveText('Turn paused');
  await page.getByRole('button', { name: 'Resume table', exact: true }).click();
  await expect(clock).toHaveText(/\d+s to act/);
  const resumed = parseInt((await clock.textContent())!);
  await page.clock.runFor(1250);
  expect(parseInt((await clock.textContent())!)).toBeLessThan(resumed);

  const refresh = async () => {
    state.room.version++;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };
  state.room.hand!.street = 'complete';
  state.room.hand!.actorId = null;
  state.room.hand!.deadline = null;
  state.room.nextHandAt = Date.now() + 6000;
  await refresh();
  await expect(page.locator('.action-heading')).toContainText(/Next hand in \d+s/);
  const nextHand = await page.locator('.action-heading').textContent();
  await page.clock.runFor(1250);
  await expect(page.locator('.action-heading')).not.toHaveText(nextHand!);

  state.room.nextHandAt = null;
  state.room.hand!.street = 'preflop';
  state.room.hand!.rules.maxRunouts = 2;
  state.room.hand!.runoutVote = {
    eligible: state.room.players.map(player => player.id), votes: {},
    maxRuns: 2, deadline: Date.now() + 6000,
  };
  await refresh();
  await expect(page.getByRole('timer')).toHaveText(/\d+s to choose/);
  const runout = await page.getByRole('timer').textContent();
  await page.clock.runFor(1250);
  await expect(page.getByRole('timer')).not.toHaveText(runout!);
  await page.getByRole('button', { name: 'Pause table', exact: true }).click();
  await expect(page.getByRole('timer')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Resume table', exact: true }).click();
  await expect(page.getByRole('timer')).toHaveText(/\d+s to choose/);
  state.room.hand!.runoutVote!.deadline = Date.now() + 1500;
  await refresh();
  await page.clock.runFor(2500);
  await expect(page.getByRole('timer')).toHaveText('Resolving choices…');
  await expect(page.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test('new-table minimum is 500 from the shared default', async ({ page }) => {
  expect(DEFAULT_SETTINGS.minBuyIn).toBe(500);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByRole('button', { name: 'Show house rules' }).click();
  await expect(page.getByLabel('Minimum buy-in', { exact: true })).toHaveValue('500');
});

test('future-game selection stays queued and cannot change active cards or rules', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!);
  const activeRules = structuredClone(state.room.hand!.rules);
  await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
  await expect(page.getByLabel('Game for future hands')).toBeFocused();
  await page.getByLabel('Game for future hands').selectOption('omaha_bomb');
  await page.getByLabel('Bomb ante (chips per player)').fill('75');
  await page.getByLabel('All-in runout consent').selectOption('3');
  await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
  await expect(page.locator('.queued-hand-rules')).toContainText('Double-board PLO bomb pot');
  await expect(page.locator('.queued-hand-rules')).toContainText('75 ante');
  await expect(page.locator('.active-hand-rules')).toContainText("Texas Hold'em");
  await expect(page.locator('.hero-seat .playing-card')).toHaveCount(2);
  expect(state.room.hand!.rules).toEqual(activeRules);
  expect(state.commands.at(-1)).toMatchObject({ type: 'next_hand', rules: { game: 'omaha_bomb', bombAnte: 75, maxRunouts: 3, sevenDeuceBounty: 0 } });
  await page.reload();
  await expect(page.locator('.queued-hand-rules')).toContainText('Double-board PLO bomb pot');
  await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
  await page.getByLabel('Game for future hands').selectOption('indian');
  await page.getByLabel('Indian round buy-in (ante per player)').fill('0');
  await expect(page.getByRole('button', { name: 'Save next-hand rules', exact: true })).toBeDisabled();
  await page.getByLabel('Indian round buy-in (ante per player)').fill('25');
  await expect(page.getByLabel('All-in runout consent')).toBeEnabled();
  await expect(page.getByLabel('All-in runout consent')).toHaveValue('3');
  await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
  await expect(page.locator('.queued-hand-rules')).toContainText('Indian poker (two cards)');
  expect(state.commands.at(-1)).toMatchObject({ type: 'next_hand', rules: { game: 'indian', indianAnte: 25, maxRunouts: 3 } });
  await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
  await page.getByLabel('Game for future hands').selectOption('omaha');
  await page.getByLabel('PLO round buy-in (ante per player)').fill('0');
  await expect(page.getByRole('button', { name: 'Save next-hand rules', exact: true })).toBeDisabled();
  await page.getByLabel('PLO round buy-in (ante per player)').fill('35');
  await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
  expect(state.commands.at(-1)).toMatchObject({ type: 'next_hand', rules: { game: 'omaha', omahaAnte: 35, indianAnte: 25 } });
  await expect(page.locator('.queued-hand-rules')).toContainText('35 round ante');
  expect(state.room.hand!.rules).toEqual(activeRules);
  await expect(page.locator('.runout-decision')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('existing minimum changes only when explicitly saved, without changing funding', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base);
    room.settings.minBuyIn = 4000;
    return room;
  });
  const playersBefore = structuredClone(state.room.players);
  await page.getByRole('button', { name: 'House rules', exact: true }).click();
  await expect(page.getByLabel('Minimum buy-in', { exact: true })).toHaveValue('4000');
  await expect(page.getByLabel('Minimum buy-in', { exact: true })).toHaveAccessibleDescription(/Existing stacks, funding and cash-outs do not change/);
  await page.getByLabel('Minimum buy-in', { exact: true }).fill('0');
  await expect(page.getByRole('button', { name: 'Save house rules' })).toBeDisabled();
  await page.getByLabel('Minimum buy-in', { exact: true }).fill(String(state.room.settings.maxBuyIn + 1));
  await expect(page.getByRole('button', { name: 'Save house rules' })).toBeDisabled();
  await page.getByLabel('Minimum buy-in', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Save house rules' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.commands.at(-1)).toMatchObject({ type: 'settings', minBuyIn: 500 });
  expect(state.room.players).toEqual(playersBefore);
  expect(state.room.settings.minBuyIn).toBe(500);
  expect(state.errors).toEqual([]);
});

test('PLO caps every preset and validates numbers without disguising a pot bet as all-in', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => handView(base, 'omaha'));
  await expect(page.locator('.hero-seat .card-face')).toHaveCount(4);
  await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(4);
  await expect(page.locator('.variant-guidance')).toContainText('Exactly 2 + 3');
  await expect(page.getByRole('button', { name: 'All in', exact: true })).toBeDisabled();
  await expect(page.locator('#betting-limits')).toContainText('nominal full blinds');
  for (const [preset, expected] of [['Half pot', '225'], ['Three-quarter pot', '287'], ['Full pot', '350'], ['4 times big blind', '350']]) {
    await page.getByRole('button', { name: preset!, exact: true }).click();
    await expect(page.getByLabel('Raise-to amount', { exact: true })).toHaveValue(expected!);
  }
  for (const invalid of ['351', '201.5', '', '-1']) {
    await page.getByLabel('Raise-to amount', { exact: true }).fill(invalid);
    await expect(page.locator('.button-raise')).toBeDisabled();
    await expect(page.getByLabel('Raise-to amount', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  }
  await page.getByLabel('Raise-to amount', { exact: true }).fill('350');
  await page.getByRole('button', { name: 'Raise to 350', exact: true }).click();
  expect(state.commands.at(-1)).toEqual({ type: 'act', action: 'raise', amount: 350 });

  state.room.players[0]!.stack = 200;
  Object.assign(state.room.legal, { maxRaiseTo: 250, allInTo: 250, canAllIn: true });
  await page.reload();
  await page.getByRole('button', { name: 'All in', exact: true }).click();
  expect(state.commands.at(-1)).toEqual({ type: 'act', action: 'raise', amount: 250 });

  state.room.players[0]!.stack = 40;
  Object.assign(state.room.legal, { canRaise: false, maxRaiseTo: 90, allInTo: 90, canAllIn: true, callAmount: 40 });
  await page.reload();
  await page.getByRole('button', { name: 'All in', exact: true }).click();
  expect(state.commands.at(-1)).toEqual({ type: 'act', action: 'call' });
  expect(state.errors).toEqual([]);
});

test('runout consent appears only for a server decision and retains submitted votes through pause', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base, 'omaha');
    room.hand!.rules.maxRunouts = 3;
    room.players[1]!.stack = 0;
    return room;
  });
  await expect(page.locator('.runout-decision')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fold', exact: true })).toBeEnabled();
  state.room.hand!.runoutVote = { eligible: state.room.players.map(player => player.id), votes: {}, maxRuns: 2, deadline: Date.now() + 20000 };
  state.room.players[1]!.cards = ['Ah', 'Kh', 'Qh', 'Jh'];
  state.room.hand!.actorId = null;
  state.room.legal.canAct = false;
  state.room.legal.canRaise = false;
  await page.reload();
  await expect(page.locator('.runout-decision')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Eligible players' })).toContainText('Riley');
  await expect(page.getByRole('timer')).toHaveText(/\d+s to choose/);
  await expect(page.locator('.runout-deck-note')).toContainText("reduced from the host's maximum of 3");
  await expect(page.getByRole('button', { name: 'Up to three times', exact: true })).toHaveCount(0);
  await expect(page.locator('.action-buttons')).toHaveCount(0);
  await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(4);
  await expect(page.locator('.runout-decision')).toContainText('A missing choice after 20 seconds defaults to run once');
  await page.getByRole('button', { name: 'Up to twice', exact: true }).click();
  await expect(page.locator('.runout-own-status')).toContainText('Your choice is submitted: up to twice');
  expect(state.commands.at(-1)).toEqual({ type: 'runouts', handId: 'fixture-hand-1', count: 2 });
  await page.getByRole('button', { name: 'Pause table', exact: true }).click();
  await expect(page.getByRole('timer')).toHaveText('Paused');
  expect(state.room.hand!.runoutVote!.votes[state.room.youId]).toBe(2);
  await expect(page.getByRole('button', { name: 'Up to twice', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume table', exact: true }).click();
  await expect(page.locator('.runout-own-status')).toContainText('Your choice is submitted: up to twice');
  await expect(page.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
  await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(4);

  state.room.hand!.runoutVote!.votes = {};
  state.room.hand!.runoutVote!.deadline = Date.now() - 1000;
  await page.reload();
  await expect(page.locator('.runout-own-status')).toContainText('apply the once fallback');
  await expect(page.getByRole('button', { name: 'Run once', exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test('Indian poker hides both live owner cards, shows the board and blinds, and reveals a fold across reconnect', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base, 'indian');
    room.players[0]!.cards = ['As', 'Ks'];
    return room;
  });
  await expect(page.locator('.street-label')).toHaveText('PREFLOP');
  await expect(page.getByRole('group', { name: 'Your Indian poker cards, intentionally hidden from you' })).toBeVisible();
  await expect(page.locator('.hero-seat .card-back')).toHaveCount(2);
  await expect(page.locator('.hero-seat .card-face')).toHaveCount(0);
  await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
  await expect(page.locator('.board-cards')).toHaveCount(1);
  await expect(page.locator('.blind-badge')).toHaveCount(2);
  await expect(page.locator('.runout-decision')).toHaveCount(0);
  await expect(page.locator('.variant-guidance')).toContainText('not a connection problem');
  await page.reload();
  await expect(page.locator('.hero-seat .card-back')).toHaveCount(2);
  await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
  await page.getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
  await expect(page.locator('.hero-seat .card-back')).toHaveCount(0);
  await expect(page.locator('.variant-guidance')).toContainText('your own cards are now revealed');
  await expect(page.locator('.street-label')).toHaveText('PREFLOP');
  await page.reload();
  await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(state.errors).toEqual([]);
});

test('Indian all-in consent leaves opponent cards face up and the owner cards hidden', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base, 'indian');
    room.hand!.rules.maxRunouts = 3;
    room.hand!.runoutVote = { eligible: room.players.map(player => player.id), votes: {}, maxRuns: 3, deadline: Date.now() + 20000 };
    room.hand!.actorId = null;
    room.hand!.deadline = null;
    room.legal.canAct = room.legal.canRaise = false;
    return room;
  });
  await expect(page.locator('.runout-decision')).toBeVisible();
  await expect(page.locator('.hero-seat .card-back')).toHaveCount(2);
  await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
  await page.getByRole('button', { name: 'Up to twice', exact: true }).click();
  expect(state.commands.at(-1)).toEqual({ type: 'runouts', handId: 'fixture-hand-1', count: 2 });
  await page.reload();
  await expect(page.locator('.runout-own-status')).toContainText('Your choice is submitted: up to twice');
  await expect(page.locator('.hero-seat .card-back')).toHaveCount(2);
  await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
  expect(state.errors).toEqual([]);
});

test('real three-player Indian hand posts configured antes, reveals a fold immediately, and completes a Holdem board', async ({ page, browser, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  const requests = [page.request, ...contexts.map(context => context.request)];
  const users: Identity[] = [];
  try {
    for (const [index, request] of requests.entries()) {
      const signedIn = await request.post('/api/auth/guest', {
        headers: { Origin: baseURL! }, data: { name: `Indian player ${index + 1}` },
      });
      expect(signedIn.ok()).toBe(true);
      users.push((await signedIn.json() as { user: Identity }).user);
    }
    const created = await page.request.post('/api/rooms', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': users[0]!.csrf },
      data: {
        name: 'Real Indian Holdem', buyIn: 500, commandId: crypto.randomUUID(),
        settings: { ...DEFAULT_SETTINGS, maxSeats: 3, autoDeal: false, turnSeconds: 120, ante: 9 },
      },
    });
    expect(created.ok()).toBe(true);
    let room = (await created.json() as { room: RoomView }).room;
    const read = async (index = 0) => {
      const response = await requests[index]!.get(`/api/rooms/${room.id}`);
      expect(response.ok()).toBe(true);
      return (await response.json() as { room: RoomView }).room;
    };
    const send = async (index: number, command: Command) => {
      const response = await requests[index]!.post(`/api/rooms/${room.id}/commands`, {
        headers: { Origin: baseURL!, 'X-CSRF-Token': users[index]!.csrf },
        data: { expectedVersion: room.version, commandId: crypto.randomUUID(), command },
      });
      expect(response.ok(), await response.text()).toBe(true);
      room = (await response.json() as { room: RoomView }).room;
    };
    for (const index of [1, 2]) {
      const joined = await requests[index]!.post('/api/rooms/join', {
        headers: { Origin: baseURL!, 'X-CSRF-Token': users[index]!.csrf },
        data: { code: room.code, commandId: crypto.randomUUID() },
      });
      expect(joined.ok()).toBe(true);
      room = (await joined.json() as { room: RoomView }).room;
      await send(index, { type: 'fund', amount: 500 });
      await send(0, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    }
    await page.goto(`/?table=${room.id}`);
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    await page.getByLabel('Game for future hands').selectOption('indian');
    await page.getByLabel('Indian round buy-in (ante per player)').fill('25');
    await page.getByLabel('All-in runout consent').selectOption('3');
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText('25 round ante');
    await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
    await expect(page.locator('.hero-seat .card-back')).toHaveCount(2);
    await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(4);
    await expect(page.locator('.blind-badge')).toHaveCount(2);
    room = await read();
    expect(room.hand).toMatchObject({ street: 'preflop', actorId: users[0]!.id, pot: 225, currentBet: 100 });
    expect(room.players.map(player => player.buyIns)).toEqual([500, 500, 500]);
    const ownCards = (await read(1)).players[0]!.cards;
    expect(ownCards.every(card => typeof card === 'string')).toBe(true);
    await page.getByRole('button', { name: 'Fold', exact: true }).click();
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
    room = await read();
    expect(room.hand!.street).not.toBe('complete');
    expect(room.players[0]!.cards).toEqual(ownCards);
    expect(room.hand!.revealed).toEqual({});
    await page.reload();
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
    await expect(page.locator('.variant-guidance')).toContainText('your own cards are now revealed');
    const streets = new Set<string>([room.hand!.street]);
    for (let actions = 0; room.hand!.street !== 'complete'; actions++) {
      expect(actions).toBeLessThan(20);
      const index = users.findIndex(user => user.id === room.hand!.actorId);
      expect(index).toBeGreaterThan(0);
      const view = await read(index);
      expect(view.players[index]!.cards).toEqual([null, null]);
      await send(index, { type: 'act', action: view.legal.canCheck ? 'check' : 'call' });
      streets.add(room.hand!.street);
    }
    expect([...streets]).toEqual(['preflop', 'flop', 'turn', 'river', 'complete']);
    expect(room.hand!.board).toHaveLength(5);
    expect(room.hand!.awardedPot).toBe(275);
    expect(room.players.reduce((sum, player) => sum + player.stack, 0)).toBe(1500);
    await expect(page.locator('.community .card-face')).toHaveCount(5);
    await page.getByRole('button', { name: /^Hand history/ }).click();
    await expect(page.locator('.hand-history .history-boards .card-face')).toHaveCount(5);
    await expect(page.locator('.history-rules').first()).toContainText('25 round ante');
    const ledger = await page.request.get(`/api/rooms/${room.id}/ledger`);
    expect(ledger.ok()).toBe(true);
    expect((await ledger.json() as { entries: LedgerRow[] }).entries.filter(entry => entry.kind === 'ante').map(entry => entry.chips))
      .toEqual([25, 25, 25]);
    await send(0, { type: 'close' });
    expect(room.players.reduce((sum, player) => sum + player.cashOuts, 0)).toBe(1500);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('double-board run tabs keep public prefixes and history identifies actual pot, board and run indexes', async ({ page, baseURL }, testInfo) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base, 'omaha_bomb');
    const hand = room.hand!;
    room.players[1]!.seat = 2;
    room.players[1]!.hand!.seat = 2;
    for (const seat of [4, 6, 7]) {
      const player = structuredClone(room.players[1]!);
      player.id = `fixture-seat-${seat}`;
      player.name = `Player ${seat + 1}`;
      player.seat = seat;
      player.hand = { ...player.hand!, id: player.id, seat };
      room.players.push(player);
    }
    hand.players = room.players.map(player => player.hand!);
    hand.street = 'complete';
    hand.showdown = true;
    hand.completedAt = Date.now();
    hand.actorId = null;
    hand.deadline = null;
    hand.runoutCount = 3;
    hand.rules.maxRunouts = 3;
    hand.runoutPrefix = structuredClone(hand.boards);
    hand.runoutBoards = [
      [['2h', '3c', '4s', '8h', '9s'], ['5d', '6h', '7c', 'Td', 'Js']],
      [['2h', '3c', '4s', '8d', '9c'], ['5d', '6h', '7c', 'Th', 'Jc']],
      [['2h', '3c', '4s', '8s', '9h'], ['5d', '6h', '7c', 'Ts', 'Jh']],
    ];
    hand.boards = structuredClone(hand.runoutBoards[0]!);
    hand.board = [...hand.boards[0]!];
    hand.awardedPot = 2500;
    hand.results = hand.runoutBoards.flatMap((boards, runoutIndex) => boards.map((_, boardIndex) => ({
      potIndex: 0, boardIndex, runoutIndex, amount: 400, eligible: room.players.map(player => player.id),
      winners: [room.youId], shares: { [room.youId]: 400 }, description: 'Straight',
    })));
    hand.results.push({ potIndex: 2, boardIndex: 1, runoutIndex: 2, amount: 100, eligible: [room.youId], winners: [room.youId], shares: { [room.youId]: 100 }, description: 'Uncontested' });
    room.legal.canAct = false;
    room.legal.canRaise = false;
    return room;
  });
  await expect(page.locator('.community .board-cards')).toHaveCount(2);
  await expect(page.locator('.community .card-face')).toHaveCount(10);
  await expect(page.locator('.hero-seat .playing-card')).toHaveCount(4);
  await expect(page.locator('.blind-badge')).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: 'Board runs' });
  await tabs.getByRole('tab', { name: 'Run 1', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Run 2', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'Run 2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('group', { name: 'Run 2, board 1', exact: true }).getByRole('img', { name: '2 of hearts', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Run 2, board 1', exact: true }).getByRole('img', { name: '8 of diamonds', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Run 3', exact: true })).toBeFocused();
  await expect(page.locator('.community .card-face')).toHaveCount(10);
  const measureLayout = () => page.evaluate(() => ({
    viewport: innerWidth, scroll: document.documentElement.scrollWidth,
    documentOverflowX: getComputedStyle(document.documentElement).overflowX,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    lobbyDisplay: getComputedStyle(document.querySelector('.game-nav .lobby-link')!).display,
    overflow: [...document.querySelectorAll('body *')].map(element => ({ class: element.className, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1))
      .slice(0, 8).map(({ class: name, rect }) => ({ name, left: rect.left, right: rect.right })),
  }));
  const saveMeasurement = async (name: string, value: unknown) => {
    const path = testInfo.outputPath(`${name}.json`);
    await writeFile(path, JSON.stringify(value, null, 2));
    await testInfo.attach(name, { path, contentType: 'application/json' });
  };
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await measureLayout();
    await saveMeasurement(`mixed-layout-${width}`, layout);
    expect(layout.scroll <= layout.viewport + 1, JSON.stringify(layout)).toBe(true);
    expect(['hidden', 'clip']).not.toContain(layout.documentOverflowX);
    expect(['hidden', 'clip']).not.toContain(layout.bodyOverflowX);
    await expect(page.locator('.game-nav .lobby-link')).toBeHidden();
    await expect(tabs.getByRole('tab', { name: 'Run 3', exact: true })).toBeVisible();
    const boards = await page.locator('.community .board-cards').all();
    const seats = await page.locator('.seat-panel').all();
    for (const board of boards) {
      const cards = (await board.boundingBox())!;
      for (const seat of seats) {
        const panel = (await seat.boundingBox())!;
        const overlapX = Math.min(cards.x + cards.width, panel.x + panel.width) - Math.max(cards.x, panel.x);
        const overlapY = Math.min(cards.y + cards.height, panel.y + panel.height) - Math.max(cards.y, panel.y);
        expect(overlapX > 0 && overlapY > 0, `Board must not cover stack/turn details at ${width}px`).toBe(false);
      }
    }
    if (width === 320) {
      const lobby = page.locator('.game-nav .lobby-link');
      // Measure the former cascade result to identify the overflow source, then restore the real UI.
      await lobby.evaluate(element => { element.style.display = 'inline-flex'; });
      try {
        await saveMeasurement('legacy-lobby-layout-320', await measureLayout());
      } finally {
        await lobby.evaluate(element => { element.style.removeProperty('display'); });
      }
      const restored = await measureLayout();
      expect(restored.scroll <= restored.viewport + 1, JSON.stringify(restored)).toBe(true);
    }
  }
  const hand = state.room.hand!;
  state.hands = [{
    id: hand.id, number: hand.number, rules: hand.rules, board: hand.board, boards: hand.boards,
    runoutBoards: hand.runoutBoards, runoutCount: hand.runoutCount, bounty: null, buttonSeat: 0,
    pot: hand.awardedPot, completedAt: hand.completedAt!, showdown: hand.showdown, results: hand.results, revealed: {},
    balanceAfter: Object.fromEntries(state.room.players.map(player => [player.id, player.stack])), bountyAfter: {},
  }];
  await page.getByRole('button', { name: /Hand history/ }).click();
  const history = page.getByRole('dialog');
  await expect(history.locator('.history-result').filter({ hasText: 'Main pot' })).toHaveCount(6);
  await expect(history.locator('.history-result').filter({ hasText: 'Side pot 2' })).toContainText('Run 3 · Board 2');
  await expect(history.getByText('Side pot 6', { exact: true })).toHaveCount(0);
  await history.getByRole('tab', { name: 'Run 3', exact: true }).click();
  await expect(history.locator('.board-cards')).toHaveCount(2);
  expect(state.errors).toEqual([]);
});

test('bounty receivables stay outside stacks and cash-outs and decode both ledger endpoints', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!, base => {
    const room = handView(base);
    const hero = room.players[0]!;
    const peer = room.players[1]!;
    Object.assign(hero, { stack: 9800, chipNet: -200, bountyNet: 50, net: -150, cards: ['7s', '2h'] });
    Object.assign(peer, { stack: 10200, chipNet: 200, bountyNet: -50, net: 150 });
    Object.assign(room.hand!, {
      street: 'complete', actorId: null, deadline: null, completedAt: Date.now(), awardedPot: 150,
      bounty: { winnerId: hero.id, payerIds: [peer.id], amount: 50, totalAmount: 50 },
      revealed: { [hero.id]: ['7s', '2h'] }, balanceAfter: { [hero.id]: 9800, [peer.id]: 10200 },
      bountyAfter: { [hero.id]: 50, [peer.id]: -50 },
      results: [{ potIndex: 0, boardIndex: 0, runoutIndex: 0, amount: 150, eligible: [hero.id], winners: [hero.id], shares: { [hero.id]: 150 }, description: 'Uncontested' }],
    });
    room.hand!.rules.sevenDeuceBounty = 50;
    room.legal.canAct = false;
    room.legal.canRaise = false;
    return room;
  });
  const hero = state.room.players[0]!;
  const peer = state.room.players[1]!;
  state.ledger = [{
    id: 1, at: new Date().toISOString(), transactionId: 'fixture-bounty', kind: 'bounty',
    from: `bounty:${peer.id}`, to: `bounty:${hero.id}`, chips: 50, cashCents: 50,
    playerId: hero.id, handId: state.room.hand!.id, note: '7/2 offsuit obligation',
  }];
  const hand = state.room.hand!;
  state.hands = [{
    id: hand.id, number: 1, rules: hand.rules, board: hand.board, boards: hand.boards, runoutBoards: [], runoutCount: 1,
    bounty: hand.bounty, buttonSeat: 0, pot: 150, completedAt: hand.completedAt!, showdown: hand.showdown, results: hand.results,
    revealed: hand.revealed, balanceAfter: hand.balanceAfter, bountyAfter: hand.bountyAfter,
  }];
  await expect(page.locator('.bankroll-main > div > strong')).toContainText('9,800');
  await expect(page.locator('.bankroll-details')).toContainText('Chip P/L -200');
  await expect(page.locator('.bankroll-details')).toContainText('Bounty receivable 50 eq.');
  await expect(page.locator('.net-badge')).toContainText('-150');
  await expect(page.getByRole('note', { name: 'Seven-deuce bounty' })).toContainText('Mixed host is owed 50 chips equivalent');
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('9,800 chips');
  await expect(page.getByRole('dialog')).toContainText('not included in your cash-out');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /Session ledger/ }).click();
  await expect(page.locator('.transfer-cell')).toContainText('Riley · bounty balance');
  await expect(page.locator('.transfer-cell')).toContainText('Mixed host · bounty balance');
  await expect(page.locator('.transfer-cell')).toContainText('no chips or payment moved');
  await expect(page.locator('.data-table')).toContainText('Equivalent only');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /Hand history/ }).click();
  await page.getByText('After-hand balances: chips & bounty', { exact: true }).click();
  await expect(page.locator('.history-balances')).toContainText('Bounty receivable 50 eq.');
  await expect(page.locator('.history-balances')).toContainText('Bounty owed 50 eq.');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Back to your sessions', exact: true }).click();
  await expect(page.locator('.session-breakdown')).toContainText('Chip P/L -200');
  await expect(page.locator('.session-breakdown')).toContainText('Bounty receivable 50 chips equivalent');
  await expect(page.locator('.session-bottom')).toContainText('-150');
  expect(state.errors).toEqual([]);
});

test('next-hand errors stay explicit and preserve drafts and keyboard focus', async ({ page, baseURL }) => {
  const state = await openFixture(page, baseURL!);
  state.rejectNextHand = true;
  await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
  await page.getByLabel('7/2 offsuit bounty (chips per opponent)').fill('25');
  await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
  await expect(page.locator('#next-hand-editor [role="alert"]')).toContainText('The queued rules changed');
  await expect(page.getByLabel('7/2 offsuit bounty (chips per opponent)')).toHaveValue('25');
  expect(state.room.nextHandRules.sevenDeuceBounty).toBe(0);
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose next hand', exact: true })).toBeFocused();
  expect(state.errors).toEqual([]);
});

test('real two-player PLO uses the 500 minimum, pot caps and unanimous up-to runout consent', async ({ page, browser, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByLabel('Your player name').fill('Real PLO host');
  await page.getByLabel('Table name', { exact: true }).fill('Real Omaha consent');
  await page.getByLabel('Your starting chips', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Show house rules' }).click();
  await expect(page.getByLabel('Minimum buy-in', { exact: true })).toHaveValue('500');
  await page.getByLabel('Seats', { exact: true }).fill('2');
  await page.getByLabel('Turn clock (seconds)').fill('120');
  await page.getByLabel('Automatically deal the next hand').uncheck();
  await page.getByRole('button', { name: 'Create private table', exact: true }).click();
  await page.getByRole('button', { name: 'I have saved my key', exact: true }).click();
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  const roomId = new URL(page.url()).searchParams.get('table')!;
  const readRoom = async (viewer: Page = page): Promise<RoomView> => {
    const response = await viewer.request.get(`/api/rooms/${roomId}`);
    expect(response.ok()).toBe(true);
    return (await response.json() as { room: RoomView }).room;
  };
  const created = await readRoom();
  expect(created.settings.minBuyIn).toBe(500);
  expect(created.players[0]!.stack).toBe(500);
  expect(created.nextHandRules).toMatchObject({ game: 'holdem', maxRunouts: 1, sevenDeuceBounty: 0 });
  const guestContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const guest = await guestContext.newPage();
  guest.on('pageerror', error => errors.push(error.message));
  try {
    await guest.goto(`/?join=${created.code}`);
    await guest.getByRole('button', { name: 'Join with a code', exact: true }).click();
    await guest.getByLabel('Your player name').fill('Real PLO guest');
    await guest.getByRole('button', { name: 'Join the table', exact: true }).click();
    await guest.getByRole('button', { name: 'I have saved my key', exact: true }).click();
    await expect(guest.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await guest.locator('.between-actions').getByRole('button', { name: 'Buy in', exact: true }).click();
    await guest.getByLabel('Chips to add').fill('500');
    await guest.getByRole('button', { name: 'Request host approval', exact: true }).click();
    await page.getByRole('button', { name: 'Approve Real PLO guest', exact: true }).click();
    await expect(guest.locator('.bankroll-main > div > strong')).toContainText('500');

    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    await page.getByLabel('Game for future hands').selectOption('omaha');
    await page.getByLabel('PLO round buy-in (ante per player)').fill('25');
    await page.getByLabel('All-in runout consent').selectOption('3');
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText('Pot-limit Omaha');
    expect((await readRoom()).nextHandRules).toMatchObject({ game: 'omaha', omahaAnte: 25, maxRunouts: 3 });
    await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(4);
    await expect(guest.locator('.hero-seat .card-face')).toHaveCount(4);
    const dealt = await readRoom();
    const guestDealt = await readRoom(guest);
    expect(dealt.hand!.rules).toMatchObject({ game: 'omaha', maxRunouts: 3 });
    expect(dealt.hand!.pot).toBe(200);
    expect(dealt.hand!.boards).toEqual([[]]);
    expect(dealt.legal).toMatchObject({ canAct: true, bettingLimit: 'pot_limit', maxRaiseTo: 350, allInTo: 475, canAllIn: false });
    expect(dealt.players.find(player => player.id === guestDealt.youId)!.cards).toEqual([null, null, null, null]);
    expect(guestDealt.players.find(player => player.id === dealt.youId)!.cards).toEqual([null, null, null, null]);
    await expect(page.getByRole('button', { name: 'All in', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Full pot', exact: true }).click();
    await expect(page.getByLabel('Raise-to amount', { exact: true })).toHaveValue('350');
    await page.getByRole('button', { name: 'Raise to 350', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'All in', exact: true })).toBeEnabled();
    await guest.getByRole('button', { name: 'All in', exact: true }).click();
    await expect(page.locator('.button-call')).toBeEnabled();
    await expect(page.locator('.button-call')).toContainText('125');
    expect((await readRoom()).hand!.runoutVote).toBeNull();
    await expect(page.locator('.runout-decision')).toHaveCount(0);
    await page.locator('.button-call').click();

    await expect(page.locator('.runout-decision')).toBeVisible();
    await expect(guest.locator('.runout-decision')).toBeVisible();
    const decision = await readRoom();
    expect(decision.hand!.runoutVote).toMatchObject({ eligible: expect.arrayContaining([dealt.youId, guestDealt.youId]), maxRuns: 3 });
    expect(decision.hand!.street).not.toBe('complete');
    expect(decision.players.find(player => player.id === guestDealt.youId)!.cards).toEqual([null, null, null, null]);
    await expect(page.locator('.action-buttons')).toHaveCount(0);
    await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(4);
    await page.getByRole('button', { name: 'Up to three times', exact: true }).click();
    await expect(page.locator('.runout-own-status')).toContainText('Your choice is submitted: up to three times');
    await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(4);
    await guest.getByRole('button', { name: 'Up to twice', exact: true }).click();

    await expect(page.locator('.street-label')).toHaveText('HAND COMPLETE');
    await expect(guest.locator('.street-label')).toHaveText('HAND COMPLETE');
    const completed = await readRoom();
    expect(completed.hand!.runoutCount).toBe(2);
    expect(completed.hand!.runoutBoards).toHaveLength(2);
    expect(completed.hand!.runoutBoards.every(run => run.length === 1 && run[0]!.length === 5)).toBe(true);
    expect(completed.hand!.awardedPot).toBe(1000);
    expect(completed.players.reduce((sum, player) => sum + player.stack, 0)).toBe(1000);
    expect(completed.settings.minBuyIn).toBe(500);
    expect(completed.nextHandRules).toMatchObject({ game: 'omaha', maxRunouts: 3 });
    await expect(page.getByRole('tablist', { name: 'Board runs' }).getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Run 2', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Run 2, board 1', exact: true })).toBeVisible();
    const historyResponse = await page.request.get(`/api/rooms/${roomId}/hands`);
    expect(historyResponse.ok()).toBe(true);
    const history = (await historyResponse.json() as { entries: HandHistory[] }).entries.find(hand => hand.id === completed.hand!.id)!;
    expect(history).toMatchObject({ showdown: true, rules: { game: 'omaha' }, runoutCount: 2 });
    expect(history.runoutBoards).toEqual(completed.hand!.runoutBoards);
    expect(errors).toEqual([]);
  } finally {
    await guestContext.close();
  }
});
