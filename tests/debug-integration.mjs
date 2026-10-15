import assert from 'node:assert/strict';

export async function checkPersistentDebug(cli, page, baseUrl) {
  const opened = await cli('debug', 'session', 'open', page);
  const id = opened.session;
  assert.match(id, /^debug-[0-9]+$/);
  assert.equal(opened.page, page);

  try {
    await assert.rejects(
      () => cli('debug', 'session', 'open', page),
      /debug.page-already-attached/
    );

    const enabled = await cli('debug', 'session', 'send', id, 'Runtime.enable');
    assert.equal(enabled.session, id);
    await cli('debug', 'session', 'send', id, 'Network.enable');
    await cli('debug', 'session', 'send', id, 'Debugger.enable');

    // The session must persist over real navigation (not one-shot debug.cdp).
    await cli('page', 'navigate', page, baseUrl + '/debug-trigger');
    let after = 0;
    let sawNetwork = false;
    for (let i = 0; i < 20 && !sawNetwork; i++) {
      const result = await cli('debug', 'session', 'events',
        id, String(after), '100', '250');
      sawNetwork = result.events.some(x =>
        x.method === 'Network.requestWillBeSent' &&
        x.params.request?.url?.includes('/debug-trigger'));
      after = result.events.at(-1)?.sequence ?? after;
    }
    assert.ok(sawNetwork, 'network events arrive through persistent debugger session');

    // A timer runs in the fixture, giving Debugger.pause a JS stack to suspend.
    await cli('debug', 'session', 'send', id, 'Debugger.pause');
    let stopped;
    for (let i = 0; i < 40 && !stopped; i++) {
      const result = await cli('debug', 'session', 'events',
        id, String(after), '100', '250');
      stopped = result.events.find(x => x.method === 'Debugger.paused');
      after = result.events.at(-1)?.sequence ?? after;
    }
    assert.ok(stopped, 'Debugger.paused event observed');
    const frameId = stopped.params.callFrames?.[0]?.callFrameId;
    assert.ok(frameId, 'paused event includes callFrameId');
    const result = await cli('debug', 'session', 'send', id,
      'Debugger.evaluateOnCallFrame',
      JSON.stringify({ callFrameId: frameId, expression: '2 + 3', returnByValue: true }));
    assert.equal(result.result?.result?.value, 5);
    await cli('debug', 'session', 'send', id, 'Debugger.resume');

    await cli('page', 'navigate', page, baseUrl);
    // Electron native input must share the already attached debugger safely.
    await cli('page', 'press', page, '#name', 'Enter');
    const inspected = await cli('page', 'inspect', page, 'text');
    assert.match(inspected.text, /web-control fixture/);
  } finally {
    await cli('debug', 'session', 'send', id, 'Debugger.resume').catch(() => {});
    await cli('debug', 'session', 'close', id);
  }
  await assert.rejects(
    () => cli('debug', 'session', 'events', id),
    /debug.session-not-found/
  );
}
