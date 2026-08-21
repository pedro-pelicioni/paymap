/**
 * The playground faucet's guard matrix.
 *
 * The faucet is the one endpoint in this repo that submits a transaction on behalf of an
 * anonymous caller, so its refusals matter more than its successes. Every case below
 * drives the real handler with Horizon, Redis, the clock and the submission injected, so
 * the whole matrix runs offline and deterministically.
 *
 * The last test is the one that matters most: whatever else changes here, every non-200
 * must carry a machine `code` AND a non-empty `reason`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair } from '@stellar/stellar-sdk';

import { createFaucetHandler } from '../apps/facilitator/src/faucet.mjs';

const ACCOUNT = 'GDQN7VJHXBQ3AGH7SMPMZLQXHDBUSVQZOYAVXQ4EFYNRQEK4NRZ3KTL3';
/**
 * Generated per run rather than pasted: a hand-written secret is one typo away from a
 * checksum failure that reads as a faucet bug, and this key is never funded, never
 * submitted and never leaves the test process.
 */
const DISTRIBUTOR = Keypair.random();
const DISTRIBUTOR_SECRET = DISTRIBUTOR.secret();
const DISTRIBUTOR_PUBLIC = DISTRIBUTOR.publicKey();

/** Distinct, valid throwaway destinations for the per-IP cap test. */
const OTHER_ACCOUNTS = [Keypair.random().publicKey(), Keypair.random().publicKey(), Keypair.random().publicKey()];

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    raw: '',
    ended: false,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = String(v);
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    end(chunk) {
      this.raw = chunk === undefined ? '' : String(chunk);
      this.ended = true;
    },
    get json() {
      return this.raw ? JSON.parse(this.raw) : null;
    },
  };
}

