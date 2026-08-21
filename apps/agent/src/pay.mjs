/**
 * STELLARSIGHT — reusable x402 payment client for AI agent runtimes.
 *
 * Wraps the full discover -> 402 -> sign -> retry -> settle loop behind one call.
 * Never throws for protocol/network failure: always resolves to a structured
 * `{ ok:false, code, reason }` result so an agent can reason about the failure.
 *
 * Stack (all verified against installed dist/*.d.ts, nothing invented):
 *   @x402/stellar          -> createEd25519Signer(secret, "stellar:testnet")
 *   @x402/stellar/exact/client -> ExactStellarScheme(signer, { url })
 *   @x402/fetch            -> x402Client, x402HTTPClient
 *
 * x402 v2 wire facts (read from @x402/core dist, not guessed):
 *   402 challenge  -> response header `PAYMENT-REQUIRED`  (base64 JSON PaymentRequired)
 *   signed payload -> request  header `PAYMENT-SIGNATURE` (v2) / `X-PAYMENT` (v1)
 *   settlement     -> response header `PAYMENT-RESPONSE`  / `X-PAYMENT-RESPONSE`
 * We send both `PAYMENT-SIGNATURE` and `X-PAYMENT` so v1-shaped sellers also work.
 *
 * Testnet only. No relayer, no third-party channel service.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { x402Client, x402HTTPClient } from '@x402/fetch';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { createEd25519Signer } from '@x402/stellar';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/* ------------------------------------------------------------------ *
 * Error codes — the machine-readable enum every rejection speaks in.
 * Every rejection carries a NON-NULL `reason` (RFP acceptance criterion).
 * ------------------------------------------------------------------ */
export const ERROR_CODES = Object.freeze({
  STELLARSIGHT_CONFIG_MISSING: 'STELLARSIGHT_CONFIG_MISSING',
  STELLARSIGHT_BAD_REQUEST: 'STELLARSIGHT_BAD_REQUEST',
  STELLARSIGHT_INDEX_UNREACHABLE: 'STELLARSIGHT_INDEX_UNREACHABLE',
  STELLARSIGHT_INDEX_ERROR: 'STELLARSIGHT_INDEX_ERROR',
  STELLARSIGHT_NO_RESULTS: 'STELLARSIGHT_NO_RESULTS',
  STELLARSIGHT_NOT_FOUND: 'STELLARSIGHT_NOT_FOUND',
  STELLARSIGHT_RESOURCE_UNREACHABLE: 'STELLARSIGHT_RESOURCE_UNREACHABLE',
  STELLARSIGHT_402_MALFORMED: 'STELLARSIGHT_402_MALFORMED',
  STELLARSIGHT_UNSUPPORTED_NETWORK: 'STELLARSIGHT_UNSUPPORTED_NETWORK',
  STELLARSIGHT_PRICE_EXCEEDS_BUDGET: 'STELLARSIGHT_PRICE_EXCEEDS_BUDGET',
  STELLARSIGHT_SIGN_FAILED: 'STELLARSIGHT_SIGN_FAILED',
  STELLARSIGHT_INSUFFICIENT_BALANCE: 'STELLARSIGHT_INSUFFICIENT_BALANCE',
  STELLARSIGHT_REPLAY_REJECTED: 'STELLARSIGHT_REPLAY_REJECTED',
  STELLARSIGHT_AUTH_EXPIRED: 'STELLARSIGHT_AUTH_EXPIRED',
  STELLARSIGHT_SETTLE_FAILED: 'STELLARSIGHT_SETTLE_FAILED',
  STELLARSIGHT_UPSTREAM_ERROR: 'STELLARSIGHT_UPSTREAM_ERROR',
  STELLARSIGHT_TIMEOUT: 'STELLARSIGHT_TIMEOUT'
});

/** Shape every failure takes. `reason` is never null and never empty. */
export function fail(code, reason, extra = {}) {
  return {
    ok: false,
    code: ERROR_CODES[code] ?? code,
    reason: reason && String(reason).trim() ? String(reason) : `unspecified failure (${code})`,
    ...extra
  };
}

/* ------------------------------------------------------------------ *
 * Config — repo-root .env, tolerated missing.
 * ------------------------------------------------------------------ */
let _envCache = null;

