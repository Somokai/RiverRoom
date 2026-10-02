import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import type { Identity, RoomView } from '../../src/shared/model';

async function dismissRecovery(page: Page) {
  await expect(page.getByRole('heading', { name: 'Keep your seat. Save this key.' })).toBeVisible();
  await page.getByRole('button', { name: 'I have saved my key' }).click();
}
async function createTable(page: Page, name = 'Friday night, good company', seats = 9) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByLabel('Your player name').fill('Maya');
  await page.getByLabel('Table name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Show house rules' }).click();
  await page.getByLabel('Automatically deal the next hand').uncheck();
  await page.getByLabel('Turn clock (seconds)').fill('120');
  await page.getByLabel('Seats', { exact: true }).fill(String(seats));
  await page.getByRole('button', { name: 'Create private table', exact: true }).click();
  await dismissRecovery(page);
  await expect(page.getByRole('heading', { name, exact: false })).toBeVisible();
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  await expect(page).toHaveURL(/table=/);
  const roomId = new URL(page.url()).searchParams.get('table')!;
  const state = await getRoom(page, roomId);
  return state;
}
async function getRoom(page: Page, id: string): Promise<RoomView> {
  const response = await page.request.get(`/api/rooms/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).room;
}
async function getIdentity(page: Page): Promise<Identity> { return (await (await page.request.get('/api/me')).json()).user; }
async function post(page: Page, path: string, body: object) {
  const identity = await getIdentity(page);
  const response = await page.request.post(`/api${path}`, { headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': identity.csrf,
  }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function serverCommand(page: Page, id: string, command: object): Promise<RoomView> {
  const room = await getRoom(page, id);
  return (await post(page, `/rooms/${id}/commands`, { commandId: crypto.randomUUID(), expectedVersion: room.version, command })).room;
}
async function guestJoin(page: Page, code: string, name: string) {
  await page.goto(`/?join=${code}`);
  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Your player name').fill(name);
  await expect(page.getByLabel('Invite code')).toHaveValue(code);
  await page.getByRole('button', { name: 'Join the table', exact: true }).click();
  await dismissRecovery(page);
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
}
async function buyIn(page: Page, amount = '10000') {
  await page.locator('.between-actions').getByRole('button', { name: 'Buy in', exact: true }).click();
  await page.getByLabel('Chips to add').fill(amount);
  await page.getByRole('button', { name: 'Request host approval' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function checkAction(page: Page, roomId: string) {
  const view = await getRoom(page, roomId);
  expect(view.legal.canAct).toBe(true);
  const name = view.legal.canCheck ? /^Check$/ : /^Call /;
  const action = page.locator('.action-buttons').getByRole('button', { name });
  await expect(action).toBeEnabled();
  await action.click();
  await expect.poll(async () => (await getRoom(page, roomId)).version).toBeGreaterThan(view.version);
}

test('two independent players can play, reconnect, rebuy, cash out, and reconcile a finished session', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const initial = await createTable(page);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  guestPage.on('pageerror', error => errors.push(error.message));
  try {
    await guestJoin(guestPage, initial.code, 'Leo');
    await buyIn(guestPage);
    await page.getByRole('button', { name: 'Approve Leo' }).click();
    await expect(guestPage.locator('.bankroll-main strong').first()).toContainText('10,000');
    await expect(guestPage.getByRole('button', { name: 'House rules' })).toHaveCount(0);
    await guestPage.getByRole('button', { name: 'Table talk' }).click();
    await guestPage.getByRole('textbox', { name: 'Message the table' }).fill('Good luck, everyone!');
    await guestPage.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Table talk' }).click();
    await expect(page.locator('.chat-message')).toContainText('Good luck, everyone!');

    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await expect(page.getByRole('button', { name: '3 times big blind' })).toBeEnabled();
    for (const [preset, value] of [['Half pot', '200'], ['Three-quarter pot', '250'], ['Full pot', '300'], ['3 times big blind', '300']]) {
      await page.getByRole('button', { name: preset!, exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: 'Raise-to amount' })).toHaveValue(value!);
    }
    const hostView = await getRoom(page, initial.id);
    const opponentView = await getRoom(guestPage, initial.id);
    expect(hostView.players.find(player => player.id === opponentView.youId)?.cards).toEqual([null, null]);
    expect(opponentView.players.find(player => player.id === hostView.youId)?.cards).toEqual([null, null]);
    await page.getByRole('button', { name: 'Raise to 300' }).click();
    await expect(guestPage.getByRole('button', { name: 'Call 200' })).toBeEnabled();
    await guestPage.getByRole('button', { name: 'Call 200' }).click();
    await expect(page.locator('.street-label')).toHaveText('FLOP');

    await guestContext.setOffline(true);
    await expect(guestPage.locator('.connection-banner')).toBeVisible();
    await guestContext.setOffline(false);
    await expect(guestPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await guestPage.reload();
    await expect(guestPage.getByRole('heading', { name: initial.name })).toBeVisible();
    await expect(guestPage.locator('.street-label')).toHaveText('FLOP');
    for (let turns = 0; turns < 10; turns++) {
      const view = await getRoom(page, initial.id);
      if (view.hand?.street === 'complete') break;
      await checkAction(view.hand?.actorId === view.youId ? page : guestPage, initial.id);
    }
    await expect(page.locator('.street-label')).toHaveText('HAND COMPLETE');
    await expect(guestPage.locator('.street-label')).toHaveText('HAND COMPLETE');

    await page.locator('.bankroll-actions').getByRole('button', { name: 'Add / rebuy' }).click();
    await page.getByLabel('Chips to add').fill('1000');
    await page.getByRole('button', { name: 'Add chips to my session' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await getRoom(page, initial.id)).players.find(player => player.id === hostView.youId)?.buyIns).toBe(11000);

    await guestPage.getByRole('button', { name: 'Cash out', exact: true }).click();
    await guestPage.getByRole('button', { name: 'Confirm cash-out' }).click();
    await expect(guestPage.getByRole('dialog')).toHaveCount(0);
    await guestPage.getByRole('button', { name: 'Take a seat again' }).click();
    await expect(guestPage.getByRole('button', { name: 'Rebuy chips' })).toBeEnabled();
    await guestPage.getByRole('button', { name: 'Rebuy chips' }).click();
    await guestPage.getByLabel('Chips to add').fill('5000');
    await guestPage.getByRole('button', { name: 'Request host approval' }).click();
    await page.getByRole('button', { name: 'Approve Leo' }).click();
    await expect.poll(async () => (await getRoom(guestPage, initial.id)).players.find(player => player.id === opponentView.youId)?.rebuyCount).toBe(1);

    await page.getByRole('button', { name: 'House rules' }).click();
    await page.getByRole('button', { name: 'End session' }).click();
    await page.getByRole('button', { name: 'Close and record cash-outs' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.turn-heading')).toHaveText('SESSION COMPLETE');
    const final = await getRoom(page, initial.id);
    expect(final.players.every(player => player.stack === 0)).toBe(true);
    expect(final.players.reduce((sum, player) => sum + player.cashOuts, 0)).toBe(final.players.reduce((sum, player) => sum + player.buyIns, 0));
    await page.getByRole('button', { name: 'View final ledger' }).click();
    await expect(page.locator('.data-table tbody tr')).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Verify history' }).click();
    await expect(page.getByText(/Hash chain verified:/)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Ledger CSV' }).click();
    expect((await download).suggestedFilename()).toContain('-ledger.csv');
    const exported = await page.request.get(`/api/rooms/${initial.id}/export.json`);
    expect((await exported.json()).audit.some((entry: { command: string }) => entry.command === 'close')).toBe(true);
    expect(errors).toEqual([]);
  } finally { await guestContext.close(); }
});

test('per-table emojis update live, survive reconnects, and can be searched, changed, and removed on mobile', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const initial = await createTable(page, 'Emoji table', 2);
  const guestName = 'Leo The River Room Shark';
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  guestPage.on('pageerror', error => errors.push(error.message));
  try {
    await guestJoin(guestPage, initial.code, guestName);
    const guestIdentity = await getIdentity(guestPage);
    await guestPage.getByRole('button', { name: 'Choose table emoji', exact: true }).click();
    const picker = guestPage.getByRole('dialog', { name: 'Choose your table emoji', exact: true });
    await expect(guestPage.getByRole('searchbox', { name: 'Search emojis' })).toBeFocused();
    await expect(picker.getByRole('button', { name: 'Remove emoji', exact: true })).toBeDisabled();
    await picker.getByRole('searchbox').fill('no-such-emoji');
    await expect(picker.getByRole('status')).toHaveText('No emojis found. Try another search.');
    await picker.getByRole('searchbox').fill('cool');
    await picker.getByRole('button', { name: 'Choose Sunglasses', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(guestPage.locator('.hero-seat').getByRole('img', { name: 'Sunglasses', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Poker table' }).getByRole('img', { name: 'Sunglasses', exact: true })).toBeVisible();
    await expect(page.locator('.player-row').filter({ hasText: guestName }).getByRole('img', { name: 'Sunglasses', exact: true })).toBeVisible();
    await expect(page.locator('.hero-seat .player-emoji')).toHaveCount(0);

    const ownSeat = page.getByRole('button', { name: 'Change your table emoji', exact: true });
    await ownSeat.focus();
    await ownSeat.press('Enter');
    await page.getByRole('group', { name: 'Emoji categories' }).getByRole('button', { name: 'Animals', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose Sunglasses', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose Shark', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(guestPage.getByRole('region', { name: 'Poker table' }).getByRole('img', { name: 'Shark', exact: true })).toBeVisible();

    await buyIn(guestPage);
    await page.getByRole('button', { name: `Approve ${guestName}` }).click();
    await expect(guestPage.locator('.bankroll-main strong').first()).toContainText('10,000');
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    await expect(guestPage.locator('.street-label')).toHaveText('PREFLOP');
    const before = await getRoom(guestPage, initial.id);
    await guestPage.getByRole('button', { name: 'Choose table emoji', exact: true }).click();
    await picker.getByRole('searchbox').fill('streak');
    await picker.getByRole('button', { name: 'Choose Fire', exact: true }).click();
    await expect(picker).toHaveCount(0);
    expect((await getRoom(guestPage, initial.id)).hand).toEqual(before.hand);
    expect((await getIdentity(guestPage)).name).toBe(guestIdentity.name);
    await serverCommand(page, initial.id, { type: 'pause', value: true });

    await guestPage.reload();
    await expect(guestPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(guestPage.locator('.hero-seat').getByRole('img', { name: 'Fire', exact: true })).toBeVisible();
    const second = await post(guestPage, '/rooms', {
      name: 'Separate emoji table', settings: initial.settings, buyIn: 10000, commandId: crypto.randomUUID(),
    });
    await guestPage.goto(`/?table=${second.room.id}`);
    await expect(guestPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(guestPage.locator('.hero-seat .player-emoji')).toHaveCount(0);
    await guestPage.goto(`/?table=${initial.id}`);
    await expect(guestPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(guestPage.locator('.hero-seat').getByRole('img', { name: 'Fire', exact: true })).toBeVisible();

    await guestPage.getByRole('button', { name: 'Choose table emoji', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Choose Fire', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await guestPage.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(guestPage.getByRole('button', { name: 'Choose table emoji', exact: true })).toBeFocused();

    await guestPage.setViewportSize({ width: 390, height: 844 });
    await guestPage.getByRole('button', { name: 'Change your table emoji', exact: true }).click();
    expect(await guestPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const bounds = await picker.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await guestPage.screenshot({ path: testInfo.outputPath('emoji-picker-mobile.png'), fullPage: true, animations: 'disabled' });
    await guestPage.route(`**/api/rooms/${initial.id}/commands`, route =>
      route.fulfill({ status: 409, json: { error: 'The table changed. Please choose your emoji again.' } }), { times: 1 });
    await picker.getByRole('button', { name: 'Choose Winking face', exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText('The table changed.');
    await expect(picker.getByRole('button', { name: 'Choose Fire', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: 'Choose Winking face', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Poker table' }).getByRole('img', { name: 'Winking face', exact: true })).toBeVisible();
    await guestPage.screenshot({ path: testInfo.outputPath('table-emoji-mobile.png'), fullPage: true, animations: 'disabled' });
    await guestPage.getByRole('button', { name: 'Change your table emoji', exact: true }).click();
    await picker.getByRole('button', { name: 'Remove emoji', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(guestPage.locator('.hero-seat .player-emoji')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Poker table' }).getByRole('img', { name: 'Winking face', exact: true })).toHaveCount(0);
    await expect(page.locator('.hero-seat').getByRole('img', { name: 'Shark', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await guestContext.close(); }
});

test('emoji interactions avoid recurring formatting work and delayed hover feedback', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const counters = { numberFormats: 0, formatCalls: 0 };
    Object.defineProperty(window, 'uiCounters', { value: counters });
    const originalFormat = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format')?.get;
    if (!originalFormat) throw new Error('Missing number formatter accessor.');
    Object.defineProperty(Intl.NumberFormat.prototype, 'format', {
      configurable: true,
      get() {
        const format: (value: number | bigint) => string = originalFormat.call(this);
        return (value: number | bigint) => { counters.formatCalls++; return format(value); };
      },
    });
    Intl.NumberFormat = new Proxy(Intl.NumberFormat, {
      construct(target, args) { counters.numberFormats++; return Reflect.construct(target, args); },
    });
  });
  let room = await createTable(page, 'Responsive table', 9);
  for (let seat = 1; seat < 9; seat++) room = await serverCommand(page, room.id, { type: 'add_bot' });
  await expect(page.locator('.player-row')).toHaveCount(9);
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async () => {
    const result = await session.send('Performance.getMetrics');
    const read = (name: string) => {
      const value = result.metrics.find(metric => metric.name === name)?.value;
      if (value === undefined) throw new Error(`Missing browser performance metric: ${name}`);
      return value;
    };
    return { script: read('ScriptDuration'), task: read('TaskDuration') };
  };
  const before = await metrics();
  const idleWork = await page.evaluate(async () => {
    const counters = (window as typeof window & { uiCounters: { numberFormats: number; formatCalls: number } }).uiCounters;
    const start = { ...counters };
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { constructors: counters.numberFormats - start.numberFormats, formats: counters.formatCalls - start.formatCalls };
  });
  const after = await metrics();
  const openTimes: number[] = [];
  const trigger = page.getByRole('button', { name: 'Choose table emoji', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Choose your table emoji', exact: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    openTimes.push(await trigger.evaluate(async element => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Expected the emoji picker button.');
      element.focus();
      const started = performance.now();
      const painted = new Promise<number>(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('dialog[open]')) {
            observer.disconnect();
            requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - started), 0));
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
      });
      element.click();
      return painted;
    }));
    await expect(dialog).toBeVisible();
    if (attempt < 4) await page.keyboard.press('Escape');
  }
  const styles = await dialog.evaluate(element => ({
    backdropFilter: getComputedStyle(element, '::backdrop').backdropFilter,
    hoverDuration: getComputedStyle(element.querySelector('.emoji-choice')!).transitionDuration,
  }));
  const pickerWork = await page.evaluate(async () => {
    const counters = (window as typeof window & { uiCounters: { numberFormats: number; formatCalls: number } }).uiCounters;
    const start = { ...counters };
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { constructors: counters.numberFormats - start.numberFormats, formats: counters.formatCalls - start.formatCalls };
  });
  const report = {
    idleWork, pickerWork, openTimes, ...styles,
    idleScriptMs: (after.script - before.script) * 1000,
    idleTaskMs: (after.task - before.task) * 1000,
  };
  console.log('UI responsiveness:', JSON.stringify(report));
  await testInfo.attach('ui-responsiveness', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(idleWork).toEqual({ constructors: 0, formats: 0 });
  expect(pickerWork).toEqual({ constructors: 0, formats: 0 });
  expect(styles.hoverDuration.split(',').every(duration => parseFloat(duration) === 0)).toBe(true);
  expect(styles.backdropFilter).toBe('none');
  await dialog.getByRole('button', { name: 'Choose Sunglasses', exact: true }).hover();
  await expect(dialog.getByRole('button', { name: 'Choose Sunglasses', exact: true })).toHaveCSS('border-color', 'rgb(228, 193, 125)');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('desktop and phone layouts expose real controls without horizontal overflow', async ({ page, browser }) => {
  const folder = resolve('preview');
  await mkdir(folder, { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Good cards. Better company.' })).toBeVisible();
  await page.screenshot({ path: resolve(folder, 'lobby.png'), fullPage: true, animations: 'disabled' });
  let room = await createTable(page, 'The Friday Club', 4);
  const contexts: BrowserContext[] = [];
  const players: Page[] = [page];
  try {
    for (const name of ['Leo', 'Harper', 'Jules']) {
      const context = await browser.newContext(); contexts.push(context);
      const other = await context.newPage(); players.push(other);
      await guestJoin(other, room.code, name);
      await buyIn(other);
      await page.getByRole('button', { name: `Approve ${name}` }).click();
      await expect(other.locator('.bankroll-main strong').first()).toContainText('10,000');
    }
    await page.getByRole('button', { name: 'Deal first hand' }).click();
    for (let turns = 0; turns < 10; turns++) {
      room = await getRoom(page, room.id);
      if (room.hand?.street === 'flop') break;
      const actorPage = (await Promise.all(players.map(async other => ({ page: other, id: (await getIdentity(other)).id })))).find(other => other.id === room.hand?.actorId)!.page;
      await checkAction(actorPage, room.id);
    }
    await expect(page.locator('.street-label')).toHaveText('FLOP');
    // Let the three opponents check so the pictured controls are genuinely the hero's turn.
    for (let i = 0; i < 3; i++) {
      room = await getRoom(page, room.id);
      if (room.hand?.actorId === room.youId) break;
      for (const other of players.slice(1)) {
        const id = (await getIdentity(other)).id;
        if (id === room.hand?.actorId) { await checkAction(other, room.id); break; }
      }
    }
    await expect(page.getByRole('button', { name: 'Half pot', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Half pot', exact: true }).click();
    await expect(page.locator('.hero-seat')).toHaveClass(/seat-active/);
    await page.getByRole('button', { name: 'Players', exact: true }).click();
    await page.screenshot({ path: resolve(folder, 'desktop.png'), fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Half pot', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    const metadata = await page.locator('.table-meta').boundingBox();
    for (const card of await page.locator('.seat:not(.hero-seat) .seat-cards .playing-card').all()) {
      const bounds = await card.boundingBox();
      expect(bounds!.y).toBeGreaterThan(metadata!.y + metadata!.height);
    }
    const foldButton = await page.getByRole('button', { name: 'Fold', exact: true }).boundingBox();
    expect(foldButton!.y + foldButton!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: resolve(folder, 'mobile.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.bankroll-actions').getByRole('button', { name: 'Add / rebuy' }).click();
    await expect(page.getByLabel('Chips to add')).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'House rules' }).click();
    await expect(page.getByLabel('Small blind')).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
  } finally { for (const context of contexts) await context.close(); }
});

test('practice bots play their own turns without private-card leaks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByLabel('Your player name').fill('Practice player');
  await page.getByRole('button', { name: 'Or practice with 3 bots' }).click();
  await dismissRecovery(page);
  await expect(page.locator('.player-row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Deal first hand' }).click();
  await expect.poll(async () => {
    const id = new URL(page.url()).searchParams.get('table')!;
    const room = await getRoom(page, id);
    return room.events.some(event => event.kind === 'action' && room.players.some(player => player.bot && player.id === event.actorId));
  }).toBe(true);
  const id = new URL(page.url()).searchParams.get('table')!;
  const room = await getRoom(page, id);
  for (const player of room.players.filter(item => item.bot && !room.hand?.revealed[item.id])) expect(player.cards).toEqual([null, null]);
  await page.getByRole('button', { name: 'Pause table', exact: true }).click();
  await expect(page.locator('.paused-overlay')).toBeVisible();
});
