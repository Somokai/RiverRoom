import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, type Command, type Identity, type LedgerRow, type RoomView } from '../../src/shared/model';

async function signIn(request: APIRequestContext, origin: string, name: string): Promise<Identity> {
  const response = await request.post('/api/auth/guest', { headers: { Origin: origin }, data: { name } });
  expect(response.ok()).toBe(true);
  return (await response.json()).user;
}

async function create(page: Page, origin: string, user: Identity): Promise<RoomView> {
  const response = await page.request.post('/api/rooms', {
    headers: { Origin: origin, 'X-CSRF-Token': user.csrf },
    data: { name: 'Readable ledger', buyIn: 1000, commandId: crypto.randomUUID(),
      settings: { ...DEFAULT_SETTINGS, autoDeal: false, turnSeconds: 120 } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).room;
}

async function read(request: APIRequestContext, id: string): Promise<RoomView> {
  const response = await request.get(`/api/rooms/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).room;
}

async function send(request: APIRequestContext, origin: string, user: Identity, id: string, command: Command): Promise<RoomView> {
  const room = await read(request, id);
  const response = await request.post(`/api/rooms/${id}/commands`, {
    headers: { Origin: origin, 'X-CSRF-Token': user.csrf },
    data: { expectedVersion: room.version, commandId: crypto.randomUUID(), command },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).room;
}

async function expectSummary(page: Page, room: RoomView) {
  const table = page.getByRole('table', { name: room.status === 'closed' ? 'Final session results' : 'Session results so far', exact: true });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Player', 'Bought in', 'Cashed out', 'Net gain / loss']);
  await expect(table.locator('tbody tr')).toHaveCount(room.players.length);
  for (const player of room.players) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: player.name, exact: true }) });
    const format = (amount: number) => amount.toLocaleString('en-US');
    await expect(row.getByRole('cell')).toHaveText([
      format(player.buyIns), format(player.cashOuts), `${player.chipNet >= 0 ? '+' : ''}${format(player.chipNet)}`,
    ]);
  }
}

test('simple session results track approved funding, active chips, cash-outs and rejoining without counting transfers twice', async ({ page, browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL });
  const guest = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const host = await signIn(page.request, baseURL!, 'Results host');
    const peer = await signIn(guest.request, baseURL!, 'Results guest');
    let room = await create(page, baseURL!, host);
    const joined = await guest.request.post('/api/rooms/join', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': peer.csrf },
      data: { code: room.code, commandId: crypto.randomUUID() },
    });
    expect(joined.ok()).toBe(true);
    room = await send(guest.request, baseURL!, peer, room.id, { type: 'fund', amount: 1000 });
    await page.goto(`/?table=${room.id}`);
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await page.getByRole('button', { name: /^Session ledger/ }).click();
    await expect(page.getByRole('heading', { name: 'Session results', exact: true })).toBeVisible();
    await expectSummary(page, room);
    await expect(page.locator('.ledger-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('.data-table')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Ledger CSV', exact: true })).toBeHidden();
    room = await send(page.request, baseURL!, host, room.id, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    await expectSummary(page, room);
    room = await send(page.request, baseURL!, host, room.id, { type: 'fund', amount: 200 });
    await expectSummary(page, room);
    room = await send(page.request, baseURL!, host, room.id, { type: 'deal' });
    await expectSummary(page, room);
    expect(room.players.map(player => player.chipNet)).toEqual([0, 0]);
    await expect(page.getByText('Cashed out means chips already taken off the table, not chips still in play.', { exact: false })).toBeVisible();
    room = await send(guest.request, baseURL!, peer, room.id, { type: 'fund', amount: 100 });
    room = await send(page.request, baseURL!, host, room.id, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    expect(room.requests.at(-1)!.status).toBe('approved');
    expect(room.players[1]!.buyIns).toBe(1000);
    await expectSummary(page, room);
    room = await send(page.request, baseURL!, host, room.id, { type: 'act', action: 'fold' });
    expect(room.requests.at(-1)!.status).toBe('applied');
    expect(room.players[1]!.buyIns).toBe(1100);
    expect(room.players.map(player => player.chipNet)).toEqual([-50, 50]);
    await expectSummary(page, room);
    room = await send(guest.request, baseURL!, peer, room.id, { type: 'cash_out' });
    await expectSummary(page, room);
    expect(room.players[1]!.cashOuts).toBe(1150);
    const rejoined = await guest.request.post('/api/rooms/join', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': peer.csrf },
      data: { code: room.code, commandId: crypto.randomUUID() },
    });
    expect(rejoined.ok()).toBe(true);
    room = await send(guest.request, baseURL!, peer, room.id, { type: 'fund', amount: 500 });
    await expectSummary(page, room);
    room = await send(page.request, baseURL!, host, room.id, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    await expectSummary(page, room);
    expect(room.players[1]).toMatchObject({ buyIns: 1600, cashOuts: 1150, chipNet: 50, stack: 500 });
    room = await send(page.request, baseURL!, host, room.id, { type: 'close' });
    await expectSummary(page, room);
    expect(room.players.map(player => [player.buyIns, player.cashOuts, player.chipNet])).toEqual([[1200, 1150, -50], [1600, 1650, 50]]);
    await expect(page.getByText('Separate bounty obligations', { exact: true })).toHaveCount(0);
    const version = room.version;
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expectSummary(page, room);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const table = page.locator('.session-results-table');
      const bounds = (await table.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`session-results-${width}.png`), animations: 'disabled' });
    }
    await page.getByText('Detailed transfers, exports & verification', { exact: true }).click();
    await expect(page.locator('.data-table')).toBeVisible();
    await expect(page.locator('.data-table tbody tr').filter({ hasText: 'Blind' })).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Verify history', exact: true }).click();
    await expect(page.getByText(/Hash chain verified:/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ledger CSV', exact: true })).toHaveAttribute('href', `/api/rooms/${room.id}/export.csv`);
    expect((await read(page.request, room.id)).version).toBe(version);
    await page.reload();
    await page.getByRole('button', { name: 'View final ledger', exact: true }).click();
    await expectSummary(page, room);
    await expect(page.locator('.data-table')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('detailed pagination and load errors never replace the authoritative session totals', async ({ page, baseURL }) => {
  const host = await signIn(page.request, baseURL!, 'Paging host');
  const room = await create(page, baseURL!, host);
  const entry: LedgerRow = {
    id: 200, at: new Date().toISOString(), transactionId: crypto.randomUUID(), kind: 'buy_in',
    from: 'bank', to: `player:${host.id}`, chips: 1, cashCents: 1, playerId: host.id, handId: null, note: 'Newest fixture entry',
  };
  let reject = false;
  let requests = 0;
  await page.route(`**/api/rooms/${room.id}/ledger*`, async route => {
    requests++;
    if (reject) return route.fulfill({ status: 503, json: { error: 'Detailed records temporarily unavailable.' } });
    const older = new URL(route.request().url()).searchParams.has('before');
    await route.fulfill({ json: { entries: older ? [{ ...entry, id: 100, note: 'Older fixture entry' }] : [entry], nextCursor: older ? null : 200 } });
  });
  await page.goto(`/?table=${room.id}`);
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  await page.getByRole('button', { name: /^Session ledger/ }).click();
  await expectSummary(page, room);
  expect(requests).toBe(0);
  await page.getByText('Detailed transfers, exports & verification', { exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Older entries', exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
  await expectSummary(page, room);
  reject = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Detailed records temporarily unavailable.');
  await expectSummary(page, room);
  reject = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await expectSummary(page, room);
});