function readDotEnv() {
  if (_envCache) return _envCache;
  const out = {};
  const file = path.join(REPO_ROOT, '.env');
  try {
    if (fs.existsSync(file)) {
      for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        out[key] = val;
      }
    }
  } catch {
    /* unreadable .env is the same as absent */
  }
  _envCache = out;
  return out;
}

/** Merged config: process.env wins over repo-root .env, then defaults. */
export function loadConfig(overrides = {}) {
  const file = readDotEnv();
  const pick = (k, dflt) => overrides[k] ?? process.env[k] ?? file[k] ?? dflt;
  return {
    network: pick('STELLAR_NETWORK', 'stellar:testnet'),
    rpcUrl: pick('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org'),
    horizonUrl: pick('HORIZON_URL', 'https://horizon-testnet.stellar.org'),
    indexUrl: stripSlash(pick('INDEX_URL', 'http://localhost:4022')),
    facilitatorUrl: stripSlash(pick('FACILITATOR_URL', 'http://localhost:4021')),
    sellerUrl: stripSlash(pick('SELLER_URL', 'http://localhost:4023')),
    payerSecret: pick('PAYER_SECRET', ''),
    payerPublic: pick('PAYER_PUBLIC', ''),
    assetSac: pick('ASSET_SAC', ''),
    assetCode: pick('ASSET_CODE', 'SXT')
  };
}

const stripSlash = (u) => String(u || '').replace(/\/+$/, '');

/** stellar.expert explorer link for a settled tx. */
export function explorerFor(txHash, network = 'stellar:testnet') {
  if (!txHash) return null;
  const seg = network === 'stellar:pubnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${seg}/tx/${txHash}`;
}

/* ------------------------------------------------------------------ *
 * Signer / client construction
 * ------------------------------------------------------------------ */
const clientCache = new Map();

/**
 * Build (and memoise) an x402 client bound to the PAYER key.
 * Returns `{ ok:true, client, httpClient, address }` or a `fail()` result.
 */
export function buildPaymentClient(cfg) {
  if (!cfg.payerSecret) {
    return fail(
      'STELLARSIGHT_CONFIG_MISSING',
      'PAYER_SECRET is not set. Run scripts/setup-testnet.mjs or export PAYER_SECRET=S... before paying.'
    );
  }
  if (!/^S[A-Z2-7]{55}$/.test(cfg.payerSecret)) {
    return fail(
      'STELLARSIGHT_CONFIG_MISSING',
      'PAYER_SECRET is not a valid Stellar ed25519 secret seed (expected 56 chars starting with S).'
    );
  }
  if (!String(cfg.network).startsWith('stellar:')) {
    return fail('STELLARSIGHT_UNSUPPORTED_NETWORK', `Only Stellar CAIP-2 networks are supported, got "${cfg.network}".`);
  }
  if (cfg.network === 'stellar:pubnet') {
    return fail(
      'STELLARSIGHT_UNSUPPORTED_NETWORK',
      'STELLARSIGHT is testnet-only in this build; refusing to sign on stellar:pubnet.'
    );
  }

  const key = `${cfg.network}|${cfg.rpcUrl}|${cfg.payerSecret.slice(0, 8)}`;
  if (clientCache.has(key)) return clientCache.get(key);

  try {
    // createEd25519Signer takes the raw S... seed + the CAIP-2 network id.
    const signer = createEd25519Signer(cfg.payerSecret, cfg.network);
    const scheme = new ExactStellarScheme(signer, { url: cfg.rpcUrl });
    const client = new x402Client().register(cfg.network, scheme);
    const httpClient = new x402HTTPClient(client);
    const built = { ok: true, client, httpClient, address: signer.address };
    clientCache.set(key, built);
    return built;
  } catch (err) {
    return fail('STELLARSIGHT_CONFIG_MISSING', `Could not build the Stellar signer: ${errText(err)}`);
  }
}

