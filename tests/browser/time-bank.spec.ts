import { expect, test, type Page } from '@playwright/test';
import { type Command, type Identity, type LedgerRow, type RoomView } from '../../src/shared/model';

test('House rules award time banks and real turns consume them only after the normal clock', async ({ page, browser, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByLabel('Your player name').fill('Bank host');
  await page.getByLabel('Table name', { exact: true }).fill('Time-bank table');
  await page.getByLabel('Your starting chips').fill('10000');
  await page.getByRole('button', { name: 'Show house rules' }).click();
  await expect(page.getByLabel('Time bank added (seconds)')).toHaveValue('0');
  await expect(page.getByLabel('Add time bank every (hands)')).toHaveValue('10');
  await page.getByLabel('Turn clock (seconds)').fill('15');
  await page.getByLabel('Time bank added (seconds)').fill('3');
  await page.getByLabel('Add time bank every (hands)').fill('2');
  await page.getByLabel('Seats', { exact: true }).fill('2');
  await page.getByLabel('Automatically deal the next hand').uncheck();
  await page.getByRole('button', { name: 'Create private table', exact: true }).click();
  await page.getByRole('button', { name: 'I have saved my key' }).click();
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  const id = new URL(page.url()).searchParams.get('table')!;
  const host = { page, user: (await (await page.request.get('/api/me')).json()).user as Identity };
  const current = async (client = host): Promise<RoomView> => {
    const response = await client.page.request.get(`/api/rooms/${id}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).room;
  };
  const initial = await current();
  expect(initial.settings).toMatchObject({ turnSeconds: 15, timeBankSeconds: 3, timeBankEveryHands: 2 });

  const context = await browser.newContext({ baseURL });
  try {
    const guestPage = await context.newPage();
    guestPage.on('pageerror', error => errors.push(error.message));
    const identity = await guestPage.request.post('/api/auth/guest', {
      headers: { Origin: baseURL! }, data: { name: 'Bank guest' },
    });
    expect(identity.ok()).toBe(true);
    const guest = { page: guestPage, user: (await identity.json()).user as Identity };
    const clients = [host, guest];
    const post = async (client: { page: Page; user: Identity }, path: string, data: object) => {
      const response = await client.page.request.post(path, {
        headers: { Origin: baseURL!, 'X-CSRF-Token': client.user.csrf }, data,
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const command = async (client: { page: Page; user: Identity }, command: Command): Promise<RoomView> => {
      const room = await current(client);
      return (await post(client, `/api/rooms/${id}/commands`, {
        expectedVersion: room.version, commandId: crypto.randomUUID(), command,
      })).room;
    };
    await post(guest, '/api/rooms/join', { code: initial.code, commandId: crypto.randomUUID() });
    const funding = await command(guest, { type: 'fund', amount: 10000 });
    await command(host, { type: 'approve', requestId: funding.requests.at(-1)!.id, approve: true });
    await guestPage.goto(`/?table=${id}`);
    await expect(guestPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(guestPage.getByRole('button', { name: 'House rules', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'House rules', exact: true }).click();
    await expect(page.getByLabel('Time bank added (seconds)')).toHaveValue('3');
    await expect(page.getByRole('dialog')).toContainText('Unused turn-clock seconds are discarded, never banked.');
    await page.getByLabel('Time bank added (seconds)').fill('6');
    await page.getByLabel('Add time bank every (hands)').fill('0');
    await page.getByRole('button', { name: 'Save house rules', exact: true }).click();
    expect(await page.getByLabel('Add time bank every (hands)').evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    expect((await current()).settings.timeBankSeconds).toBe(3);
    await page.getByLabel('Add time bank every (hands)').fill('2');
    await page.getByRole('button', { name: 'Save house rules', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await current()).settings).toMatchObject({ timeBankSeconds: 6, timeBankEveryHands: 2 });

    for (let hand = 0; hand < 2; hand++) {
      await page.getByRole('button', { name: hand === 0 ? 'Deal first hand' : 'Deal next hand', exact: true }).click();
      await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'preflop');
      const dealt = await current();
      const acting = clients.find(client => client.user.id === dealt.hand!.actorId)!;
      await acting.page.getByRole('button', { name: 'Fold', exact: true }).click();
      for (const client of clients) await expect(client.page.locator('.table-stage')).toHaveAttribute('data-street', 'complete');
      expect((await current()).players.every(player => player.timeBankMs === (hand === 1 ? 6000 : 0))).toBe(true);
    }
    for (const client of clients)
      await expect(client.page.getByRole('timer', { name: "Bank host's time bank: 6 seconds", exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Deal next hand', exact: true }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'preflop');
    const third = await current();
    expect(third.hand!.actorId).toBe(host.user.id);
    expect(third.hand!.deadline! - third.hand!.baseDeadline!).toBe(6000);
    const hostClock = page.locator('.hero-seat .seat-action');
    await expect(hostClock).toHaveText(/\d+s to act/);
    expect(parseInt((await hostClock.textContent())!)).toBeLessThanOrEqual(15);
    await expect(hostClock).toHaveText(/^Bank: [1-6]s$/, { timeout: 20000 });
    await expect.poll(async () => (await current()).players.find(player => player.id === host.user.id)!.timeBankMs).toBeLessThan(6000);
    const inBank = await current();
    expect(inBank.version).toBe(third.version);
    expect(inBank.legal.canAct).toBe(true);
    expect(inBank.players.find(player => player.id === host.user.id)!.timeoutCount).toBe(0);

    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/api/rooms/${id}/commands`) && response.request().method() === 'POST'),
      page.getByRole('button', { name: /^Call / }).click(),
    ]);
    expect(response.ok()).toBe(true);
    const afterCall = (await response.json()).room as RoomView;
    const retained = afterCall.players.find(player => player.id === host.user.id)!.timeBankMs;
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(6000);
    expect(afterCall.hand!.actorId).toBe(guest.user.id);
    await page.reload();
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    expect((await current()).players.find(player => player.id === host.user.id)!.timeBankMs).toBe(retained);

    const guestClock = guestPage.locator('.hero-seat .seat-action');
    await expect(guestClock).toHaveText(/^Bank: [1-6]s$/, { timeout: 20000 });
    const beforeTimeout = await current(guest);
    expect(beforeTimeout.version).toBe(afterCall.version);
    expect(beforeTimeout.legal.canCheck).toBe(true);
    expect(beforeTimeout.players.find(player => player.id === guest.user.id)!.timeoutCount).toBe(0);
    await expect.poll(async () => (await current()).version, { timeout: 10000 }).toBeGreaterThan(afterCall.version);
    const timed = await current();
    expect(timed.hand!.street).toBe('flop');
    expect(timed.players.find(player => player.id === guest.user.id)).toMatchObject({ timeBankMs: 0, timeoutCount: 1 });
    expect(timed.players.find(player => player.id === host.user.id)!.timeBankMs).toBe(retained);
    const ledger = await page.request.get(`/api/rooms/${id}/ledger`);
    const entries = (await ledger.json()).entries as LedgerRow[];
    expect(entries.filter(entry => entry.kind === 'bet' && entry.handId === third.hand!.id)).toHaveLength(1);
    await page.getByRole('button', { name: 'Pause table', exact: true }).click();
    await expect.poll(async () => (await current()).paused).toBe(true);
    expect((await current()).hand).toMatchObject({ baseDeadline: null, deadline: null });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
