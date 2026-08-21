/**
 * A replay must be REPORTED as a replay, not merely refused.
 *
 * The chain already refuses it — that was never in doubt. What was broken is that the
 * caller could not tell a replay from an underfunded account from a genuine bug, because
 * `@x402/stellar` collapses every simulation failure into
 * `invalid_exact_stellar_payload_simulation_failed` after reading and discarding the real
 * diagnostic (see apps/facilitator/src/settled-nonces.mjs).
 *
 * The existing client-side suite (apps/agent/src/replay-guard.test.mjs) drives a MOCK
 * facilitator that returns the word "replay", so it proves the classifier and nothing
 * about what the real stack says. This suite pins the other half: that the identity we
 * key on is the one the chain keys on, and that the sentence the facilitator produces
 * classifies as a replay in both payment clients.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Asset, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE, Account } from '@stellar/stellar-sdk';

import { authIdentity, remember, replayReason, resetMemory, seen } from '../apps/facilitator/src/settled-nonces.mjs';
import { classifySettleFailure, ERROR_CODES } from '../apps/agent/src/pay.mjs';

/* ── the identity we key on ───────────────────────────────────────────────── */

test('an unparseable or absent payload yields no identity — and is never called a replay', () => {
  for (const payload of [null, undefined, {}, { payload: {} }, { payload: { transaction: 'not-xdr' } }]) {
    assert.equal(authIdentity(payload), null, `${JSON.stringify(payload)} must not produce an identity`);
  }
});

test('a classic payment envelope carrying no auth entry yields no identity', () => {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build();
  assert.equal(authIdentity({ payload: { transaction: tx.toXDR() } }), null);
});

test('a real settled payload yields the (address, nonce) pair Soroban replay-protects on', () => {
  // A payload captured from a real settlement through this stack. Kept as a fixture so
  // the property is pinned without a network: what matters is that the parse agrees with
  // the chain's own identity, and that does not change between runs.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/settled-payload.json', import.meta.url), 'utf8'));
  const id = authIdentity(fixture.paymentPayload);
  assert.ok(id, 'the payload must yield an identity');
  assert.match(id.address, /^G[A-Z2-7]{55}$/, 'the payer address');
  assert.match(id.nonce, /^-?\d+$/, 'the nonce is an integer');
  assert.equal(id.address, fixture.expect.address);
  assert.equal(id.nonce, fixture.expect.nonce);
  assert.ok(id.expiry > 0, 'the entry carries a signature expiration ledger');
});

/* ── the memory ───────────────────────────────────────────────────────────── */

test('a nonce is unknown until it settles, then recognised', async () => {
  resetMemory();
  const id = { address: 'G' + 'A'.repeat(55), nonce: '123', fingerprint: 'abc' };
  assert.equal((await seen(id, { kv: null })).seen, false, 'unknown before settling');
  await remember(id, { kv: null });
  assert.equal((await seen(id, { kv: null })).seen, true, 'recognised after settling');
});

test('a different nonce from the same payer is a different payment', async () => {
  resetMemory();
  const a = { address: 'G' + 'B'.repeat(55), nonce: '1' };
  const b = { address: 'G' + 'B'.repeat(55), nonce: '2' };
  await remember(a, { kv: null });
  assert.equal((await seen(b, { kv: null })).seen, false);
});

test('an unreachable store fails OPEN, and says so', async () => {
  resetMemory();
  const brokenKv = { transport: 'redis', command: async () => ({ ok: false, reason: 'connect ECONNREFUSED' }) };
  const result = await seen({ address: 'G' + 'C'.repeat(55), nonce: '9' }, { kv: brokenKv });
  // Failing closed would reject real payments whenever Redis blinks — strictly worse than
  // not naming the replay, since the chain refuses it either way.
  assert.equal(result.seen, false);
  assert.match(result.degraded, /ECONNREFUSED/);
});

test('no identity is never reported as seen', async () => {
  assert.equal((await seen(null, { kv: null })).seen, false);
});

/* ── the wiring: the sentence IS the contract ─────────────────────────────── */

test('the facilitator’s replay sentence classifies as a replay in the Node client', () => {
  const reason = replayReason({ address: 'G' + 'D'.repeat(55), nonce: '4242' });
  assert.equal(classifySettleFailure(reason), ERROR_CODES.STELLARSIGHT_REPLAY_REJECTED);
});

