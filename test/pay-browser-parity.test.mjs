/**
 * The browser payment loop and the Node one must speak the same error vocabulary.
 *
 * apps/web/src/lib/playground/payBrowser.ts is a port of apps/agent/src/pay.mjs, and a
 * port drifts. If a visitor watching the playground and an agent calling the CLI get
 * different codes for the same condition, the "machine-readable rejection" claim is only
 * true of whichever one the reader happened to check.
 *
 * This suite reads the TypeScript source rather than importing it — the repo has no
 * bundler in the test path, and the properties worth pinning are textual anyway: the
 * code list and the classifier's branch order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ERROR_CODES, classifySettleFailure } from '../apps/agent/src/pay.mjs';

const browserSrc = readFileSync(new URL('../apps/web/src/lib/playground/payBrowser.ts', import.meta.url), 'utf8');

/** The codes the browser port declares. */
const browserCodes = [...browserSrc.matchAll(/^\s{2}(STELLARSIGHT_[A-Z_]+):/gm)].map((m) => m[1]);

test('every code the browser port declares exists in the Node enum', () => {
  assert.ok(browserCodes.length >= 10, `expected the browser port to declare codes, found ${browserCodes.length}`);
  for (const code of browserCodes) {
    assert.ok(ERROR_CODES[code], `${code} is declared in payBrowser.ts but not in pay.mjs`);
  }
});

test('the classifier branches on the same patterns, in the same order', () => {
  // Extract the browser classifier's regexes in source order and compare them to the
  // conditions pay.mjs is asserted against below. Order matters: "expired nonce" must
  // classify as replay, not expiry, and only the branch order decides that.
  const branches = [...browserSrc.matchAll(/if \(\/([^/]+)\/\.test\(r\)\) return '(STELLARSIGHT_[A-Z_]+)'/g)].map(
    (m) => ({ pattern: m[1], code: m[2] }),
  );
  assert.equal(branches.length, 3, 'the browser classifier should have three guarded branches plus a default');
  assert.equal(branches[0].code, 'STELLARSIGHT_REPLAY_REJECTED');
  assert.equal(branches[1].code, 'STELLARSIGHT_AUTH_EXPIRED');
  assert.equal(branches[2].code, 'STELLARSIGHT_INSUFFICIENT_BALANCE');
});

test('representative reasons classify identically in both implementations', () => {
  // The browser classifier is re-implemented here from its source patterns so the test
  // compares behaviour rather than trusting that two copies of a regex are the same.
  const browserClassify = (reason) => {
    const r = String(reason || '').toLowerCase();
    for (const m of browserSrc.matchAll(/if \(\/([^/]+)\/\.test\(r\)\) return '(STELLARSIGHT_[A-Z_]+)'/g)) {
      if (new RegExp(m[1]).test(r)) return m[2];
    }
    return 'STELLARSIGHT_SETTLE_FAILED';
  };

  const cases = [
    'authorization already used',
    'nonce has been consumed',
    'auth entry expired at ledger 4200000',
    'signature expiration ledger exceeded — too late',
    'insufficient balance for asset SXT',
    'account has no trustline',
    'invalid exact stellar payload simulation failed',
    '',
    null,
  ];

  for (const reason of cases) {
    assert.equal(
      browserClassify(reason),
      classifySettleFailure(reason),
      `the two loops disagree on "${reason}"`,
    );
  }
});

test('the browser port pins testnet and cannot be pointed at pubnet', () => {
  const configSrc = readFileSync(new URL('../apps/web/src/lib/playground/config.ts', import.meta.url), 'utf8');
  assert.match(configSrc, /export const NETWORK = 'stellar:testnet'/);
  // Strip comments first: the file SHOULD say the word while explaining the rule. What
  // must not exist is a pubnet value the code could actually use.
  const code = configSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    code,
    /pubnet/i,
    'the playground signs with a key it generated in a stranger’s browser; pubnet must not be reachable from here',
  );
  assert.doesNotMatch(code, /VITE_[A-Z_]*NETWORK/, 'the network must not be configurable from the environment');
});
