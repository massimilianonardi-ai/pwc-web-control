import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { webControlHome, webControlSocketPath, webControlIgnoreHTTPSErrors } from './runtime.mjs';
import { DebugSessions } from './debug-sessions.mjs';

const HOME = webControlHome();
const PROFILE = process.env.WEB_CONTROL_PROFILE || 'default';
const SOCKET = webControlSocketPath();
const PROFILE_DIR = process.env.WEB_CONTROL_PROFILE_DIR || path.join(HOME, 'profiles', PROFILE);
const STORAGE_DIR = path.join(HOME, 'storage-state');
const STORAGE_FILE = path.join(STORAGE_DIR, `${PROFILE}.json`);
const HEADLESS = process.env.WEB_CONTROL_HEADLESS === '1';
const IGNORE_HTTPS_ERRORS = webControlIgnoreHTTPSErrors();
const EXECUTABLE = process.env.WEB_CONTROL_BROWSER_EXECUTABLE || undefined;
const BROWSER_ARGS = process.env.WEB_CONTROL_BROWSER_ARGS ? JSON.parse(process.env.WEB_CONTROL_BROWSER_ARGS) : [];

if (!/^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/.test(PROFILE)) {
  throw new Error(`invalid profile identity: ${PROFILE}`);
}

await fs.mkdir(PROFILE_DIR, { recursive: true });
await fs.mkdir(STORAGE_DIR, { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(SOCKET), { recursive: true });

async function loadStorageState() {
  try {
    const state = JSON.parse(await fs.readFile(STORAGE_FILE, 'utf8'));
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('invalid storage-state shape');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`cannot load profile storage state: ${error.message}`);
  }
}

