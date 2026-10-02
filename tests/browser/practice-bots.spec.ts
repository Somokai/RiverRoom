import { expect, test, type Page } from '@playwright/test';
import type { RoomView } from '../../src/shared/model';

async function getRoom(page: Page, id: string): Promise<RoomView> {
  const response = await page.request.get(`/api/rooms/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { room: RoomView }).room;
}

async function createPractice(page: Page, seats: number) {
  const errors: string[] = [];
  const botResponses: number[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (!response.url().endsWith('/commands') || response.request().method() !== 'POST') return;
    const body = response.request().postDataJSON() as { command?: { type?: string } };
    if (body.command?.type === 'add_bot') botResponses.push(response.status());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a table', exact: true }).click();
  await page.getByLabel('Your player name').fill('Bot tester');
  await page.getByLabel('Small blind', { exact: true }).fill('5');
  await page.getByLabel('Big blind', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Show house rules' }).click();
  await page.getByLabel('Minimum buy-in', { exact: true }).fill('100');
  await page.getByLabel('Maximum funded stack', { exact: true }).fill('2000');
  await page.getByLabel('Your starting chips', { exact: true }).fill('1000');
  await page.getByLabel('Seats', { exact: true }).fill(String(seats));
  await page.getByLabel('Turn clock (seconds)').fill('120');
  await page.getByLabel('Automatically deal the next hand').uncheck();
  const botCount = Math.min(3, seats - 1);
  await page.getByRole('button', { name: `Or practice with ${botCount} ${botCount === 1 ? 'bot' : 'bots'}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep your seat. Save this key.' })).toBeVisible();
  await page.getByRole('button', { name: 'I have saved my key' }).click();
  await expect(page.locator('.player-row')).toHaveCount(botCount + 1);
  await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  const id = new URL(page.url()).searchParams.get('table')!;
  return { room: await getRoom(page, id), botResponses, errors };
}

for (const seats of [2, 3]) {
  test(`${seats}-seat practice creation fits the table and the host can explicitly refill virtual chips`, async ({ page }) => {
    const { room, botResponses, errors } = await createPractice(page, seats);
    expect(room.players.filter(player => player.bot)).toHaveLength(seats - 1);
    expect(room.players.filter(player => player.seat !== null)).toHaveLength(seats);
    const bot = room.players.find(player => player.bot)!;
    await expect(page.getByRole('button', { name: 'Add practice bot', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Refill ${bot.name} with virtual chips`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Refill virtual practice chips.' })).toBeVisible();
    await expect(page.getByText('Host-only, between hands.', { exact: false })).toBeVisible();
    await page.getByLabel('Virtual chips to add').fill('1001');
    await expect(page.getByRole('button', { name: 'Confirm virtual refill' })).toBeDisabled();
    await page.getByLabel('Virtual chips to add').fill('100');
    await page.getByRole('button', { name: 'Confirm virtual refill' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await getRoom(page, room.id)).players.find(player => player.id === bot.id)?.stack).toBe(1100);
    const after = await getRoom(page, room.id);
    expect(after.players.find(player => player.id === bot.id)).toMatchObject({ buyIns: 1100, rebuyCount: 0, addOnCount: 1 });
    expect(after.players.find(player => player.id === after.youId)).toMatchObject({ stack: 1000, buyIns: 1000, addOnCount: 0 });
    await page.getByRole('button', { name: /Session ledger/ }).click();
    await expect(page.locator('.data-table tbody tr').filter({ hasText: `${bot.name}: virtual practice add on` })).toHaveCount(1);
    await page.getByRole('button', { name: 'Verify history' }).click();
    await expect(page.getByText(/Hash chain verified:/)).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: `Refill ${bot.name} with virtual chips`, exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(botResponses).toEqual(Array.from({ length: seats - 1 }, () => 200));
    expect(errors).toEqual([]);
  });
}

test('sitting out lets the host observe autonomous private bot play, then refill and rejoin', async ({ page }) => {
  const { room: initial, errors } = await createPractice(page, 3);
  await page.getByRole('button', { name: 'Sit out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sit back in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deal first hand', exact: true }).click();
  const live = await getRoom(page, initial.id);
  expect(live.hand?.players).toHaveLength(2);
  expect(live.hand?.players.every(player => player.id !== live.youId)).toBe(true);
  expect(live.players.find(player => player.id === live.youId)?.cards).toEqual([]);
  expect(live.hand).not.toHaveProperty('deck');
  expect(live.hand).not.toHaveProperty('holeCards');
  expect(live.hand).not.toHaveProperty('burned');
  for (const bot of live.players.filter(player => player.bot)) {
    expect(bot.cards).toEqual([null, null]);
    await expect(page.getByRole('button', { name: `Refill ${bot.name} with virtual chips`, exact: true })).toBeDisabled();
  }
  await expect.poll(async () => (await getRoom(page, initial.id)).hand?.street, { timeout: 90000 }).toBe('complete');
  const completed = await getRoom(page, initial.id);
  const actions = completed.events.filter(event => event.kind === 'action');
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every(event => completed.players.some(player => player.bot && player.id === event.actorId))).toBe(true);
  expect(completed.players.find(player => player.id === completed.youId)).toMatchObject({ stack: 1000, buyIns: 1000, sittingOut: true });
  const target = completed.players.find(player => player.bot && player.stack <= completed.settings.maxBuyIn - 100)!;
  expect(target).toBeDefined();
  await page.getByRole('button', { name: `Refill ${target.name} with virtual chips`, exact: true }).click();
  await page.getByLabel('Virtual chips to add').fill('100');
  await page.getByRole('button', { name: 'Confirm virtual refill' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await getRoom(page, initial.id)).players.find(player => player.id === target.id)?.stack).toBe(target.stack + 100);
  const funded = (await getRoom(page, initial.id)).players.find(player => player.id === target.id)!;
  expect(funded.rebuyCount).toBe(target.rebuyCount + (target.stack === 0 ? 1 : 0));
  expect(funded.addOnCount).toBe(target.addOnCount + (target.stack === 0 ? 0 : 1));
  await page.getByRole('button', { name: 'Sit back in', exact: true }).click();
  await expect.poll(async () => (await getRoom(page, initial.id)).players.find(player => player.id === initial.youId)?.sittingOut).toBe(false);
  await expect(page.getByRole('button', { name: 'Deal next hand', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
