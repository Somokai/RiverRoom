import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, defaultHandRules, type Command, type GameVariant, type Identity, type RoomView } from '../../src/shared/model';
import { evaluate } from '../../src/shared/handEvaluation';
import { describeHand } from '../../src/client/handPresentation';

async function post(page: Page, origin: string, path: string, body: object, user?: Identity) {
  const response = await page.request.post(`${origin}/api${path}`, {
    headers: { Origin: origin, ...(user ? { 'X-CSRF-Token': user.csrf } : {}) }, data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function current(page: Page, origin: string, id: string): Promise<RoomView> {
  const response = await page.request.get(`${origin}/api/rooms/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).room;
}
async function setup(page: Page, browser: Browser, origin: string, game: GameVariant = 'holdem', maxRunouts = 1) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const guestContext = await browser.newContext({ baseURL: origin, reducedMotion: 'no-preference' });
  const guest = await guestContext.newPage();
  const hostUser: Identity = (await post(page, origin, '/auth/guest', { name: 'Motion host' })).user;
  const guestUser: Identity = (await post(guest, origin, '/auth/guest', { name: 'Motion guest' })).user;
  const room: RoomView = (await post(page, origin, '/rooms', {
    name: 'Table animations', settings: { ...DEFAULT_SETTINGS, maxSeats: 2, autoDeal: false, turnSeconds: 120 },
    buyIn: 500, commandId: crypto.randomUUID(),
  }, hostUser)).room;
  const command = async (who: Page, action: Command): Promise<RoomView> => {
    const before = await current(who, origin, room.id);
    const result: RoomView = (await post(who, origin, `/rooms/${room.id}/commands`, {
      command: action, commandId: crypto.randomUUID(), expectedVersion: before.version,
    }, who === page ? hostUser : guestUser)).room;
    for (const client of [page, guest]) {
      if (client.url().includes(`?table=${room.id}`))
        await expect(client.locator('.table-stage')).toHaveAttribute('data-room-version', String(result.version));
    }
    return result;
  };
  await post(guest, origin, '/rooms/join', { code: room.code, commandId: crypto.randomUUID() }, guestUser);
  const pending = await command(guest, { type: 'fund', amount: 500 });
  await command(page, { type: 'approve', requestId: pending.requests.at(-1)!.id, approve: true });
  if (maxRunouts !== 1 && maxRunouts !== 2 && maxRunouts !== 3) throw new Error('Invalid run count in test.');
  await command(page, { type: 'next_hand', rules: { ...defaultHandRules(), game, maxRunouts, bombAnte: 20 } });
  await page.goto(`${origin}/?table=${room.id}`);
  await guest.goto(`${origin}/?table=${room.id}`);
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  await expect(guest.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  return { room, guest, guestContext, hostUser, guestUser, command };
}
async function finishMotion(page: Page) {
  await expect(page.locator('.table-stage')).not.toHaveAttribute('data-street', 'waiting');
  await expect(page.locator('.table-motion-layer')).toHaveCount(0, { timeout: 7000 });
  expect(await page.locator('[data-motion-card]').evaluateAll(elements =>
    elements.every(element => getComputedStyle(element).opacity === '1'))).toBe(true);
}
async function expectChipPath(page: Page, kind: 'bet' | 'refund' | 'payout' | 'collect' | 'ante', playerId: string) {
  const path = await page.locator(`.moving-chips[data-motion-kind="${kind}"][data-player-id="${playerId}"]`).evaluate(element => {
    const table = element.closest('.table-stage')!;
    const center = (target: Element) => {
      const bounds = target.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    const player = (element as HTMLElement).dataset.playerId;
    const stack = [...table.querySelectorAll<HTMLElement>('[data-motion-stack]')].find(item => item.dataset.motionStack === player)!;
    const wager = [...table.querySelectorAll<HTMLElement>('[data-motion-wager]')].find(item => item.dataset.motionWager === player)!;
    const pot = table.querySelector('[data-motion-pot]')!;
    const animation = element.getAnimations()[0]!;
    animation.pause();
    const timing = animation.effect!.getTiming();
    const delay = timing.delay ?? 0;
    animation.currentTime = delay;
    const from = center(element);
    animation.currentTime = delay + Number(timing.duration) * .999;
    const to = center(element);
    animation.currentTime = delay + Number(timing.duration) * .4;
    animation.play();
    return { from, to, stack: center(stack), wager: center(wager), pot: center(pot) };
  });
  const from = kind === 'bet' || kind === 'ante' ? path.stack : kind === 'collect' || kind === 'refund' ? path.wager : path.pot;
  const to = kind === 'bet' ? path.wager : kind === 'collect' || kind === 'ante' ? path.pot : path.stack;
  expect(Math.hypot(path.from.x - from.x, path.from.y - from.y)).toBeLessThan(1);
  expect(Math.hypot(path.to.x - to.x, path.to.y - to.y)).toBeLessThan(1);
}

test('live card deals and chip bets, refunds and payouts move without blocking play or exposing cards', async ({ page, browser, baseURL }, testInfo) => {
  const { room, guest, guestContext, hostUser, command } = await setup(page, browser, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  guest.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await expect(page.locator('.moving-card')).toHaveCount(4);
    await expect(guest.locator('.moving-card')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Fold', exact: true })).toBeEnabled();
    await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(0);
    await expect(guest.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(0);
    await expect(page.locator('.table-motion-layer .card-face')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your current hand', exact: true })).toHaveAttribute('aria-description', /Only you can see this/);
    await expect(guest.getByRole('region', { name: 'Your current hand', exact: true })).toBeVisible();
    const movement = await page.locator(`[data-card-target="hole:${hostUser.id}:0"]`).evaluate(element => {
      const animation = element.getAnimations()[0]!;
      animation.pause();
      const timing = animation.effect!.getTiming();
      animation.currentTime = Number(timing.delay) + Number(timing.duration) * .2;
      const start = element.getBoundingClientRect();
      animation.currentTime = Number(timing.delay) + Number(timing.duration) * .8;
      const end = element.getBoundingClientRect();
      animation.play();
      return { distance: Math.hypot(end.x - start.x, end.y - start.y), duration: timing.duration };
    });
    expect(movement.distance).toBeGreaterThan(30);
    expect(movement.duration).toBe(420);
    await page.screenshot({ path: testInfo.outputPath('cards-in-flight.png') });
    await finishMotion(page);
    await finishMotion(guest);

    const raised = await command(page, { type: 'act', action: 'raise', amount: 300 });
    const bet = page.locator('.moving-chips[data-motion-kind="bet"]');
    await expect(bet).toHaveAttribute('data-amount', '250');
    await expect(bet).toHaveAttribute('data-player-id', hostUser.id);
    expect(raised.hand?.pot).toBe(400);
    await expect(page.locator('.pot-display strong')).toHaveText('0');
    await expect(page.locator('.pot-display')).toHaveAttribute('aria-description', 'Total including street wagers: 400 chips');
    await expect(page.locator('.hero-seat .seat-bet')).toHaveAttribute('data-wager-amount', '300');
    await expect(guest.getByRole('button', { name: 'Fold', exact: true })).toBeEnabled();
    await expectChipPath(page, 'bet', hostUser.id);
    const settled = await command(guest, { type: 'act', action: 'fold' });
    await expect(page.locator('.moving-chips[data-motion-kind="bet"]')).toHaveCount(0);
    await expect(page.locator('.moving-chips[data-motion-kind="refund"]')).toHaveAttribute('data-amount', '200');
    await expect(page.locator('.moving-chips[data-motion-kind="payout"]')).toHaveAttribute('data-amount', '200');
    await expect(page.locator('.moving-chips[data-motion-kind="collect"]')).toHaveCount(2);
    const timing = await page.locator('.moving-chips').evaluateAll(elements => elements.map(element => ({
      kind: (element as HTMLElement).dataset.motionKind,
      delay: element.getAnimations()[0]?.effect?.getTiming().delay,
    })));
    expect(timing.find(item => item.kind === 'refund')?.delay).toBe(0);
    expect(timing.find(item => item.kind === 'collect')!.delay).toBeGreaterThanOrEqual(620);
    expect(timing.find(item => item.kind === 'payout')!.delay).toBeGreaterThanOrEqual(1180);
    await expectChipPath(page, 'refund', hostUser.id);
    await expectChipPath(page, 'payout', hostUser.id);
    expect(settled.hand?.street).toBe('complete');
    await expect(page.getByRole('region', { name: 'Your current hand', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Hand results', exact: true })).toContainText('Motion host');
    await expect(page.locator('.winning-description')).toHaveText('Uncontested (no showdown)');
    await expect(page.locator('.winning-cards')).toHaveCount(0);
    await finishMotion(page);
    await expect(page.locator('.seat-bet:not(.wager-empty)')).toHaveCount(0);
    await expect(page.locator('.hero-seat .seat-stack')).toHaveText('600');
    const version = (await current(page, baseURL!, room.id)).version;
    await page.getByRole('button', { name: 'Choose table emoji', exact: true }).click();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    expect((await current(page, baseURL!, room.id)).version).toBe(version);
    await page.reload();
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await guestContext.close(); }
});

test('raises and reraises build seat piles, then the closing call collects them before the flop', async ({ page, browser, baseURL }, testInfo) => {
  const { room, guest, guestContext, hostUser, command } = await setup(page, browser, baseURL!);
  try {
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await finishMotion(page);
    await expect(page.locator('.hero-seat .seat-bet')).toHaveAttribute('data-wager-amount', '50');
    await expect(page.locator('.seat:not(.hero-seat) .seat-bet')).toHaveAttribute('data-wager-amount', '100');
    await expect(page.locator('.pot-display strong')).toHaveText('0');
    await command(page, { type: 'act', action: 'raise', amount: 200 });
    await finishMotion(page);
    await command(guest, { type: 'act', action: 'raise', amount: 400 });
    await finishMotion(page);
    await expect(page.locator('.hero-seat .seat-bet')).toHaveAttribute('data-wager-amount', '200');
    await expect(page.locator('.seat:not(.hero-seat) .seat-bet')).toHaveAttribute('data-wager-amount', '400');
    await expect(page.locator('.pot-display strong')).toHaveText('0');
    await expect(page.locator('.pot-display')).toHaveAttribute('aria-description', 'Total including street wagers: 600 chips');
    await page.screenshot({ path: testInfo.outputPath('raised-street-wagers.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('raised-street-wagers-mobile.png'), animations: 'disabled', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const flop = await command(page, { type: 'act', action: 'call' });
    expect(flop.hand?.pot).toBe(800);
    await expect(page.locator('.moving-chips[data-motion-kind="collect"]')).toHaveCount(2);
    await expect(page.locator('.seat-bet:not(.wager-empty)')).toHaveCount(2);
    await expect(page.locator('.hero-seat .seat-bet')).toHaveAttribute('data-wager-amount', '400');
    await expect(page.locator('.pot-display strong')).toHaveText('0');
    await expect(guest.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    await expectChipPath(page, 'collect', hostUser.id);
    await expect(page.locator('.pot-display strong')).toHaveText('800');
    await expect(page.locator('.seat-bet:not(.wager-empty)')).toHaveCount(0);
    await finishMotion(page);
    await page.getByLabel('Table animations', { exact: true }).selectOption('off');
    await command(guest, { type: 'act', action: 'raise', amount: 100 });
    await expect(page.locator('.seat:not(.hero-seat) .seat-bet')).toHaveAttribute('data-wager-amount', '100');
    await expect(page.locator('.pot-display strong')).toHaveText('800');
    await expect(page.locator('.pot-display')).toHaveAttribute('aria-description', 'Total including street wagers: 900 chips');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.locator('.pot-display strong')).toHaveText('800');
    await expect(page.locator('.seat:not(.hero-seat) .seat-bet')).toHaveAttribute('data-wager-amount', '100');
    expect((await current(page, baseURL!, room.id)).hand?.pot).toBe(900);
  } finally { await guestContext.close(); }
});

test('emotes and mute controls coexist with live animation, wager piles and per-browser motion settings', async ({ page, browser, baseURL }) => {
  const { room, guest, guestContext, command } = await setup(page, browser, baseURL!);
  const say = async (client: Page, phrase: string) => {
    await client.getByRole('button', { name: 'Open emote menu', exact: true }).click();
    await client.getByRole('menuitem', { name: phrase, exact: true }).click();
    await expect(client.getByRole('menu')).toHaveCount(0);
  };
  try {
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await expect(page.locator('.moving-card')).toHaveCount(4);
    const version = (await current(page, baseURL!, room.id)).version;
    await page.locator('.table-stage').evaluate(table => table.getAnimations({ subtree: true }).forEach(animation => animation.pause()));
    await say(page, 'Hello');
    await expect(guest.getByRole('status', { name: 'Motion host says Hello', exact: true })).toBeVisible();
    await expect(page.locator('.moving-card')).toHaveCount(4);
    expect(await page.locator('.moving-card').first().evaluate(element => element.getAnimations()[0]?.playState)).toBe('paused');
    expect((await current(page, baseURL!, room.id)).version).toBe(version);
    await guest.getByRole('button', { name: "Motion host's emote options", exact: true }).click({ button: 'right' });
    await guest.getByRole('menuitem', { name: 'Mute emotes', exact: true }).click();
    await expect(guest.getByRole('status', { name: 'Motion host says Hello', exact: true })).toHaveCount(0);
    await page.getByLabel('Table animations', { exact: true }).selectOption('off');
    await finishMotion(page);
    await say(guest, 'Nice hand!');
    await expect(page.getByRole('status', { name: 'Motion guest says Nice hand!', exact: true })).toBeVisible();
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.getByLabel('Table animations', { exact: true }).selectOption('on');
    await command(page, { type: 'act', action: 'raise', amount: 200 });
    await expect(page.locator('.moving-chips[data-motion-kind="bet"]')).toHaveCount(1);
    await finishMotion(page);
    await expect(page.locator('.hero-seat .seat-bet')).toHaveAttribute('data-wager-amount', '200');
    await expect(page.locator('.pot-display strong')).toHaveText('0');
    await expect(page.getByRole('status', { name: 'Motion guest says Nice hand!', exact: true })).toBeVisible();
    expect(await page.locator('.table-stage').evaluate(table => {
      const bubbles = [...table.querySelectorAll('.seat-emote-bubble')].map(element => element.getBoundingClientRect());
      return [...table.querySelectorAll('.seat-bet:not(.wager-empty)')].every(element => {
        const wager = element.getBoundingClientRect();
        return bubbles.every(bubble => Math.min(wager.right, bubble.right) <= Math.max(wager.left, bubble.left) ||
          Math.min(wager.bottom, bubble.bottom) <= Math.max(wager.top, bubble.top));
      });
    })).toBe(true);
  } finally { await guestContext.close(); }
});

test('community streets and multi-run showdowns animate only visible new cards', async ({ page, browser, baseURL }, testInfo) => {
  const { room, guest, guestContext, command } = await setup(page, browser, baseURL!, 'holdem', 2);
  try {
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await finishMotion(page);
    await command(page, { type: 'act', action: 'call' });
    await finishMotion(page);
    await command(guest, { type: 'act', action: 'check' });
    await expect(page.locator('.moving-card')).toHaveCount(3);
    await expect(page.locator('[data-card-target="board:0:0:0"]')).toHaveCount(1);
    for (const client of [page, guest]) {
      const flop = await current(client, baseURL!, room.id);
      const own = flop.players.find(player => player.id === flop.youId)!;
      const rank = evaluate([...own.cards.filter((card): card is string => card !== null), ...flop.hand!.boards[0]!]);
      await expect(client.getByRole('region', { name: 'Your current hand', exact: true })).toContainText(describeHand(rank));
    }
    await finishMotion(page);
    await command(guest, { type: 'act', action: 'raise', amount: 400 });
    await expect(page.getByRole('button', { name: /^Call / })).toBeEnabled();
    await finishMotion(page);
    const vote = await command(page, { type: 'act', action: 'call' });
    await expect(page.locator('.runout-decision')).toBeVisible();
    await finishMotion(page);
    await expect(page.locator('.seat-bet:not(.wager-empty)')).toHaveCount(0);
    await command(page, { type: 'runouts', handId: vote.hand!.id, count: 2 });
    const completed = await command(guest, { type: 'runouts', handId: vote.hand!.id, count: 2 });
    await expect(page.locator('.moving-chips[data-motion-kind="collect"]')).toHaveCount(0);
    await expect(page.locator('[data-card-target="board:0:0:3"]')).toHaveCount(1);
    await expect(page.locator('[data-card-target="board:0:0:4"]')).toHaveCount(1);
    await expect(page.locator('[data-card-target="board:0:0:0"]')).toHaveCount(0);
    expect(completed.hand?.runoutCount).toBe(2);
    for (const [runoutIndex] of completed.hand!.runoutBoards.entries()) {
      const group = page.getByRole('article', { name: `Run ${runoutIndex + 1}, board 1 winners`, exact: true });
      const awards = completed.hand!.results.filter(result => result.runoutIndex === runoutIndex);
      const ids = [...new Set(awards.flatMap(result => result.winners))];
      await expect(group.locator('.winning-hand')).toHaveCount(ids.length);
      for (const id of ids) {
        const player = completed.players.find(item => item.id === id)!;
        const amount = awards.reduce((sum, result) => sum + (result.shares[id] ?? 0), 0);
        const winner = group.locator(`[data-winner-id="${id}"]`);
        const rank = evaluate([...completed.hand!.revealed[id]!, ...completed.hand!.runoutBoards[runoutIndex]![0]!]);
        await expect(winner).toContainText(player.name);
        await expect(winner.locator('.winning-player')).toContainText(`${amount.toLocaleString('en-US')} chips`);
        await expect(winner.locator('.winning-description')).toHaveText(describeHand(rank));
        await expect(winner.locator('.winning-cards .card-face')).toHaveCount(5);
      }
    }
    const winningCard = page.locator('.winning-board').first().locator('[data-winning-animation="gather"]').first();
    await expect(winningCard).toBeAttached();
    const gathered = await winningCard.evaluate(element => {
      const animation = element.getAnimations()[0]!;
      animation.pause();
      const timing = animation.effect!.getTiming();
      animation.currentTime = Number(timing.delay) + Number(timing.duration) * .2;
      const start = element.getBoundingClientRect();
      animation.currentTime = Number(timing.delay) + Number(timing.duration) * .8;
      const end = element.getBoundingClientRect();
      animation.play();
      return { distance: Math.hypot(end.x - start.x, end.y - start.y), duration: timing.duration };
    });
    expect(gathered.distance).toBeGreaterThan(15);
    expect(gathered.duration).toBe(650);
    const payouts = await page.locator('.moving-chips[data-motion-kind="payout"]').evaluateAll(elements =>
      elements.reduce((sum, element) => sum + Number((element as HTMLElement).dataset.amount), 0));
    expect(payouts).toBe(1000);
    await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
    await finishMotion(page);
    await expect(page.locator('[data-winning-animation]')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Run 2', exact: true }).click();
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await expect(page.locator('[data-winning-animation]')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Run 2, board 1', exact: true }).locator('.card-face')).toHaveCount(5);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Hand results', exact: true })).toBeVisible();
    await expect(page.locator('[data-winning-animation]')).toHaveCount(0);
    await page.getByRole('region', { name: 'Hand results', exact: true }).screenshot({ path: testInfo.outputPath('winning-runouts.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.locator('.winning-cards').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth))).toBe(true);
    }
    await page.getByRole('region', { name: 'Hand results', exact: true }).screenshot({ path: testInfo.outputPath('winning-runouts-mobile.png') });
  } finally { await guestContext.close(); }
});

test('a single-run showdown keeps its winning five visible without motion and never replays on reconnect', async ({ page, browser, baseURL }) => {
  const { guest, guestContext, command } = await setup(page, browser, baseURL!);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.table-stage')).toHaveAttribute('data-table-motion', 'off');
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await command(page, { type: 'act', action: 'raise', amount: 500 });
    const complete = await command(guest, { type: 'act', action: 'call' });
    const ids = [...new Set(complete.hand!.results.flatMap(result => result.winners))];
    const results = page.getByRole('region', { name: 'Hand results', exact: true });
    await expect(results.locator('.winning-hand')).toHaveCount(ids.length);
    await expect(results.locator('.winning-cards .card-face')).toHaveCount(ids.length * 5);
    await expect(results.locator('[data-winning-animation]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your current hand', exact: true })).toHaveCount(0);
    await page.getByLabel('Table animations', { exact: true }).selectOption('on');
    await expect(results.locator('[data-winning-animation]')).toHaveCount(0);
    await page.context().setOffline(true);
    await expect(page.locator('.connection-banner')).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(results.locator('[data-winning-animation]')).toHaveCount(0);
    await expect(results.locator('.winning-cards .card-face')).toHaveCount(ids.length * 5);
  } finally { await guestContext.close(); }
});

for (const game of ['omaha_bomb', 'indian'] as const) {
  test(`${game} deals support mobile seats and preserve variant card visibility`, async ({ page, browser, baseURL }, testInfo) => {
    const { guest, guestContext } = await setup(page, browser, baseURL!, game);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Deal first hand' }).click();
      await expect(page.locator('.moving-card')).toHaveCount(game === 'omaha_bomb' ? 14 : 4);
      await expect(page.locator('.table-motion-layer .card-face')).toHaveCount(0);
      if (game === 'indian') {
        await expect(page.getByRole('region', { name: 'Your current hand', exact: true })).toContainText('Your cards are hidden in Indian poker.');
        await expect(page.locator('.hero-seat .card-face')).toHaveCount(0);
        await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(2);
        await expect(guest.locator('.hero-seat .card-face')).toHaveCount(0);
      } else {
        const currentHand = page.getByRole('region', { name: 'Your current hand', exact: true });
        await expect(currentHand).toContainText('Board 1:');
        await expect(currentHand).toContainText('Board 2:');
        await expect(currentHand).toHaveAttribute('aria-description', /Use exactly two hole cards and three board cards/);
        await expect(page.locator('[data-card-target^="board:0:1:"]')).toHaveCount(3);
        await expect(page.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${game}-dealing-mobile.png`) });
      await page.setViewportSize({ width: 320, height: 844 });
      await expect(page.locator('.table-motion-layer')).toHaveCount(0);
      await finishMotion(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await guestContext.close(); }
  });
}

test('motion preferences persist, follow reduced motion and cancel active flights without replay', async ({ page, browser, baseURL }) => {
  const { room, guest, guestContext, command } = await setup(page, browser, baseURL!);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.table-stage')).toHaveAttribute('data-table-motion', 'off');
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'preflop');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.getByLabel('Table animations', { exact: true }).selectOption('on');
    await expect(page.locator('.table-stage')).toHaveAttribute('data-table-motion', 'on');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await command(page, { type: 'act', action: 'raise', amount: 300 });
    await expect(page.locator('.moving-chips')).toHaveCount(1);
    await page.getByLabel('Table animations', { exact: true }).selectOption('off');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.getByLabel('Table animations', { exact: true })).toHaveValue('off');
    await page.getByLabel('Table animations', { exact: true }).selectOption('system');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('.table-stage')).toHaveAttribute('data-table-motion', 'on');
    await command(guest, { type: 'act', action: 'fold' });
    await expect(page.locator('.moving-chips')).not.toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await finishMotion(page);
    const settled = await current(page, baseURL!, room.id);
    expect(settled.hand?.street).toBe('complete');
    await page.context().setOffline(true);
    await expect(page.locator('.connection-banner')).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
  } finally { await guestContext.close(); }
});
