// Controller-owned, page-scoped debugger session registry.
// The provider supplies attach/send/events/detach; the IPC and lifetime contract
// below is identical for Playwright and Electron. No debugger TCP port is opened.
const MAX_EVENTS = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 30000;

function validation(condition, code, message) {
  if (!condition) throw new Error(code + ': ' + message);
}

export class DebugSessions {
  constructor() {
    this.nextId = 1;
    this.byId = new Map();
    this.byPage = new Map();
  }

  _require(id) {
    const item = this.byId.get(id);
    validation(item, 'debug.session-not-found', 'unknown or closed debugger session');
    return item;
  }

  async open(page, attach) {
    validation(typeof page === 'string' && page,
      'debug.invalid-page', 'page identity is required');
    validation(!this.byPage.has(page),
      'debug.page-already-attached', 'only one managed debugger session per page');
    // Mark the page before the asynchronous provider attach so concurrent
    // clients cannot create two sessions against the same Electron webContents.
    this.byPage.set(page, null);
    let transport;
    try {
      transport = await attach();
      const id = 'debug-' + this.nextId++;
      const item = { id, page, transport, sequence: 0, events: [], bytes: 0,
        waiters: new Set(), closed: false };
      this.byId.set(id, item);
      this.byPage.set(page, id);
      transport.onEvent((method, params) => this._record(item, method, params));
      transport.onClose(() => this._remove(item));
      return { session: id, page };
    } catch (error) {
      this.byPage.delete(page);
      if (transport) await transport.close().catch(() => {});
      throw error;
    }
  }

  _wake(item) {
    for (const wake of item.waiters) wake();
    item.waiters.clear();
  }

  _remove(item) {
    if (item.closed) return;
    item.closed = true;
    this.byId.delete(item.id);
    if (this.byPage.get(item.page) === item.id) this.byPage.delete(item.page);
    this._wake(item);
  }

  _record(item, method, params) {
    if (item.closed || typeof method !== 'string') return;
    const next = ++item.sequence;
    const value = { sequence: next, method, params: params ?? {} };
    const length = Buffer.byteLength(JSON.stringify(value));
    if (length > MAX_EVENT_BYTES) {
      // Do not emit an unbounded payload through a local control IPC response.
      // The skipped sequence makes the loss observable through overflow checks.
      item.events = [];
      item.bytes = 0;
      this._wake(item);
      return;
    }
    item.events.push({ value, length });
    item.bytes += length;
    while (item.events.length > MAX_EVENTS || item.bytes > MAX_BYTES) {
      item.bytes -= item.events.shift().length;
    }
    this._wake(item);
  }

  async send(id, method, params = {}) {
    const item = this._require(id);
    validation(typeof method === 'string' && method.length > 0,
      'debug.invalid-method', 'protocol method is required');
    validation(params !== null && typeof params === 'object' && !Array.isArray(params),
      'debug.invalid-params', 'protocol params must be a JSON object');
    return item.transport.send(method, params);
  }

  _read(id, after, limit) {
    const item = this._require(id);
    const oldest = item.events.length
      ? item.events[0].value.sequence : item.sequence + 1;
    validation(after >= oldest - 1,
      'debug.events-overflow', 'events were discarded; reopen or resynchronize the session');
    return {
      session: id,
      after,
      lastSequence: item.sequence,
      events: item.events.filter(({ value }) => value.sequence > after)
        .slice(0, limit).map(({ value }) => value)
    };
  }

  async events(id, after = 0, limit = 100, waitMs = 0) {
    validation(Number.isSafeInteger(after) && after >= 0,
      'debug.invalid-after', 'after must be a nonnegative sequence');
    validation(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_EVENTS,
      'debug.invalid-limit', 'limit must be 1..128');
    validation(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= MAX_WAIT_MS,
      'debug.invalid-wait', 'waitMs must be 0..30000');
    const current = this._read(id, after, limit);
    if (current.events.length || !waitMs) return current;

    const item = this._require(id);
    await new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); item.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, waitMs);
      item.waiters.add(wake);
    });
    return this._read(id, after, limit);
  }

  async close(id) {
    const item = this._require(id);
    this._remove(item);
    await item.transport.close();
    return { session: id, closed: true };
  }

  async closePage(page) {
    const id = this.byPage.get(page);
    if (!id) {
      this.byPage.delete(page);
      return;
    }
    const item = this.byId.get(id);
    if (!item) return;
    this._remove(item);
    await item.transport.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.byId.values()].map((item) => this.closePage(item.page)));
  }

  isManaged(page) {
    return typeof this.byPage.get(page) === 'string';
  }
}