test('the same sentence classifies as a replay in the browser port', () => {
  const src = readFileSync(new URL('../apps/web/src/lib/playground/payBrowser.ts', import.meta.url), 'utf8');
  const reason = replayReason({ address: 'G' + 'E'.repeat(55), nonce: '77' }).toLowerCase();
  const branches = [...src.matchAll(/if \(\/([^/]+)\/\.test\(r\)\) return '(STELLARSIGHT_[A-Z_]+)'/g)];
  const hit = branches.find((m) => new RegExp(m[1]).test(reason));
  assert.ok(hit, 'no browser branch matched the replay sentence');
  assert.equal(hit[2], 'STELLARSIGHT_REPLAY_REJECTED');
});

test('the sentence names the nonce and the payer, so the rejection is diagnosable', () => {
  const reason = replayReason({ address: 'GABC', nonce: '5150' });
  assert.match(reason, /5150/);
  assert.match(reason, /GABC/);
  // And it does not overclaim: the chain is the enforcement, we are the naming.
  assert.match(reason, /chain would reject this submission regardless/i);
});

/* ── the live path: the properties, against the real chain ────────────────── */

/**
 * These run only with the stack up (`npm run setup && npm run dev:all`) and skip cleanly
 * otherwise, the same way apps/agent/src/replay-guard.test.mjs does. They settle real
 * testnet dust, which is the point: the mocked suite proves the classifier, and this one
 * proves what the chain and the facilitator actually say.
 */
const SELLER = process.env.SELLER_URL || 'http://localhost:4023';
const TARGET = `${SELLER}/v1/fx/usd-brl`;

const stackUp = await fetch(`${SELLER}/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);
const live = { skip: stackUp ? false : 'needs the local stack: npm run dev:all' };

const b64 = {
  dec: (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8')),
  enc: (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64'),
};

test('live: a replayed authorization is refused AND named as a replay', live, async () => {
  const { payAndFetch } = await import('../apps/agent/src/pay.mjs');
  const paid = await payAndFetch(TARGET, {});
  assert.equal(paid.ok, true, `baseline payment failed: ${paid.code} ${paid.reason}`);

  const replay = await payAndFetch(TARGET, { forcePaymentHeader: paid.paymentHeader });
  assert.equal(replay.ok, false, 'a spent authorization must not settle twice');
  assert.equal(replay.code, ERROR_CODES.STELLARSIGHT_REPLAY_REJECTED, 'and the caller must be told WHICH failure this is');
  assert.match(replay.reason, /replay/i);
  assert.equal(replay.txHash, null);
});

test('live: corrupting the signed envelope is refused', live, async () => {
  const { payAndFetch } = await import('../apps/agent/src/pay.mjs');
  // A FRESH entry: one taken from a settled payment would be refused for its consumed
  // nonce, and would then be miscredited to signature validation.
  const signed = await payAndFetch(TARGET, { signOnly: true });
  assert.equal(signed.ok, true, `sign-only failed: ${signed.code} ${signed.reason}`);
  assert.equal(signed.txHash, null, 'signing must not settle anything');

  const decoded = b64.dec(signed.paymentHeader);
  const xdr = decoded.payload.transaction;
  const at = Math.floor(xdr.length * 0.75);
  decoded.payload.transaction = `${xdr.slice(0, at)}${xdr[at] === 'A' ? 'B' : 'A'}${xdr.slice(at + 1)}`;

  const out = await payAndFetch(TARGET, { forcePaymentHeader: b64.enc(decoded) });
  assert.equal(out.ok, false, 'a corrupted envelope must not settle');
  assert.ok(out.reason?.trim(), 'and the refusal must carry a reason');
});

test('live: inflating the echoed price changes nothing about what is charged', live, async () => {
  const { payAndFetch } = await import('../apps/agent/src/pay.mjs');
  const signed = await payAndFetch(TARGET, { signOnly: true });
  assert.equal(signed.ok, true, `sign-only failed: ${signed.code} ${signed.reason}`);

  const decoded = b64.dec(signed.paymentHeader);
  const original = String(decoded.accepted.amount);
  decoded.accepted.amount = (BigInt(original) * 100n).toString();

  const out = await payAndFetch(TARGET, { forcePaymentHeader: b64.enc(decoded) });

  // The echoed block is untrusted decoration: the seller re-derives the price and the
  // chain moves what the SIGNED transaction says. So this is not refused — it is ignored,
  // and the honest assertion is about the amount, not about a rejection.
  if (out.ok) {
    const charged = Number(out.body?.paidWith?.amount ?? NaN);
    assert.ok(Number.isFinite(charged), 'the receipt must state what was charged');
    assert.ok(
      charged <= Number(original) / 1e7 + 1e-9,
      `charged ${charged}, but the signed transaction authorised ${Number(original) / 1e7}`,
    );
  } else {
    // Refusing outright is also correct; what must never happen is an overcharge.
    assert.ok(out.reason?.trim(), 'a refusal must carry a reason');
  }
});
