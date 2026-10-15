import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, defaultHandRules, type Command, type GameVariant, type Identity, type RoomView } from '../../src/shared/model';

interface Client { page: Page; user: Identity }
async function post<T>(page: Page, origin: string, path: string, body: object, user?: Identity): Promise<T> {
  const response = await page.request.post(`${origin}/api${path}`, {
    headers: { Origin: origin, ...(user ? { 'X-CSRF-Token': user.csrf } : {}) }, data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function setup(page: Page, browser: Browser, origin: string, count = 2, game: GameVariant = 'holdem') {
  const contexts: BrowserContext[] = [];
  const clients: Client[] = [];
  const errors: string[] = [];
  for (let i = 0; i < count; i++) {
    let clientPage = page;
    if (i > 0) {
      const context = await browser.newContext({ baseURL: origin });
      contexts.push(context); clientPage = await context.newPage();
    }
    clientPage.on('pageerror', error => errors.push(error.message));
    const { user } = await post<{ user: Identity }>(clientPage, origin, '/auth/guest', { name: i ? `Guest ${i}` : 'Host' });
    clients.push({ page: clientPage, user });
  }
  const host = clients[0]!;
  const { room } = await post<{ room: RoomView }>(page, origin, '/rooms', {
    name: 'Premoves and reveals', settings: { ...DEFAULT_SETTINGS, maxSeats: count, autoDeal: false, turnSeconds: 120 },
    buyIn: 1000, commandId: crypto.randomUUID(),
  }, host.user);
  const current = async (client = host): Promise<RoomView> => {
    const response = await client.page.request.get(`${origin}/api/rooms/${room.id}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).room;
  };
  const command = async (client: Client, command: Command): Promise<RoomView> => {
    const before = await current(client);
    return (await post<{ room: RoomView }>(client.page, origin, `/rooms/${room.id}/commands`, {
      command, expectedVersion: before.version, commandId: crypto.randomUUID(),
    }, client.user)).room;
  };
  for (const client of clients.slice(1)) {
    await post(client.page, origin, '/rooms/join', { code: room.code, commandId: crypto.randomUUID() }, client.user);
    const pending = await command(client, { type: 'fund', amount: 1000 });
    await command(host, { type: 'approve', requestId: pending.requests.at(-1)!.id, approve: true });
  }
  await command(host, { type: 'next_hand', rules: { ...defaultHandRules(), game, bombAnte: 20, omahaAnte: 20 } });
  for (const client of clients) {
    await client.page.goto(`${origin}/?table=${room.id}`);
    await expect(client.page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
  }
  return { room, host, clients, current, command, errors,
    close: async () => { for (const context of contexts) await context.close(); } };
}

test('premoves cancel an invalid check, fold to a bet, and check for free exactly once', async ({ page, browser, baseURL }) => {
  const fixture = await setup(page, browser, baseURL!, 3);
  const { host, clients, current, command, errors } = fixture;
  const smallBlind = clients[1]!;
  const bigBlind = clients[2]!;
  try {
    await command(host, { type: 'deal' });
    const check = bigBlind.page.getByRole('checkbox', { name: 'Check', exact: true });
    const before = await current(bigBlind);
    await check.check();
    expect((await current(bigBlind)).version).toBe(before.version);
    await command(host, { type: 'act', action: 'raise', amount: 300 });
    await expect(check).not.toBeChecked();
    await expect(check).toBeDisabled();
    expect((await current()).hand!.actorId).toBe(smallBlind.user.id);
    await command(smallBlind, { type: 'act', action: 'call' });
    await expect(bigBlind.page.getByRole('button', { name: 'Call 200', exact: true })).toBeEnabled();
    await bigBlind.page.getByRole('button', { name: 'Call 200', exact: true }).click();
    await expect(host.page.locator('.street-label')).toHaveText('FLOP');
    await host.page.getByRole('checkbox', { name: 'Check/Fold', exact: true }).check();
    await command(smallBlind, { type: 'act', action: 'raise', amount: 100 });
    await command(bigBlind, { type: 'act', action: 'call' });
    await expect.poll(async () => (await current()).players.find(player => player.id === host.user.id)!.hand!.folded).toBe(true);
    await expect(bigBlind.page.locator('.street-label')).toHaveText('TURN');
    await bigBlind.page.getByRole('checkbox', { name: 'Check/Fold', exact: true }).check();
    await command(smallBlind, { type: 'act', action: 'check' });
    await expect(bigBlind.page.locator('.street-label')).toHaveText('RIVER');
    await expect(bigBlind.page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).not.toBeChecked();
    await command(smallBlind, { type: 'act', action: 'check' });
    await expect(bigBlind.page.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    expect((await current()).hand!.actorId).toBe(bigBlind.user.id);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('premoves clear when unchecked, paused, refreshed, or disconnected instead of firing after reconnect', async ({ page, browser, baseURL }) => {
  const fixture = await setup(page, browser, baseURL!);
  const { host, clients, command, current, errors } = fixture;
  const guest = clients[1]!;
  try {
    await command(host, { type: 'deal' });
    const guestPremove = guest.page.getByRole('checkbox', { name: 'Check/Fold', exact: true });
    await guestPremove.check();
    await guestPremove.uncheck();
    await command(host, { type: 'act', action: 'call' });
    await expect(guest.page.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    await guest.page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.street-label')).toHaveText('FLOP');
    await page.getByRole('checkbox', { name: 'Check', exact: true }).check();
    await command(host, { type: 'pause', value: true });
    await expect(page.getByRole('group', { name: 'Premoves for this street' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Check', exact: true })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).toBeDisabled();
    await command(host, { type: 'pause', value: false });
    await expect(page.getByRole('checkbox', { name: 'Check', exact: true })).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Check/Fold', exact: true }).check();
    await page.reload();
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Check/Fold', exact: true }).check();
    await page.context().setOffline(true);
    await expect(page.locator('.connection-banner')).toBeVisible();
    await command(guest, { type: 'act', action: 'check' });
    await page.context().setOffline(false);
    await expect(page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    expect((await current()).hand!.actorId).toBe(host.user.id);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.street-label')).toHaveText('TURN');
    await expect(page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally { await page.context().setOffline(false); await fixture.close(); }
});

test('premove transport retries reuse one command key, while version conflicts clear the intention and require a manual action', async ({ page, browser, baseURL }) => {
  const fixture = await setup(page, browser, baseURL!);
  const { host, clients, room, current, command, errors } = fixture;
  const guest = clients[1]!;
  const path = `**/api/rooms/${room.id}/commands`;
  const requests: Array<{ commandId: string; expectedVersion: number; command: Command }> = [];
  try {
    await command(host, { type: 'deal' });
    await guest.page.route(path, async route => {
      const body = route.request().postDataJSON() as typeof requests[number];
      if (body.command.type !== 'act') { await route.continue(); return; }
      requests.push(body);
      if (requests.length === 1) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await guest.page.getByRole('checkbox', { name: 'Check', exact: true }).check();
    await command(host, { type: 'act', action: 'call' });
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[0]).toEqual(requests[1]);
    await expect(guest.page.locator('.street-label')).toHaveText('FLOP');
    expect((await current()).events.filter(event => event.actorId === guest.user.id && event.kind === 'action')).toHaveLength(1);
    await guest.page.unroute(path);

    let conflict = false;
    await page.route(path, async route => {
      const body = route.request().postDataJSON() as { command: Command };
      if (!conflict && body.command.type === 'act') {
        conflict = true;
        await command(guest, { type: 'chat', message: 'A newer snapshot won the race.' });
      }
      await route.continue();
    });
    await page.getByRole('checkbox', { name: 'Check/Fold', exact: true }).check();
    await command(guest, { type: 'act', action: 'check' });
    await expect(page.getByRole('alert')).toContainText('The table changed');
    expect((await current()).hand!.actorId).toBe(host.user.id);
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.street-label')).toHaveText('TURN');
    await expect(page.getByRole('checkbox', { name: 'Check/Fold', exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

async function expectSingleSuits(page: Page) {
  const faces = page.locator('.card-face');
  expect(await faces.count()).toBeGreaterThan(0);
  const results = await faces.evaluateAll(cards => cards.map(card => {
    const suits = card.querySelectorAll<HTMLElement>('.card-suit');
    const rank = card.querySelector<HTMLElement>('.card-corner strong')!;
    return {
      symbols: card.textContent?.match(/[\u2660\u2665\u2666\u2663]/g)?.length,
      count: suits.length, visible: getComputedStyle(suits[0]!).display !== 'none',
      larger: parseFloat(getComputedStyle(suits[0]!).fontSize) > parseFloat(getComputedStyle(rank).fontSize),
      matchingColors: getComputedStyle(rank).color === getComputedStyle(suits[0]!).color,
      rankSpacing: getComputedStyle(rank).marginBottom,
    };
  }));
  expect(results.every(result => result.symbols === 1 && result.count === 1 && result.visible && result.larger &&
    result.matchingColors && result.rankSpacing === '0px')).toBe(true);
  await expect(page.locator('.card-corner span')).toHaveCount(0);
}

test('folded players and winners reveal selected cards live and in history, with one large suit on desktop and phone', async ({ page, browser, baseURL }, testInfo) => {
  const fixture = await setup(page, browser, baseURL!);
  const { host, clients, current, command, room, errors } = fixture;
  const guest = clients[1]!;
  try {
    await command(host, { type: 'deal' });
    const ownCards = (await current()).players.find(player => player.id === host.user.id)!.cards;
    const guestCards = (await current(guest)).players.find(player => player.id === guest.user.id)!.cards;
    await command(host, { type: 'act', action: 'call' });
    await command(guest, { type: 'act', action: 'check' });
    await command(guest, { type: 'act', action: 'check' });
    await command(host, { type: 'act', action: 'fold' });
    const controls = page.getByRole('region', { name: 'Reveal your cards' });
    await controls.getByRole('button', { name: /^Reveal card 2:/ }).click();
    await expect.poll(async () => (await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual([null, ownCards[1]]);
    const seenHand = guest.page.getByRole('group', { name: "Host's cards", exact: true });
    await expect(seenHand.locator('.card-face')).toHaveCount(1);
    await expect(seenHand.locator('.card-back')).toHaveCount(1);
    await expect(guest.page.locator('.seat-folded.seat-showing')).toHaveCSS('opacity', '1');
    expect((await current()).players.find(player => player.id === host.user.id)!.cards).toEqual(ownCards);
    await guest.page.getByRole('region', { name: 'Reveal your cards' }).getByRole('button', { name: /^Reveal card 1:/ }).click();
    await expect.poll(async () => (await current()).players.find(player => player.id === guest.user.id)!.cards).toEqual([guestCards[0], null]);
    await guest.page.reload();
    await expect(guest.page.locator('.game-nav-center')).toHaveText('LIVE TABLE');
    await expect(seenHand.locator('.card-back')).toHaveCount(1);
    await expectSingleSuits(page);
    await expect(controls.getByRole('button', { name: /^Card 2 already shown:/ })).toBeDisabled();
    await expect(controls.locator('.playing-card')).toHaveCount(0);
    await expect(page.locator('.hero-seat .seat-cards')).toHaveCSS('opacity', '1');
    await expect(page.locator('.table-motion-layer')).toHaveCount(0);
    await page.locator('.table-stage').screenshot({ path: testInfo.outputPath('single-suits-desktop.png') });
    await controls.screenshot({ path: testInfo.outputPath('reveal-controls-desktop.png') });
    await page.setViewportSize({ width: 360, height: 800 });
    await expectSingleSuits(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.table-stage').screenshot({ path: testInfo.outputPath('single-suits-phone.png') });
    await controls.getByRole('button', { name: 'Reveal all', exact: true }).click();
    await expect.poll(async () => (await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual(ownCards);
    await expect(controls.getByRole('button', { name: 'Reveal all', exact: true })).toBeDisabled();
    for (const button of await controls.locator('.reveal-card-button').all()) {
      await expect(button).toBeDisabled();
    }
    await expectSingleSuits(page);
    await controls.screenshot({ path: testInfo.outputPath('reveal-controls-phone.png') });
    await page.getByRole('button', { name: /Hand history/ }).click();
    const history = page.getByRole('dialog', { name: 'The hands that happened.' });
    await expect(history.locator('.showdown-row').filter({ hasText: 'Host' }).locator('.card-face')).toHaveCount(2);
    await expect(history.locator('.showdown-row').filter({ hasText: 'Guest 1' }).locator('.card-face')).toHaveCount(1);
    await expectSingleSuits(page);
    const saved = await guest.page.request.get(`/api/rooms/${room.id}/hands`);
    expect((await saved.json()).entries[0].revealed).toEqual({ [host.user.id]: ownCards, [guest.user.id]: [guestCards[0]] });
    await history.getByRole('button', { name: 'Close dialog' }).click();
    await command(host, { type: 'deal' });
    await expect(controls).toBeVisible();
    for (const button of await controls.getByRole('button').all()) await expect(button).toBeDisabled();
    expect((await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual([null, null]);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 360, height: 800 }]) {
  test(`${viewport.name} keeps premoves mounted and reveals beside the player without shifting controls on turn changes`, async ({ page, browser, baseURL }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await setup(page, browser, baseURL!);
    const { host, clients, command, errors } = fixture;
    const guest = clients[1]!;
    const controls = page.getByRole('region', { name: 'Reveal your cards' });
    const premoves = page.getByRole('group', { name: 'Premoves for this street' });
    const positions = () => page.evaluate(() => {
      const bounds = (selector: string) => {
        const rectangle = document.querySelector(selector)!.getBoundingClientRect();
        return { x: rectangle.x + scrollX, y: rectangle.y + scrollY, width: rectangle.width, height: rectangle.height };
      };
      return {
        reveal: bounds('.reveal-controls'), premoves: bounds('.premove-controls'),
        hero: bounds('.hero-seat'), table: bounds('.table-stage'), console: bounds('.action-console'),
        actions: document.querySelector('.action-buttons') ? bounds('.action-buttons') : null,
      };
    });
    try {
      await expect(premoves).toBeVisible();
      await expect(controls).toBeVisible();
      await expect(page.getByRole('region', { name: 'Poker table' }).getByRole('region', { name: 'Reveal your cards' })).toBeVisible();
      await expect(page.locator('.action-console .reveal-controls')).toHaveCount(0);
      for (const button of await controls.getByRole('button').all()) await expect(button).toBeDisabled();
      for (const checkbox of await premoves.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
      const revealNode = await controls.elementHandle();
      const premoveNode = await premoves.elementHandle();
      const initial = await positions();
      await command(host, { type: 'deal' });
      await expect(page.getByRole('button', { name: 'Fold', exact: true })).toBeEnabled();
      await expect(premoves.getByRole('checkbox', { name: 'Check/Fold', exact: true })).toBeDisabled();
      const acting = await positions();
      expect(acting.reveal).toEqual(initial.reveal);
      await command(host, { type: 'act', action: 'call' });
      await expect(premoves.getByRole('checkbox', { name: 'Check/Fold', exact: true })).toBeEnabled();
      const waiting = await positions();
      expect(waiting.reveal).toEqual(acting.reveal);
      expect(waiting.premoves).toEqual(acting.premoves);
      expect(waiting.actions).toEqual(acting.actions);
      expect(waiting.console).toEqual(acting.console);
      await command(guest, { type: 'act', action: 'fold' });
      await expect(controls.getByRole('button', { name: 'Reveal all', exact: true })).toBeEnabled();
      for (const checkbox of await premoves.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
      const complete = await positions();
      expect(complete.reveal).toEqual(initial.reveal);
      expect(complete.premoves.height).toBe(initial.premoves.height);
      expect(complete.reveal.y).toBeGreaterThanOrEqual(complete.hero.y + complete.hero.height + 3);
      expect(complete.reveal.y - complete.hero.y - complete.hero.height).toBeLessThan(45);
      expect(complete.reveal.y + complete.reveal.height + 3).toBeLessThanOrEqual(complete.console.y);
      expect(Math.abs(complete.reveal.x + complete.reveal.width / 2 - complete.hero.x - complete.hero.width / 2)).toBeLessThan(1);
      expect(await revealNode!.evaluate(element => element.isConnected)).toBe(true);
      expect(await premoveNode!.evaluate(element => element.isConnected)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.table-column').screenshot({ path: testInfo.outputPath(`persistent-controls-${viewport.name}.png`), animations: 'disabled' });
      expect(errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

for (const game of ['omaha', 'omaha_bomb'] as const) {
  test(`${game} supports each of four post-hand cards and Reveal all without exposing unselected cards`, async ({ page, browser, baseURL }) => {
    const fixture = await setup(page, browser, baseURL!, 2, game);
    const { host, clients, current, command, errors } = fixture;
    const guest = clients[1]!;
    try {
      const dealt = await command(host, { type: 'deal' });
      const ownCards = dealt.players.find(player => player.id === host.user.id)!.cards;
      expect(ownCards).toHaveLength(4);
      await command(dealt.hand!.actorId === host.user.id ? host : guest, { type: 'act', action: 'fold' });
      const controls = page.getByRole('region', { name: 'Reveal your cards' });
      await expect(controls.getByRole('button', { name: /^Reveal card / })).toHaveCount(4);
      await controls.getByRole('button', { name: /^Reveal card 4:/ }).click();
      await expect.poll(async () => (await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual([null, null, null, ownCards[3]]);
      await controls.getByRole('button', { name: /^Reveal card 2:/ }).click();
      await expect.poll(async () => (await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual([null, ownCards[1], null, ownCards[3]]);
      expect((await current(guest)).hand!.revealed[host.user.id]).toEqual([ownCards[1], ownCards[3]]);
      await page.setViewportSize({ width: 320, height: 800 });
      await expectSingleSuits(page);
      expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await controls.getByRole('button', { name: 'Reveal all', exact: true }).click();
      await expect.poll(async () => (await current(guest)).players.find(player => player.id === host.user.id)!.cards).toEqual(ownCards);
      await expect(controls.getByRole('button', { name: 'Reveal all', exact: true })).toBeDisabled();
      expect(errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}
