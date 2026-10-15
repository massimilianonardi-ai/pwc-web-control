import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DebugSessions } from '../src/debug-sessions.mjs';

function provider() {
  let message;
  let closed;
  const sent = [];
  return {
    sent,
    transport: {
      onEvent(fn) { message = fn; },
      onClose(fn) { closed = fn; },
      async send(method, params) { sent.push({ method, params }); return { ok: true }; },
      async close() { closed(); }
    },
    emit(method, params) { message(method, params); }
  };
}

test('page-scoped session persists across requests and returns ordered events', async () => {
  const manager = new DebugSessions();
  const fake = provider();
  const { session } = await manager.open('page-1', async () => fake.transport);
  assert.equal(manager.isManaged('page-1'), true);
  await assert.rejects(() => manager.open('page-1', async () => fake.transport),
    /debug.page-already-attached/);
  assert.deepEqual((await manager.send(session, 'Debugger.enable')).ok, true);
  const pending = manager.events(session, 0, 10, 1000);
  fake.emit('Debugger.paused', { callFrames: [{ callFrameId: 'frame-1' }] });
  const observed = await pending;
  assert.equal(observed.events[0].method, 'Debugger.paused');
  assert.equal(observed.events[0].sequence, 1);
  assert.equal(observed.events[0].params.callFrames[0].callFrameId, 'frame-1');
  assert.equal((await manager.events(session, 1)).events.length, 0);
  assert.deepEqual(await manager.close(session), { session, closed: true });
  assert.equal(manager.isManaged('page-1'), false);
  await assert.rejects(() => manager.send(session, 'Debugger.resume'), /debug.session-not-found/);
});

test('overflow and oversized events never silently lose debugger evidence', async () => {
  const manager = new DebugSessions();
  const fake = provider();
  const { session } = await manager.open('page-2', async () => fake.transport);
  for (let i = 0; i < 132; i++) fake.emit('Runtime.consoleAPICalled', { index: i });
  await assert.rejects(() => manager.events(session, 0), /debug.events-overflow/);
  const fresh = await manager.events(session, 4, 128);
  assert.equal(fresh.events.length, 128);
  fake.emit('Network.loadingFinished', { huge: 'x'.repeat(1024 * 1024 + 1) });
  await assert.rejects(() => manager.events(session, fresh.lastSequence),
    /debug.events-overflow/);
  await manager.close(session);
});

test('page teardown makes old session identities unusable', async () => {
  const manager = new DebugSessions();
  const fake = provider();
  const { session } = await manager.open('page-1', async () => fake.transport);
  await manager.closePage('page-1');
  await assert.rejects(() => manager.events(session, 0), /debug.session-not-found/);
  const second = provider();
  const fresh = await manager.open('page-1', async () => second.transport);
  assert.notEqual(fresh.session, session);
  await manager.closeAll();
});

test('invalid operands fail with distinguishable identities', async () => {
  const manager = new DebugSessions();
  const fake = provider();
  const { session } = await manager.open('page-1', async () => fake.transport);
  await assert.rejects(() => manager.send(session, '', {}), /debug.invalid-method/);
  await assert.rejects(() => manager.send(session, 'Network.enable', []), /debug.invalid-params/);
  await assert.rejects(() => manager.events(session, -1), /debug.invalid-after/);
  await assert.rejects(() => manager.events(session, 0, 0), /debug.invalid-limit/);
  await assert.rejects(() => manager.events(session, 0, 1, 30001), /debug.invalid-wait/);
  await manager.close(session);
});
