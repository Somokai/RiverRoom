process.on('message', message => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === 'test:interrupt') process.emit('SIGINT');
  if (message.type === 'test:fatal') setImmediate(() => { throw new Error('Injected local runtime failure'); });
});

await import('../../src/server/index.js');
export {};
