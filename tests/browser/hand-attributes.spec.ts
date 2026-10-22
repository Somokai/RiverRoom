import { expect, test } from '@playwright/test';
import { DEFAULT_SETTINGS, type Command, type Identity, type RoomView } from '../../src/shared/model';

test('independent attributes combine in a real multiplayer hand and only future deals change', async ({ page, browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL });
  const guestPage = await context.newPage();
  const pages = [page, guestPage];
  const users: Identity[] = [];
  const errors: string[] = [];
  for (const playerPage of pages) playerPage.on('pageerror', error => errors.push(error.message));
  try {
    for (const [index, playerPage] of pages.entries()) {
      const response = await playerPage.request.post('/api/auth/guest', {
        headers: { Origin: baseURL! }, data: { name: `Attribute player ${index + 1}` },
      });
      expect(response.ok()).toBe(true);
      users.push((await response.json() as { user: Identity }).user);
    }
    const created = await page.request.post('/api/rooms', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': users[0]!.csrf },
      data: {
        name: 'Composable poker', buyIn: 1000, commandId: crypto.randomUUID(),
        settings: { ...DEFAULT_SETTINGS, maxSeats: 2, autoDeal: false, turnSeconds: 120 },
      },
    });
    expect(created.ok()).toBe(true);
    let room = (await created.json() as { room: RoomView }).room;
    const read = async (index = 0) => {
      const response = await pages[index]!.request.get(`/api/rooms/${room.id}`);
      expect(response.ok()).toBe(true);
      return (await response.json() as { room: RoomView }).room;
    };
    const send = async (index: number, command: Command) => {
      room = await read(index);
      const response = await pages[index]!.request.post(`/api/rooms/${room.id}/commands`, {
        headers: { Origin: baseURL!, 'X-CSRF-Token': users[index]!.csrf },
        data: { commandId: crypto.randomUUID(), expectedVersion: room.version, command },
      });
      expect(response.ok(), await response.text()).toBe(true);
      room = (await response.json() as { room: RoomView }).room;
    };
    const joined = await guestPage.request.post('/api/rooms/join', {
      headers: { Origin: baseURL!, 'X-CSRF-Token': users[1]!.csrf },
      data: { code: room.code, commandId: crypto.randomUUID() },
    });
    expect(joined.ok()).toBe(true);
    await send(1, { type: 'fund', amount: 1000 });
    await send(0, { type: 'approve', requestId: room.requests.at(-1)!.id, approve: true });
    for (const playerPage of pages) {
      await playerPage.goto(`/?table=${room.id}`);
      await expect(playerPage.locator('.game-nav-center')).toHaveText('LIVE TABLE');
      await expect(playerPage.locator('.table-felt')).toBeEmpty();
      await expect(playerPage.locator('.community')).toHaveText('');
    }
    await expect(guestPage.getByRole('button', { name: 'Choose next hand', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    const labels = ['Omaha (four cards)', 'Pot limit', 'Double board', 'Bomb pot', 'Indian (face-out cards)'];
    for (const label of labels) await page.getByLabel(label, { exact: true }).check();
    await expect(page.getByLabel('Indian round buy-in (ante per player)')).toHaveCount(0);
    await expect(page.getByLabel('Omaha round buy-in (ante per player)')).toHaveCount(0);
    await page.getByLabel('Bomb ante (chips per player)').fill('25');
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText('Double-board Indian pot-limit Omaha bomb pot');
    await page.reload();
    await expect(page.locator('.queued-hand-rules')).toContainText('Double-board Indian pot-limit Omaha bomb pot');
    await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
    for (const playerPage of pages) {
      await expect(playerPage.locator('.table-stage')).toHaveAttribute('data-street', 'flop');
      await expect(playerPage.locator('.community .board-cards')).toHaveCount(2);
      await expect(playerPage.locator('.community .board-label')).toHaveText(['Board 1', 'Board 2']);
      await expect(playerPage.locator('.pot-display')).toHaveText('50');
      await expect(playerPage.locator('.pot-display')).toHaveAttribute('aria-label', 'Collected pot: 50 chips');
      await expect(playerPage.locator('.felt-wordmark, .felt-subtitle, .street-label, .pot-inclusive, .pot-caption')).toHaveCount(0);
      await expect(playerPage.locator('.community')).not.toContainText('Double-board Indian pot-limit Omaha bomb pot');
      await expect(playerPage.locator('.community')).not.toContainText('COLLECTED POT');
      await expect(playerPage.locator('.hero-seat .card-back')).toHaveCount(4);
      await expect(playerPage.locator('.seat:not(.hero-seat) .card-face')).toHaveCount(4);
      await expect(playerPage.locator('.blind-badge')).toHaveCount(0);
      await expect(playerPage.getByRole('button', { name: 'All in', exact: true })).toBeDisabled();
      await expect(playerPage.locator('.variant-guidance')).toContainText('Exactly 2 + 3');
    }
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.locator('.table-stage').screenshot({ path: testInfo.outputPath('clean-double-board-desktop.png') });
    await guestPage.setViewportSize({ width: 390, height: 844 });
    await expect(guestPage.locator('.community .board-label')).toHaveText(['Board 1', 'Board 2']);
    await expect(guestPage.locator('.pot-display')).toHaveText('50');
    await guestPage.locator('.table-stage').screenshot({ path: testInfo.outputPath('clean-double-board-phone.png') });
    await send(0, { type: 'pause', value: true });
    await expect(page.locator('.community').getByRole('img', { name: 'Table paused', exact: true })).toBeVisible();
    await expect(page.locator('.paused-overlay')).toHaveText('');
    await expect(page.locator('.pot-display')).toHaveText('50');
    await send(0, { type: 'pause', value: false });
    room = await read();
    const frozen = structuredClone(room.hand!.rules);
    expect(room.hand!.pot).toBe(50);
    await page.getByRole('button', { name: 'Choose next hand', exact: true }).click();
    for (const label of labels) {
      await expect(page.getByLabel(label, { exact: true })).toBeChecked();
      await page.getByLabel(label, { exact: true }).uncheck();
    }
    await page.getByRole('button', { name: 'Save next-hand rules', exact: true }).click();
    await expect(page.locator('.queued-hand-rules')).toContainText("Texas Hold'em");
    expect((await read()).hand!.rules).toEqual(frozen);
    for (let turns = 0; room.hand!.street !== 'complete'; turns++) {
      expect(turns).toBeLessThan(12);
      const index = users.findIndex(user => user.id === room.hand!.actorId);
      await pages[index]!.getByRole('button', { name: 'Check', exact: true }).click();
      const version = room.version;
      await expect.poll(async () => { room = await read(); return room.version; }).toBeGreaterThan(version);
    }
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'complete');
    await expect(page.locator('.pot-display strong')).toBeVisible();
    const winnerNames = room.players.filter(player => room.hand!.results.some(result => result.winners.includes(player.id)))
      .map(player => player.name).join(' & ');
    await expect(page.locator('.hand-outcome')).toHaveText(`${winnerNames} won`);
    await expect(page.locator('.hand-outcome')).toHaveAttribute('aria-label', /^Hand won by /);
    await page.getByRole('button', { name: /^Hand history/ }).click();
    await expect(page.locator('.hand-history')).toContainText('Double-board Indian pot-limit Omaha bomb pot');
    await expect(page.locator('.hand-history .history-boards .card-face')).toHaveCount(10);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Deal next hand', exact: true }).click();
    await expect(page.locator('.table-stage')).toHaveAttribute('data-street', 'preflop');
    await expect(page.locator('.community .board-cards')).toHaveCount(1);
    for (const playerPage of pages) {
      await expect(playerPage.locator('.community .board-label')).toHaveCount(0);
      await expect(playerPage.locator('.pot-display')).toBeVisible();
      await expect(playerPage.locator('.pot-display')).toHaveText('0');
      await expect(playerPage.locator('.pot-display')).toHaveAttribute('aria-label', 'Collected pot: 0 chips');
    }
    await expect(page.locator('.hero-seat .card-face')).toHaveCount(2);
    await expect(page.locator('.seat:not(.hero-seat) .card-back')).toHaveCount(2);
    await expect(page.locator('.blind-badge')).toHaveCount(2);
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.locator('.table-stage').screenshot({ path: testInfo.outputPath('clean-single-board-desktop.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
