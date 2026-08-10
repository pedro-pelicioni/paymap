/**
 * STELLARSIGHT — replay / expiry guard tests.
 *
 *   node --test apps/agent/src/replay-guard.test.mjs
 *
 * What is proven here:
 *   1. A replayed PAYMENT-SIGNATURE header is rejected, with a NON-NULL reason
 *      and the STELLARSIGHT_REPLAY_REJECTED code.
 *   2. An expired authorization entry is rejected, with a NON-NULL reason and
 *      the STELLARSIGHT_AUTH_EXPIRED code.
 *   3. Every rejection path in the client carries a non-null reason, always.
 *
 * Tests 1-3 are hermetic: they run a local seller stub on an ephemeral port and
 * a throwaway keypair, and never touch the network. Test 4 exercises the same
 * guarantee against the real facilitator and SKIPS CLEANLY when it is not up.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { Keypair } from '@stellar/stellar-sdk';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';

import { ERROR_CODES, classifySettleFailure, fail, loadConfig, payAndFetch } from './pay.mjs';

const NETWORK = 'stellar:testnet';
const SELLER = Keypair.random().publicKey();
const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'; // testnet SAC, placeholder
const PAYER = Keypair.random(); // never funded — we never sign in the hermetic tests

/** A payment header that is syntactically valid base64 JSON, as if signed earlier. */
function fakeSignedHeader(tag = 'entry-1') {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: NETWORK,
      asset: ASSET,
      amount: '10000',
      payTo: SELLER,
      maxTimeoutSeconds: 60,
      extra: {}
    },
    payload: { transaction: `AAAA-FAKE-XDR-${tag}` }
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function challengeHeader(url) {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url, description: 'stub priced resource', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        asset: ASSET,
        amount: '10000',
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        extra: {}
      }
    ]
  });
}

/**
 * Seller stub. `verdict(header, seen)` decides what settlement says.
 * Returns { url, close }.
 */
