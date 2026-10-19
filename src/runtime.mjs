import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export function webControlHome(env = process.env) {
  return env.WEB_CONTROL_HOME || path.join(os.homedir(), '.rumiai-web-control');
}

export function webControlSocketPath(env = process.env) {
  if (env.WEB_CONTROL_SOCKET) return env.WEB_CONTROL_SOCKET;

  const home = webControlHome(env);
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const key = crypto.createHash('sha256').update(home).digest('hex').slice(0, 16);
  return path.join('/tmp', `rumiai-web-control-${uid}-${key}.sock`);
}

// Explicit per-service Playwright context opt-in; secure by default.
export function webControlIgnoreHTTPSErrors(env = process.env) {
  return env.WEB_CONTROL_IGNORE_HTTPS_ERRORS === '1';
}