async function writeStorageState(state) {
  const temporary = `${STORAGE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, STORAGE_FILE);
}

let savedStorageState = await loadStorageState();

const debugSessions = new DebugSessions();
let nextPageId = 1;
const pages = new Map();
const pageIds = new WeakMap();
let context = null;
let browserStart = null;

function registerPage(page) {
  let id = pageIds.get(page);
  if (id) return id;
  id = `page-${nextPageId++}`;
  pages.set(id, page);
  pageIds.set(page, id);
  page.once('close', () => { pages.delete(id); void debugSessions.closePage(id); });
  return id;
}

async function launchBrowser() {
  if (IGNORE_HTTPS_ERRORS) {
    process.stderr.write('[warn] web-control: ignoreHTTPSErrors enabled (explicit opt-in); HTTPS certificate verification disabled for this context.\n');
  }
  const launchedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    executablePath: EXECUTABLE,
    chromiumSandbox: true,
    ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    args: BROWSER_ARGS
  });

  context = launchedContext;
  launchedContext.once('close', () => {
    if (context === launchedContext) {
      context = null;
      pages.clear();
      void debugSessions.closeAll();
    }
  });

  if (savedStorageState) {
    if (savedStorageState.cookies.length) {
      await launchedContext.addCookies(savedStorageState.cookies);
    }

    if (savedStorageState.origins.length) {
      await launchedContext.addInitScript(({ origins }) => {
        const current = origins.find(item => item.origin === location.origin);
        if (!current) return;
        for (const entry of current.localStorage || []) {
          localStorage.setItem(entry.name, entry.value);
        }
      }, { origins: savedStorageState.origins });
    }

    savedStorageState = null;
  }

  for (const page of launchedContext.pages()) registerPage(page);
  launchedContext.on('page', registerPage);
  return launchedContext;
}

async function ensureBrowser() {
  if (context) return context;

  if (!browserStart) {
    browserStart = launchBrowser().finally(() => {
      browserStart = null;
    });
  }

  return browserStart;
}

await ensureBrowser();

function requirePage(id) {
  const page = pages.get(id);
  if (!page) throw new Error(`unknown page: ${id}`);
  return page;
}

async function describePage(id, page) {
  return {
    id,
    url: page.url(),
    title: await page.title().catch(() => '')
  };
}

async function inspectStorage(page) {
  const cookies = await page.context().cookies();
  const storage = await page.evaluate(() => {
    const local = {};
    const session = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      local[key] = localStorage.getItem(key);
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      session[key] = sessionStorage.getItem(key);
    }
    return { local, session };
  });
  return { cookies, ...storage };
}

async function capturePage(pageId, page, params) {
  if (!params.outputDir) throw new Error('page.capture requires outputDir');
  const outputDir = path.resolve(params.outputDir);
  const formats = params.formats?.length ? params.formats : ['html', 'text', 'screenshot'];
  const supported = new Set(['html', 'text', 'screenshot', 'mhtml']);
  for (const format of formats) {
    if (!supported.has(format)) throw new Error(`unsupported capture format: ${format}`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const files = {};

  if (formats.includes('html')) {
    const filename = path.join(outputDir, 'page.html');
    await fs.writeFile(filename, await page.content(), 'utf8');
    files.html = filename;
  }

  if (formats.includes('text')) {
    const filename = path.join(outputDir, 'page.txt');
    const text = await page.locator('body').innerText().catch(() => '');
    await fs.writeFile(filename, `${text}\n`, 'utf8');
    files.text = filename;
  }

  if (formats.includes('screenshot')) {
    const filename = path.join(outputDir, 'page.png');
    await page.screenshot({ path: filename, fullPage: true });
    files.screenshot = filename;
  }

  if (formats.includes('mhtml')) {
    const filename = path.join(outputDir, 'page.mhtml');
    const cdp = await page.context().newCDPSession(page);
    try {
      const snapshot = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      await fs.writeFile(filename, snapshot.data, 'utf8');
      files.mhtml = filename;
    } finally {
      await cdp.detach();
    }
  }

  const result = {
    page: pageId,
    url: page.url(),
    title: await page.title().catch(() => ''),
    capturedAt: new Date().toISOString(),
    files
  };
  const metadata = path.join(outputDir, 'metadata.json');
  await fs.writeFile(metadata, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  files.metadata = metadata;
  return result;
}

async function dispatch(method, params = {}) {
  switch (method) {
    case 'status':
      return {
        profile: PROFILE,
        headless: HEADLESS,
        browserRunning: context !== null,
        pages: await Promise.all([...pages].map(([id, page]) => describePage(id, page)))
      };

    case 'page.new': {
      const activeContext = await ensureBrowser();
      const page = await activeContext.newPage();
      return describePage(registerPage(page), page);
    }

    case 'page.list':
      return Promise.all([...pages].map(([id, page]) => describePage(id, page)));

    case 'page.close': {
      const page = requirePage(params.page);
      await page.close();
      return { page: params.page, closed: true };
    }

    case 'page.navigate': {
      const page = requirePage(params.page);
      const response = await page.goto(params.url, {
        waitUntil: params.waitUntil || 'domcontentloaded',
        timeout: params.timeout ?? 30000
      });
      return {
        page: params.page,
        url: page.url(),
        title: await page.title().catch(() => ''),
        status: response?.status() ?? null,
        statusText: response?.statusText() ?? null
      };
    }

    case 'page.inspect': {
      const page = requirePage(params.page);
      switch (params.kind || 'summary') {
        case 'summary':
          return describePage(params.page, page);
        case 'html':
          return { page: params.page, html: await page.content() };
        case 'text':
          return { page: params.page, text: await page.locator('body').innerText().catch(() => '') };
        case 'storage':
          return { page: params.page, ...(await inspectStorage(page)) };
        default:
          throw new Error(`unsupported inspect kind: ${params.kind}`);
      }
    }

    case 'page.scroll': {
      const page = requirePage(params.page);
      if (!Number.isSafeInteger(params.deltaY)) throw new Error('page.scroll requires a signed integer CSS-pixel delta');
      const geometry = await page.evaluate((deltaY) => {
        window.scrollBy(0, deltaY);
        const root = document.documentElement;
        const body = document.body;
        const documentHeight = Math.max(root?.scrollHeight || 0, root?.offsetHeight || 0,
          body?.scrollHeight || 0, body?.offsetHeight || 0);
        const scrollY = window.scrollY;
        const viewportHeight = window.innerHeight;
        return { scrollY, documentHeight, viewportHeight,
          atBottom: scrollY + viewportHeight >= documentHeight - 20 };
      }, params.deltaY);
      return { page: params.page, ...geometry };
    }

    case 'page.capture':
      return capturePage(params.page, requirePage(params.page), params);

    case 'page.click': {
      const page = requirePage(params.page);
      await page.locator(params.target).click({ timeout: params.timeout ?? 10000 });
      return { page: params.page, target: params.target };
    }

    case 'page.fill': {
      const page = requirePage(params.page);
      await page.locator(params.target).fill(params.value ?? '', { timeout: params.timeout ?? 10000 });
      return { page: params.page, target: params.target };
    }

    case 'page.press': {
      const page = requirePage(params.page);
      await page.locator(params.target).press(params.key, { timeout: params.timeout ?? 10000 });
      return { page: params.page, target: params.target, key: params.key };
    }

    case 'debug.session.open': {
      const page = requirePage(params.page);
      return debugSessions.open(params.page, async () => {
        const session = await page.context().newCDPSession(page);
        return {
          send: (method, args) => session.send(method, args),
          onEvent: (handler) => session.on('event', ({ method, params: data }) => handler(method, data)),
          onClose: (handler) => session.once('close', handler),
          close: () => session.detach()
        };
      });
    }

    case 'debug.session.send':
      return { session: params.session,
        result: await debugSessions.send(params.session, params.method, params.params ?? {}) };

    case 'debug.session.events':
      return debugSessions.events(params.session, params.after, params.limit, params.waitMs);

    case 'debug.session.close':
      return debugSessions.close(params.session);

    case 'debug.cdp': {
      const page = requirePage(params.page);
      if (!params.method || typeof params.method !== 'string') throw new Error('debug.cdp requires method');
      const cdp = await page.context().newCDPSession(page);
      try {
        return await cdp.send(params.method, params.params || {});
      } finally {
        await cdp.detach();
      }
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function removeSocket() {
  try {
    const stat = await fs.lstat(SOCKET);
    if (!stat.isSocket()) throw new Error(`refusing to remove non-socket path: ${SOCKET}`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`refusing to remove socket not owned by current user: ${SOCKET}`);
    }
    await fs.unlink(SOCKET);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

await removeSocket();

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', async (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
        const result = await dispatch(request.method, request.params);
        socket.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({
          id: request?.id ?? null,
          ok: false,
          error: { message: String(error?.message || error) }
        })}\n`);
      }
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(SOCKET, resolve);
});
await fs.chmod(SOCKET, 0o600);
console.log(JSON.stringify({ event: 'ready', socket: SOCKET, profile: PROFILE, headless: HEADLESS }));

let stopping = false;

async function closeServer() {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  let exitCode = code;

  await closeServer().catch(() => {
    exitCode = 1;
  });

  await debugSessions.closeAll();
  const activeContext = context;
  if (activeContext) {
    try {
      await writeStorageState(await activeContext.storageState());
    } catch (error) {
      exitCode = 1;
      console.error(`web-control-service: cannot persist profile storage state: ${error.message}`);
    }

    await activeContext.close().catch(() => {
      exitCode = 1;
    });
  }

  await removeSocket().catch(() => {
    exitCode = 1;
  });
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
