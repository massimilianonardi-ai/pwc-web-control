import test from 'node:test';
import assert from 'node:assert/strict';
import {webControlIgnoreHTTPSErrors} from '../src/runtime.mjs';

test('Playwright HTTPS verification is enabled by default', () => {
  assert.equal(webControlIgnoreHTTPSErrors({}),false);
  assert.equal(webControlIgnoreHTTPSErrors({WEB_CONTROL_IGNORE_HTTPS_ERRORS:'0'}),false);
  assert.equal(webControlIgnoreHTTPSErrors({WEB_CONTROL_IGNORE_HTTPS_ERRORS:'true'}),false);
});

test('Playwright ignoreHTTPSErrors requires explicit exact opt-in', () => {
  assert.equal(webControlIgnoreHTTPSErrors({WEB_CONTROL_IGNORE_HTTPS_ERRORS:'1'}),true);
});
