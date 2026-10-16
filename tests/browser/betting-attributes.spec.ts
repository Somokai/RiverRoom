import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, type Command, type Identity, type RoomView } from '../../src/shared/model';

interface Client { page: Page; user: Identity }
async function setup(page: Page, browser: Browser, origin: string) {
  const context = await browser.newContext({ baseURL: origin });
  const other = await context.newPage();
  const clients: Client[] = [];
  const errors: string[] = [];
  for (const [index, client] of [page, other].entries()) {
    client.on('pageerror', error => errors.push(error.message));
    const response = await client.request.post('/api/auth/guest', {
      headers: { Origin: origin }, data: { name: index ? 'Cap guest' : 'Cap host' },
    });
    expect(response.ok()).toBe(true);
    clients.push({ page: client, user: (await response.json()).user });
  }
  const host = clients[0]!;
  const guest = clients[1]!;
  const created = await page.request.post('/api/rooms', {
    headers: { Origin: origin, 'X-CSRF-Token': host.user.csrf },
    data: { name: 'Independent betting attributes', settings: { ...DEFAULT_SETTINGS, maxSeats: 2, turnSeconds: 120, autoDeal: false },
      buyIn: 10000, commandId: crypto.randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const initial: RoomView = (await created.json()).room;
  const current = async (client = host): Promise<RoomView> => {
    const response = await client.page.request.get(`/api/rooms/${initial.id}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).room;
  };
  const command = async (client: Client, command: Command): Promise<RoomView> => {
    const room = await current(client);
    const response = await client.page.request.post(`/api/rooms/${initial.id}/commands`, {
      headers: { Origin: origin, 'X-CSRF-Token': client.user.csrf },
      data: { command, commandId: crypto.randomUUID(), expectedVersion: room.version },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).room;
  };
  const joined = await other.request.post('/api/rooms/join', {
    headers: { Origin: origin, 'X-CSRF-Token': guest.user.csrf },
    data: { code: initial.code, commandId: crypto.randomUUID() },
  });
  expect(joined.ok()).toBe(true);
  const funding = await command(guest, { type: 'fund', amount: 10000 });
  await command(host, { type: 'approve', requestId: funding.requests.at(-1)!.id, approve: true });
  for (const client of clients) {
    await client.page.goto(`/?table=${initial.id}`);
    await expect(client.page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  }
  return { host, guest, initial, current, errors, close: () => context.close() };
}

test('Omaha and pot limit switch independently, validate the cap, and preserve the active hand', async ({ page, browser, baseURL }, testInfo) => {
  const fixture = await setup(page, browser, baseURL!);
  const { guest, current, errors } = fixture;
  try {
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    const omaha = page.getByLabel('Omaha (four cards)', { exact: true });
    const potLimit = page.getByLabel('Pot limit', { exact: true });
    const cap = page.getByLabel('Post-flop cap per player (chips)', { exact: true });
    const save = page.getByRole('button', { name: 'Save next-hand rules', exact: true });
    await expect(omaha).not.toBeChecked();
    await expect(potLimit).not.toBeChecked();
    await expect(cap).toHaveValue('0');
    for (const invalid of ['', '-1', '1.5', '10000001']) {
      await cap.fill(invalid);
      await expect(save).toBeDisabled();
    }
    await cap.fill('0');
    await omaha.check();
    await expect(potLimit).not.toBeChecked();
    await potLimit.check();
    await omaha.uncheck();
    await expect(potLimit).toBeChecked();
    await omaha.check();
    await potLimit.uncheck();
    await expect(omaha).toBeChecked();
    await save.click();
    await expect(page.locator('.queued-hand-rules')).toContainText('No-limit Omaha');
    await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'All in', exact: true })).toBeEnabled();
    const active = await current();
    expect(active.hand!.rules).toMatchObject({ game: 'omaha', potLimit: false, postflopCap: 0 });
    expect(active.legal.maxRaiseTo).toBe(active.legal.allInTo);
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    await omaha.uncheck();
    await potLimit.check();
    await cap.fill('500');
    await page.locator('#next-hand-editor').screenshot({ path: testInfo.outputPath('independent-betting-options.png') });
    await save.click();
    await expect(page.locator('.queued-hand-rules')).toContainText("Pot-limit Hold'em");
    await expect(page.locator('.queued-hand-rules')).toContainText('500 post-flop cap per player');
    expect((await current()).hand!.rules).toEqual(active.hand!.rules);
    await expect(page.locator('.active-hand-rules')).toContainText('No-limit Omaha');
    await page.getByRole('button', { name: 'Fold', exact: true }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'complete');
    await page.getByRole('button', { name: 'Deal next hand', exact: true }).click();
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
    const next = await current(guest);
    expect(next.hand!.rules).toMatchObject({ game: 'holdem', potLimit: true, postflopCap: 500 });
    expect(next.legal.bettingLimit).toBe('pot_limit');
    expect(next.legal.maxRaiseTo).toBeLessThan(next.legal.allInTo);
    expect(next.hand!.players.every(player => player.postflopCommitted === 0)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('post-flop cap controls carry the allowance across streets and cap-ending calls preserve unused stacks', async ({ page, browser, baseURL }) => {
  const fixture = await setup(page, browser, baseURL!);
  const { guest, current, initial, errors } = fixture;
  try {
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    await page.getByLabel('Bomb pot', { exact: true }).check();
    await page.getByLabel('Bomb ante (chips per player)').fill('25');
    await page.getByLabel('Post-flop cap per player (chips)').fill('500');
    await page.getByLabel('All-in runout consent').selectOption('3');
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText('500 post-flop cap per player');
    await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
    await expect(guest.page.locator('.table-stage')).toHaveAttribute('data-street', 'flop');
    expect((await current()).hand!.players.map(player => player.postflopCommitted)).toEqual([0, 0]);
    await expect(guest.page.locator('#betting-limits')).toContainText('500 remaining for you');
    await expect(guest.page.getByRole('button', { name: 'Bet cap', exact: true })).toBeEnabled();
    await guest.page.getByLabel('Raise-to amount', { exact: true }).fill('200');
    await guest.page.getByRole('button', { name: /^Bet 200/ }).click();
    await page.getByRole('button', { name: 'Call 200', exact: true }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'turn');
    await expect(guest.page.locator('#betting-limits')).toContainText('300 remaining for you');
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    await page.getByLabel('Post-flop cap per player (chips)').fill('50');
    await page.getByLabel('Pot limit', { exact: true }).check();
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText('50 post-flop cap per player');
    const configured = await current();
    await expect(guest.page.locator('.table-stage')).toHaveAttribute('data-room-version', String(configured.version));
    expect(configured.hand!.rules).toMatchObject({ postflopCap: 500, potLimit: false });
    await guest.page.getByLabel('Raise-to amount', { exact: true }).fill('301');
    await expect(guest.page.locator('.button-raise')).toBeDisabled();
    await guest.page.getByLabel('Raise-to amount', { exact: true }).fill('300');
    await guest.page.getByRole('button', { name: 'Bet cap', exact: true }).click();
    await expect(guest.page.locator('.hero-seat .seat-action')).toHaveText('CAPPED');
    await expect(guest.page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Call 300/ })).toBeEnabled();
    const [request] = await Promise.all([
      page.waitForRequest(request => request.url().endsWith(`/rooms/${initial.id}/commands`) && request.method() === 'POST'),
      page.getByRole('button', { name: 'Bet cap', exact: true }).click(),
    ]);
    expect(request.postDataJSON().command).toEqual({ type: 'act', action: 'call' });
    await expect(page.locator('.runout-decision')).toBeVisible();
    await expect(page.locator('.runout-decision')).toContainText('post-flop cap');
    const capped = await current();
    expect(capped.players.map(player => player.stack)).toEqual([9475, 9475]);
    expect(capped.hand!.players.map(player => player.postflopCommitted)).toEqual([500, 500]);
    expect(capped.players.find(player => player.id === guest.user.id)!.cards).toEqual([null, null]);
    await page.getByRole('button', { name: 'Run once', exact: true }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'complete');
    const complete = await current();
    expect(complete.hand!.awardedPot).toBe(1050);
    expect(complete.players.every(player => player.stack >= 9475)).toBe(true);
    expect(complete.players.reduce((sum, player) => sum + player.stack, 0)).toBe(20000);
    const history = await page.request.get(`/api/rooms/${initial.id}/hands`);
    expect((await history.json()).entries[0].rules).toMatchObject({ postflopCap: 500, potLimit: false });
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});
