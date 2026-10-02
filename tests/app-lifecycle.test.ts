import { expect, test, vi } from 'vitest';
import { makeApp } from '../src/server/app';
import { openDatabase } from '../src/server/database';
import { Store } from '../src/server/store';

test('application shutdown waits for an active scheduler query before the database can close', async () => {
  const db = await openDatabase({ directory: ':memory:' });
  const store = new Store(db);
  let entered!: () => void;
  let release!: () => void;
  let finished!: () => void;
  const tickEntered = new Promise<void>(resolve => { entered = resolve; });
  const releaseTick = new Promise<void>(resolve => { release = resolve; });
  const tickFinished = new Promise<void>(resolve => { finished = resolve; });
  const query = vi.spyOn(store, 'openRooms').mockImplementation(async () => {
    entered();
    await releaseTick;
    try { await db.query('SELECT 1'); }
    finally { finished(); }
    return [];
  });
  const errors = vi.spyOn(console, 'error');
  const server = await makeApp(store, { origin: 'http://localhost', production: false, trustProxy: false, scheduler: true });
  try {
    await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve));
    await tickEntered;
    let closed = false;
    const shutdown = server.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(closed).toBe(false);
    release();
    await shutdown;
    expect(closed).toBe(true);
    await server.close();
    await db.close();
    expect(query).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    release();
    await tickFinished;
    await server.close();
    await db.close();
    query.mockRestore(); errors.mockRestore();
  }
});