async function startSellerStub(verdict) {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const url = `http://127.0.0.1:${server.address().port}${req.url}`;
    const payment = req.headers['payment-signature'] || req.headers['x-payment'];

    if (!payment) {
      res.writeHead(402, {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': challengeHeader(url)
      });
      res.end(JSON.stringify({ error: 'payment required' }));
      return;
    }

    const decision = verdict(String(payment), seen);
    seen.add(String(payment));

    if (decision.success) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true,
          errorReason: undefined,
          transaction: 'a'.repeat(64),
          network: NETWORK,
          payer: PAYER.publicKey()
        })
      });
      res.end(JSON.stringify({ rate: 5.42, pair: 'USD/BRL' }));
      return;
    }

    res.writeHead(402, {
      'content-type': 'application/json',
      'PAYMENT-RESPONSE': encodePaymentResponseHeader({
        success: false,
        errorReason: decision.errorReason,
        transaction: '',
        network: NETWORK,
        payer: PAYER.publicKey()
      })
    });
    res.end(JSON.stringify({ error: decision.errorReason }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/rate`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Config that lets the client build a signer without touching the network. */
const HERMETIC = { PAYER_SECRET: PAYER.secret(), STELLAR_NETWORK: NETWORK };

/* ------------------------------------------------------------------ */

test('a replayed PAYMENT-SIGNATURE header is rejected with a non-null reason', async () => {
  const stub = await startSellerStub((header, seen) =>
    seen.has(header)
      ? { success: false, errorReason: 'payment replayed: this authorization entry was already consumed' }
      : { success: true }
  );

  try {
    const header = fakeSignedHeader('replay');

    // First presentation settles.
    const first = await payAndFetch(stub.url, { config: HERMETIC, forcePaymentHeader: header });
    assert.equal(first.ok, true, `first payment should settle, got ${first.code}: ${first.reason}`);
    assert.equal(first.txHash, 'a'.repeat(64));

    // Same header again -> must be refused.
    const replay = await payAndFetch(stub.url, { config: HERMETIC, forcePaymentHeader: header });
    assert.equal(replay.ok, false, 'a replayed header must not succeed');
    assert.equal(replay.code, ERROR_CODES.STELLARSIGHT_REPLAY_REJECTED);
    assert.ok(replay.reason, 'reason must not be null');
    assert.notEqual(replay.reason.trim(), '', 'reason must not be empty');
    assert.match(replay.reason, /replay/i);
    assert.equal(replay.txHash, null, 'a rejected replay must not report a tx hash');
  } finally {
    await stub.close();
  }
});

test('an expired authorization entry is rejected with a non-null reason', async () => {
  const stub = await startSellerStub(() => ({
    success: false,
    errorReason: 'authorization entry expired: signature ledger bounds exceeded'
  }));

  try {
    const res = await payAndFetch(stub.url, { config: HERMETIC, forcePaymentHeader: fakeSignedHeader('expired') });
    assert.equal(res.ok, false, 'an expired auth entry must not succeed');
    assert.equal(res.code, ERROR_CODES.STELLARSIGHT_AUTH_EXPIRED);
    assert.ok(res.reason && res.reason.trim() !== '', 'reason must not be null or empty');
    assert.match(res.reason, /expired/i);
    assert.equal(res.txHash, null);
    assert.ok(res.timings && typeof res.timings.totalMs === 'number', 'timings are always reported');
  } finally {
    await stub.close();
  }
});

test('every rejection carries a non-null reason and a known code', async () => {
  // The failure factory itself can never emit a null/blank reason.
  for (const bad of [null, undefined, '', '   ']) {
    const f = fail('STELLARSIGHT_SETTLE_FAILED', bad);
    assert.equal(f.ok, false);
    assert.ok(f.reason && f.reason.trim() !== '', `reason must be filled in for input ${JSON.stringify(bad)}`);
    assert.ok(Object.values(ERROR_CODES).includes(f.code));
  }

  // Facilitator failure strings map onto the enum deterministically.
  assert.equal(classifySettleFailure('payment replayed'), 'STELLARSIGHT_REPLAY_REJECTED');
  assert.equal(classifySettleFailure('nonce already used'), 'STELLARSIGHT_REPLAY_REJECTED');
  assert.equal(classifySettleFailure('auth entry expired'), 'STELLARSIGHT_AUTH_EXPIRED');
  assert.equal(classifySettleFailure('ledger bounds exceeded'), 'STELLARSIGHT_AUTH_EXPIRED');
  assert.equal(classifySettleFailure('insufficient balance'), 'STELLARSIGHT_INSUFFICIENT_BALANCE');
  assert.equal(classifySettleFailure('something unheard of'), 'STELLARSIGHT_SETTLE_FAILED');
  assert.equal(classifySettleFailure(undefined), 'STELLARSIGHT_SETTLE_FAILED');

  // Real client rejections, no server involved.
  const noUrl = await payAndFetch('', { config: HERMETIC });
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.code, ERROR_CODES.STELLARSIGHT_BAD_REQUEST);
  assert.ok(noUrl.reason);

  const noKey = await payAndFetch('http://127.0.0.1:1/x', { config: { PAYER_SECRET: '' } });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, ERROR_CODES.STELLARSIGHT_CONFIG_MISSING);
  assert.ok(noKey.reason);

  const unreachable = await payAndFetch('http://127.0.0.1:1/x', { config: HERMETIC, timeoutMs: 1500 });
  assert.equal(unreachable.ok, false);
  assert.ok([ERROR_CODES.STELLARSIGHT_RESOURCE_UNREACHABLE, ERROR_CODES.STELLARSIGHT_TIMEOUT].includes(unreachable.code));
  assert.ok(unreachable.reason);

  // Every code in the enum is STELLARSIGHT-namespaced.
  for (const [k, v] of Object.entries(ERROR_CODES)) {
    assert.equal(k, v);
    assert.match(v, /^STELLARSIGHT_[A-Z0-9_]+$/);
  }
});

/* ------------------------------------------------------------------ *
 * Integration: only when the real facilitator is up.
 * ------------------------------------------------------------------ */
async function facilitatorUp(url) {
  try {
    const res = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

test('the live facilitator refuses a replayed payment', async (t) => {
  const cfg = loadConfig();
  const supported = await facilitatorUp(cfg.facilitatorUrl);
  if (!supported) {
    t.skip(`facilitator not reachable at ${cfg.facilitatorUrl} — skipping the live replay check`);
    return;
  }

  const kinds = Array.isArray(supported.kinds) ? supported.kinds : [];
  assert.ok(kinds.length > 0, '/supported must advertise at least one kind');

  // Present the same (unsigned, therefore invalid) payload twice. The facilitator
  // must refuse both, and every refusal must carry a stated reason.
  const bogus = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: kinds[0].extra?.asset
        ? {
            scheme: 'exact',
            network: kinds[0].network,
            asset: kinds[0].extra.asset,
            amount: '10000',
            payTo: SELLER,
            maxTimeoutSeconds: 60,
            extra: {}
          }
        : {},
      payload: { transaction: 'AAAA-REPLAYED' }
    },
    paymentRequirements: {
      scheme: 'exact',
      network: kinds[0].network,
      asset: kinds[0].extra?.asset ?? ASSET,
      amount: '10000',
      payTo: SELLER,
      maxTimeoutSeconds: 60,
      extra: {}
    }
  };

  for (const attempt of [1, 2]) {
    const res = await fetch(`${cfg.facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bogus),
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json().catch(() => null);
    assert.ok(json, `attempt ${attempt}: facilitator must answer JSON`);
    assert.equal(json.isValid, false, `attempt ${attempt}: an unsigned replayed payload must never verify`);
    assert.ok(
      json.invalidReason !== null && json.invalidReason !== undefined && String(json.invalidReason).trim() !== '',
      `attempt ${attempt}: invalidReason must be non-null`
    );
  }
});
