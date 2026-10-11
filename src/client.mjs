import net from 'node:net';
import process from 'node:process';
import { webControlSocketPath } from './runtime.mjs';

const SOCKET = webControlSocketPath();

function connectTimeoutMs() {
  const raw = process.env.WEB_CONTROL_CONNECT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 15000;
  if (!/^[0-9]+$/.test(raw)) throw new Error('WEB_CONTROL_CONNECT_TIMEOUT_MS must be a non-negative integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error('WEB_CONTROL_CONNECT_TIMEOUT_MS is too large');
  return value;
}

const CONNECT_TIMEOUT_MS = connectTimeoutMs();
const CONNECT_RETRY_MS = 100;

function usage() {
  return [
    'usage:',
    '  web-control status',
    '  web-control page list',
    '  web-control page new',
    '  web-control page close <page>',
    '  web-control page navigate <page> <url>',
    '  web-control page inspect <page> <summary|html|text|storage>',
    '  web-control page capture <page> <output-dir> [html|text|screenshot|mhtml]...',
    '  web-control page click <page> <target>',
    '  web-control page fill <page> <target> <value>',
    '  web-control page press <page> <target> <key>',
    '  web-control page scroll <page> <delta-y>',
    '  web-control debug cdp <page> <method> [params-json]'
  ].join('\n');
}

function invalid(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

function parse(argv) {
  if (argv.length === 1 && argv[0] === 'status') return { method: 'status', params: {} };
  if (argv[0] === 'page') {
    const op = argv[1];
    if (op === 'list' && argv.length === 2) return { method: 'page.list', params: {} };
    if (op === 'new' && argv.length === 2) return { method: 'page.new', params: {} };
    if (op === 'close' && argv.length === 3) return { method: 'page.close', params: { page: argv[2] } };
    if (op === 'navigate' && argv.length === 4) return { method: 'page.navigate', params: { page: argv[2], url: argv[3] } };
    if (op === 'inspect' && argv.length === 4) return { method: 'page.inspect', params: { page: argv[2], kind: argv[3] } };
    if (op === 'capture' && argv.length >= 4) return {
      method: 'page.capture',
      params: { page: argv[2], outputDir: argv[3], formats: argv.slice(4) }
    };
    if (op === 'click' && argv.length === 4) return { method: 'page.click', params: { page: argv[2], target: argv[3] } };
    if (op === 'fill' && argv.length === 5) return { method: 'page.fill', params: { page: argv[2], target: argv[3], value: argv[4] } };
    if (op === 'press' && argv.length === 5) return { method: 'page.press', params: { page: argv[2], target: argv[3], key: argv[4] } };
    if (op === 'scroll' && argv.length === 4 && /^-?\d+$/.test(argv[3]) && Number.isSafeInteger(Number(argv[3]))) return { method: 'page.scroll', params: { page: argv[2], deltaY: Number(argv[3]) } };
  }
  if (argv[0] === 'debug' && argv[1] === 'cdp' && (argv.length === 4 || argv.length === 5)) {
    let params = {};
    if (argv[4]) {
      try { params = JSON.parse(argv[4]); }
      catch { invalid('invalid CDP params JSON'); }
    }
    return { method: 'debug.cdp', params: { page: argv[2], method: argv[3], params } };
  }
  invalid('invalid invocation');
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectReady() {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;

  while (true) {
    try {
      return await connectOnce();
    } catch (error) {
      const retryable = error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED';
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

async function request(message) {
  const socket = await connectReady();

  return new Promise((resolve, reject) => {
    socket.setEncoding('utf8');
    let buffer = '';

    socket.once('error', reject);
    socket.write(`${JSON.stringify({ id: 1, ...message })}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.end();
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error?.message || 'web-control request failed'));
    });
  });
}

try {
  const parsed = parse(process.argv.slice(2));
  const result = await request(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`web-control: ${String(error?.message || error)}\n`);
  process.exit(1);
}