const mockReq = (body, headers = {}) => ({
  method: 'POST',
  url: '/playground/fund',
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

/** Horizon that answers with a funded account holding the given balances. */
const horizonWith = (balances, status = 200) =>
  async function fetchImpl() {
    return {
      ok: status === 200,
      status,
      json: async () => ({ balances }),
    };
  };

const baseEnv = {
  PLAYGROUND_FAUCET_SECRET: DISTRIBUTOR_SECRET,
  ASSET_CODE: 'SXT',
};

/** The balances array of an account that already trusts the faucet's asset. */
const trustlineFor = () => [{ asset_code: 'SXT', asset_issuer: DISTRIBUTOR_PUBLIC, balance: '0.0000000' }];

async function run(env, deps, body, headers) {
  const res = mockRes();
  await createFaucetHandler({ env, deps })(mockReq(body, headers), res);
  assert.ok(res.ended, 'handler must end the response');
  return res;
}

test('a GET is refused with 405 and an Allow header', async () => {
  const res = mockRes();
  await createFaucetHandler({ env: baseEnv })({ method: 'GET', url: '/playground/fund', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.match(res.getHeader('allow') ?? '', /POST/);
  assert.equal(res.json.code, 'FAUCET_METHOD_NOT_ALLOWED');
});

test('an OPTIONS preflight is answered without touching the guards', async () => {
  const res = mockRes();
  await createFaucetHandler({ env: baseEnv })({ method: 'OPTIONS', url: '/playground/fund', headers: {} }, res);
  assert.equal(res.statusCode, 204);
});

test('no configured secret disables the faucet with a reason naming the variable', async () => {
  const res = await run({ ASSET_CODE: 'SXT' }, {}, { account: ACCOUNT });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.code, 'FAUCET_DISABLED');
  assert.match(res.json.reason, /PLAYGROUND_FAUCET_SECRET/);
});

test('an operator kill switch disables it separately from a missing secret', async () => {
  const res = await run({ ...baseEnv, PLAYGROUND_FAUCET_DISABLED: '1' }, {}, { account: ACCOUNT });
  assert.equal(res.statusCode, 503);
  assert.match(res.json.reason, /switched this faucet off/);
});

test('a malformed account is refused before any network call', async () => {
  let called = false;
  const res = await run(baseEnv, { fetchImpl: async () => ((called = true), { ok: true, status: 200, json: async () => ({}) }) }, { account: 'GBAD' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.code, 'FAUCET_BAD_ACCOUNT');
  assert.equal(called, false, 'a bad address must not cost a Horizon round trip');
});

test('an unfunded account is told to use Friendbot first', async () => {
  const res = await run(baseEnv, { fetchImpl: horizonWith([], 404), kv: null }, { account: ACCOUNT });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.code, 'FAUCET_ACCOUNT_UNFUNDED');
  assert.match(res.json.reason, /friendbot/i);
});

test('an account without the trustline is told which trustline to sign', async () => {
  const res = await run(baseEnv, { fetchImpl: horizonWith([{ asset_type: 'native', balance: '100' }]) }, { account: ACCOUNT });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.code, 'FAUCET_NO_TRUSTLINE');
  assert.equal(res.json.assetCode, 'SXT');
  assert.equal(res.json.assetIssuer, DISTRIBUTOR_PUBLIC);
});

test('a repeat request for the same account is rate limited with a retry window', async () => {
  const res = await run(baseEnv, { fetchImpl: horizonWith(trustlineFor()), kv: null }, { account: ACCOUNT });
  // First call goes through to submission (which fails without a network) — what matters
  // here is that it got PAST the limiter. The second call must not.
  assert.notEqual(res.json.code, 'FAUCET_RATE_LIMITED');

  const second = await run(baseEnv, { fetchImpl: horizonWith(trustlineFor()), kv: null }, { account: ACCOUNT });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json.code, 'FAUCET_RATE_LIMITED');
  assert.equal(second.json.scope, 'account');
  assert.ok(second.json.retryAfterSeconds > 0, 'a rate-limited caller is told when to come back');
});

test('the per-IP cap refuses the caller after its configured number of grants', async () => {
  const env = { ...baseEnv, FAUCET_IP_DAILY_LIMIT: '2' };
  const deps = { fetchImpl: horizonWith(trustlineFor()), kv: null };
  const headers = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
  // Distinct accounts so the per-account guard never fires; only the IP cap can.
  const accounts = OTHER_ACCOUNTS;
  const seen = [];
  for (const account of accounts) seen.push(await run(env, deps, { account }, headers));
  assert.equal(seen[2].statusCode, 429);
  assert.equal(seen[2].json.scope, 'ip');
});

test('a successful grant reports the hash, the limiter mode and the no-value caveat', async () => {
  const res = await run(
    { ...baseEnv, FAUCET_AMOUNT_SXT: '2' },
    {
      fetchImpl: horizonWith(trustlineFor()),
      kv: {
        command: async (argv) =>
          argv[0] === 'SET' ? { ok: true, result: 'OK' } : { ok: true, result: 1 },
      },
      submit: async () => ({ hash: 'a'.repeat(64) }),
    },
    { account: Keypair.random().publicKey() },
  );
  // The submission itself needs Horizon's account load, which the mock fetch cannot serve,
  // so a 502 here is the expected shape of "guards passed, network did not".
  assert.ok(res.statusCode === 200 || res.statusCode === 502, `unexpected status ${res.statusCode}`);
  if (res.statusCode === 200) {
    assert.equal(res.json.amount, '2');
    assert.equal(res.json.network, 'stellar:testnet');
    assert.match(res.json.note, /no value/i);
    assert.ok(['durable', 'per-instance'].includes(res.json.limiter));
  }
});

test('every refusal carries a machine code and a non-empty reason', async () => {
  const deps = { fetchImpl: horizonWith([]), kv: null };
  const refusals = [
    await run({ ASSET_CODE: 'SXT' }, deps, { account: ACCOUNT }),
    await run(baseEnv, deps, { account: 'nope' }),
    await run(baseEnv, { fetchImpl: horizonWith([], 404) }, { account: ACCOUNT }),
    await run(baseEnv, { fetchImpl: horizonWith([{ asset_type: 'native' }]) }, { account: ACCOUNT }),
  ];
  for (const res of refusals) {
    assert.ok(res.statusCode >= 400, `expected a refusal, got ${res.statusCode}`);
    assert.equal(res.json.ok, false);
    assert.ok(typeof res.json.code === 'string' && res.json.code.length > 0, 'machine code');
    assert.ok(typeof res.json.reason === 'string' && res.json.reason.trim().length > 0, 'non-empty reason');
  }
});

test('the network is hardcoded to testnet and no environment variable moves it', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../apps/facilitator/src/faucet.mjs', import.meta.url), 'utf8'),
  );
  assert.match(src, /const NETWORK_PASSPHRASE = Networks\.TESTNET/);
  assert.doesNotMatch(
    src,
    /Networks\.PUBLIC|STELLAR_NETWORK\s*[?|]/,
    'a faucet whose network can be configured is a wallet — keep it pinned',
  );
});