const errText = (e) => (e instanceof Error ? e.message : String(e ?? 'unknown error'));

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function withParams(url, params, method) {
  const u = new URL(url);
  if (params && typeof params === 'object' && !Array.isArray(params) && method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  return u.toString();
}

async function readBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json') || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Amount on the wire is `amount`; bazaar records call it `maxAmountRequired`. */
export function requirementAmount(req) {
  return String(req?.amount ?? req?.maxAmountRequired ?? '0');
}

/** Map a facilitator/seller failure string onto our enum. Always yields a code. */
export function classifySettleFailure(reasonText) {
  const r = String(reasonText || '').toLowerCase();
  if (/replay|already (used|paid|settled|attempted)|duplicate|nonce/.test(r)) return 'STELLARSIGHT_REPLAY_REJECTED';
  if (/expire|expired|too late|ledger bounds|timebound|time bound|stale/.test(r)) return 'STELLARSIGHT_AUTH_EXPIRED';
  if (/insufficient|balance|underfunded|trustline|no trust/.test(r)) return 'STELLARSIGHT_INSUFFICIENT_BALANCE';
  return 'STELLARSIGHT_SETTLE_FAILED';
}

const looksLikeTxHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */
/**
 * Perform an x402-paid HTTP call.
 *
 * @param {string} url                     resource URL
 * @param {object} [opts]
 * @param {object} [opts.params]           query params (GET) or JSON body (POST/PUT/PATCH)
 * @param {string} [opts.method="GET"]
 * @param {object} [opts.headers]
 * @param {string} [opts.maxPrice]         budget ceiling in atomic units; refuse above it
 * @param {number} [opts.timeoutMs=30000]
 * @param {string} [opts.forcePaymentHeader]  send this exact PAYMENT-SIGNATURE instead of signing
 *                                            fresh (used by the replay-guard test)
 * @param {boolean} [opts.signOnly]        stop after signing and return the header without
 *                                            settling. The adversarial demonstrations need a
 *                                            VALID, UNSPENT authorization entry to mutate: one
 *                                            taken from a completed payment carries a consumed
 *                                            nonce, so every attack built on it is refused for
 *                                            replay before the property under test is ever
 *                                            reached — and is then reported as proving that
 *                                            property. Nothing is charged on this path.
 * @param {(e:{stage:string,[k:string]:any})=>void} [opts.onEvent]  narration hook for the CLI
 * @param {object} [opts.config]           config overrides (PAYER_SECRET, STELLAR_RPC_URL, ...)
 * @returns {Promise<{ok:boolean,status:number,body:any,txHash:string|null,explorerUrl:string|null,
 *                    timings:{challengeMs:number,signMs:number,settleMs:number,totalMs:number},
 *                    code?:string, reason?:string}>}
 */
export async function payAndFetch(url, opts = {}) {
  const t0 = Date.now();
  const timings = { challengeMs: 0, signMs: 0, settleMs: 0, totalMs: 0 };
  const emit = (e) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* narration must never break the loop */
    }
  };
  const done = (result) => {
    timings.totalMs = Date.now() - t0;
    return { txHash: null, explorerUrl: null, status: 0, body: null, ...result, timings };
  };

  const method = String(opts.method || 'GET').toUpperCase();
  const timeoutMs = Number(opts.timeoutMs ?? 30000);

  if (!url || typeof url !== 'string') {
    return done(fail('STELLARSIGHT_BAD_REQUEST', 'A `url` string is required.'));
  }
  let target;
  try {
    target = withParams(url, opts.params, method);
  } catch {
    return done(fail('STELLARSIGHT_BAD_REQUEST', `"${url}" is not a valid absolute URL.`));
  }

  const cfg = loadConfig(opts.config || {});
  const built = buildPaymentClient(cfg);
  if (!built.ok) return done(built);
  const { client, httpClient, address } = built;

  const baseHeaders = { accept: 'application/json', ...(opts.headers || {}) };
  const baseInit = { method, headers: baseHeaders };
  if (method !== 'GET' && method !== 'HEAD' && opts.params) {
    baseInit.body = JSON.stringify(opts.params);
    baseHeaders['content-type'] = 'application/json';
  }

  const call = async (extraHeaders) => {
    const init = { ...baseInit, headers: { ...baseHeaders, ...(extraHeaders || {}) } };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
    return fetch(target, init);
  };

  /* -- 1. unpaid probe -> expect 402 ------------------------------- */
  emit({ stage: 'request', url: target, method, payer: address });
  const tChallenge = Date.now();
  let first;
  try {
    first = await call();
  } catch (err) {
    const to = /abort|timeout/i.test(errText(err));
    return done(
      fail(
        to ? 'STELLARSIGHT_TIMEOUT' : 'STELLARSIGHT_RESOURCE_UNREACHABLE',
        to
          ? `The resource did not answer within ${timeoutMs}ms: ${target}`
          : `Could not reach the resource at ${target}: ${errText(err)}`
      )
    );
  }
  timings.challengeMs = Date.now() - tChallenge;

  if (first.status !== 402) {
    const body = await readBody(first);
    if (first.status >= 400) {
      const hint =
        first.status === 404 || first.status === 405
          ? ` The route may require a different HTTP method — call stellarsight_describe on this resource and use ` +
            `howToCall.method (this request used ${method}).`
          : '';
      return done(
        fail('STELLARSIGHT_UPSTREAM_ERROR', `Resource returned HTTP ${first.status} instead of a 402 challenge.${hint}`, {
          status: first.status,
          body
        })
      );
    }
    // Free resource: still a success, just nothing was paid.
    emit({ stage: 'free', status: first.status });
    return done({ ok: true, paid: false, status: first.status, body });
  }

  /* -- 2. parse the challenge -------------------------------------- */
  //
  // Delegate entirely to @x402/core: the `PAYMENT-REQUIRED` header for v2, a JSON body only
  // when it declares `x402Version: 1`. We deliberately add NO fallback beyond that. An
  // earlier version of this file accepted any body carrying an `accepts` array, which made a
  // v2 server that answered with a body alone look payable — and the only server doing that
  // was our own. The leniency hid the bug; removing it means a regression fails loudly here
  // instead of silently passing. See scripts/verify-conformance.mjs.
  let paymentRequired;
  const challengeBody = await readBody(first);
  try {
    paymentRequired = httpClient.getPaymentRequiredResponse((n) => first.headers.get(n), challengeBody);
  } catch (err) {
    return done(
      fail(
        'STELLARSIGHT_402_MALFORMED',
        `The 402 response carried no decodable PAYMENT-REQUIRED header: ${errText(err)}. x402 v2 puts the ` +
          `PaymentRequired object in that header; a JSON body is only read when it declares x402Version 1.`,
        { status: 402, body: challengeBody }
      )
    );
  }

  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  if (accepts.length === 0) {
    return done(
      fail('STELLARSIGHT_402_MALFORMED', 'The 402 challenge listed no `accepts` payment requirements.', { status: 402 })
    );
  }

  const usable = accepts.filter((a) => a?.network === cfg.network && a?.scheme === 'exact');
  if (usable.length === 0) {
    return done(
      fail(
        'STELLARSIGHT_UNSUPPORTED_NETWORK',
        `The resource accepts [${accepts.map((a) => `${a?.scheme}@${a?.network}`).join(', ')}] but this agent is ` +
          `configured for exact@${cfg.network}.`,
        { status: 402 }
      )
    );
  }

  const chosen = usable.reduce((lo, a) =>
    BigInt(requirementAmount(a) || '0') < BigInt(requirementAmount(lo) || '0') ? a : lo
  );
  const price = requirementAmount(chosen);
  emit({
    stage: 'challenge',
    status: 402,
    x402Version: paymentRequired.x402Version,
    accepts,
    chosen,
    price,
    asset: chosen.asset,
    payTo: chosen.payTo,
    challengeMs: timings.challengeMs
  });

  if (opts.maxPrice !== undefined && opts.maxPrice !== null && String(opts.maxPrice) !== '') {
    let over = false;
    try {
      over = BigInt(price) > BigInt(String(opts.maxPrice));
    } catch {
      return done(fail('STELLARSIGHT_BAD_REQUEST', `maxPrice "${opts.maxPrice}" is not an integer atomic amount.`));
    }
    if (over) {
      return done(
        fail(
          'STELLARSIGHT_PRICE_EXCEEDS_BUDGET',
          `The resource asks ${price} atomic units of ${chosen.asset} but the caller's budget is ${opts.maxPrice}.`,
          { status: 402, price, maxPrice: String(opts.maxPrice) }
        )
      );
    }
  }

  /* -- 3. sign the auth entries ------------------------------------ */
  let paymentHeaders;
  let paymentPayload = null;
  const tSign = Date.now();
  if (opts.forcePaymentHeader) {
    // Replay path: deliberately reuse a previously-signed header.
    paymentHeaders = { 'PAYMENT-SIGNATURE': opts.forcePaymentHeader, 'X-PAYMENT': opts.forcePaymentHeader };
    emit({ stage: 'sign', replayed: true });
  } else {
    try {
      paymentPayload = await client.createPaymentPayload(paymentRequired);
      const encoded = httpClient.encodePaymentSignatureHeader(paymentPayload);
      // v2 emits PAYMENT-SIGNATURE; mirror onto X-PAYMENT for v1-shaped sellers.
      const value = encoded['PAYMENT-SIGNATURE'] ?? encoded['X-PAYMENT'];
      paymentHeaders = { ...encoded, 'X-PAYMENT': value };
    } catch (err) {
      const msg = errText(err);
      const code = /insufficient|balance|trustline/i.test(msg) ? 'STELLARSIGHT_INSUFFICIENT_BALANCE' : 'STELLARSIGHT_SIGN_FAILED';
      timings.signMs = Date.now() - tSign;
      return done(
        fail(code, `Could not build/sign the Soroban auth entry for ${price} ${chosen.asset}: ${msg}`, { status: 402 })
      );
    }
  }
  timings.signMs = Date.now() - tSign;
  emit({
    stage: 'signed',
    signMs: timings.signMs,
    payer: address,
    headerBytes: (paymentHeaders['PAYMENT-SIGNATURE'] || '').length
  });

  if (opts.signOnly) {
    return done({
      ok: true,
      paid: false,
      signedOnly: true,
      status: 0,
      body: null,
      payer: address,
      amount: price,
      asset: chosen.asset,
      payTo: chosen.payTo,
      paymentHeader: paymentHeaders['PAYMENT-SIGNATURE'] || null,
      paymentPayload
    });
  }

  /* -- 4. retry with payment -> settlement ------------------------- */
  const tSettle = Date.now();
  let second;
  try {
    second = await call({
      ...paymentHeaders,
      'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE'
    });
  } catch (err) {
    timings.settleMs = Date.now() - tSettle;
    const to = /abort|timeout/i.test(errText(err));
    return done(
      fail(
        to ? 'STELLARSIGHT_TIMEOUT' : 'STELLARSIGHT_RESOURCE_UNREACHABLE',
        to
          ? `Settlement did not complete within ${timeoutMs}ms.`
          : `The paid retry could not reach ${target}: ${errText(err)}`
      )
    );
  }
  timings.settleMs = Date.now() - tSettle;

  const body = await readBody(second);
  let settle = null;
  try {
    settle = httpClient.getPaymentSettleResponse((n) => second.headers.get(n));
  } catch {
    settle = null;
  }

  // Extension responses (bazaar status) ride on their own header per CONTRACT.md.
  let extensions = null;
  const extHeader = second.headers.get('EXTENSION-RESPONSES');
  if (extHeader) {
    try {
      extensions = JSON.parse(Buffer.from(extHeader, 'base64').toString('utf8'));
    } catch {
      extensions = null;
    }
  }

  if (second.status === 402) {
    const why = settle?.errorReason || settle?.errorMessage || body?.error || body?.errorReason;
    const code = classifySettleFailure(why);
    return done(
      fail(
        code,
        why
          ? `The seller rejected the payment: ${why}`
          : 'The seller answered 402 again after payment but gave no errorReason.',
        { status: 402, body, settle, extensions }
      )
    );
  }

  if (settle && settle.success === false) {
    const why = settle.errorReason || settle.errorMessage;
    return done(
      fail(classifySettleFailure(why), `Settlement failed: ${why || 'facilitator reported success=false with no errorReason'}`, {
        status: second.status,
        body,
        settle,
        extensions
      })
    );
  }

  if (second.status >= 400) {
    return done(
      fail('STELLARSIGHT_UPSTREAM_ERROR', `The paid call returned HTTP ${second.status}.`, {
        status: second.status,
        body,
        settle,
        extensions
      })
    );
  }

  const rawTx = settle?.transaction ?? null;
  const txHash = looksLikeTxHash(rawTx) ? rawTx.trim() : rawTx || null;
  const explorerUrl = looksLikeTxHash(txHash) ? explorerFor(txHash, settle?.network || cfg.network) : null;

  emit({ stage: 'settled', txHash, explorerUrl, settleMs: timings.settleMs, payer: settle?.payer || address });

  return done({
    ok: true,
    paid: true,
    status: second.status,
    body,
    txHash,
    explorerUrl,
    payer: settle?.payer || address,
    network: settle?.network || cfg.network,
    amount: price,
    asset: chosen.asset,
    payTo: chosen.payTo,
    settle,
    extensions,
    paymentHeader: paymentHeaders['PAYMENT-SIGNATURE'] || null,
    paymentPayload
  });
}

export default { payAndFetch, ERROR_CODES, loadConfig, explorerFor, fail };
