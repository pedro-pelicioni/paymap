/**
 * The explorer's data layer.
 *
 * Two properties matter more than the happy path, and both are about not overclaiming:
 *
 *   1. A transaction whose operations do not resolve to exactly one transfer is emitted
 *      WITHOUT an amount rather than with a guessed one.
 *   2. A hash with no recorded provenance is `unlabeled`, never `organic`. We cannot
 *      prove a payment came from outside this repo, and a feed that implies we can is
 *      the exact overstatement the labeling exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSettlementFeed, labelRows, KNOWN_LABELS } from '../packages/index/src/settlements.mjs';

const FEEPAYER = 'GC4E5Q6WQATXWA5FCL5OV7C7HVQUZOAGXVKNHNCIL2EDY3YNAGRLKADT';
const SELLER = 'GCWHOZD7PS6EJOJ3EEGDVWPWQKU7RCKRK6WTTQPI5Q3TGX7XLH7GKG3O';
const BUYER = 'GC2ZLSM4VIZV7LSGFFLXGQYUUCLBOTBG3U22FPYI4CIJFBEL6E4UW5AO';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

const transfer = (amount = '0.0100000') => ({
  type: 'transfer',
  from: BUYER,
  to: SELLER,
  amount,
  asset_code: 'SXT',
});

/** A canned Horizon: the transactions page, then a per-hash operations page. */
function horizon({ txs, opsByHash }) {
  return async function fetchImpl(url) {
    if (url.includes('/transactions?')) {
      return { ok: true, status: 200, json: async () => ({ _embedded: { records: txs } }) };
    }
    const hash = /\/transactions\/([0-9a-f]+)\/operations/.exec(url)?.[1];
    const records = opsByHash[hash];
    if (!records) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ _embedded: { records } }) };
  };
}

test('reads the fee-payer account and reports one transfer per settlement', async () => {
  const feed = await fetchSettlementFeed({
    feePayer: FEEPAYER,
    fetchImpl: horizon({
      txs: [{ hash: HASH, created_at: '2026-08-21T06:00:00Z', ledger: 1, successful: true, fee_account: FEEPAYER }],
      opsByHash: { [HASH]: [{ asset_balance_changes: [transfer()] }] },
    }),
  });
  assert.equal(feed.ok, true);
  assert.equal(feed.rows.length, 1);
  assert.equal(feed.rows[0].amount, '0.0100000');
  assert.equal(feed.rows[0].from, BUYER);
  assert.equal(feed.rows[0].to, SELLER);
  assert.match(feed.rows[0].explorerUrl, /stellar\.expert.*a{64}/);
});

test('a transaction with two transfers reports no amount rather than a guess', async () => {
  const feed = await fetchSettlementFeed({
    feePayer: FEEPAYER,
    fetchImpl: horizon({
      txs: [{ hash: HASH, created_at: '2026-08-21T06:00:00Z', successful: true }],
      opsByHash: { [HASH]: [{ asset_balance_changes: [transfer(), transfer('0.0500000')] }] },
    }),
  });
  assert.equal(feed.rows.length, 1, 'the row survives');
  assert.equal(feed.rows[0].amount, null, 'but the amount is absent, not invented');
});

test('a failed transaction is not reported as a settlement', async () => {
  const feed = await fetchSettlementFeed({
    feePayer: FEEPAYER,
    fetchImpl: horizon({
      txs: [{ hash: HASH, successful: false }, { hash: HASH2, successful: true }],
      opsByHash: { [HASH2]: [{ asset_balance_changes: [transfer()] }] },
    }),
  });
  assert.equal(feed.rows.length, 1);
  assert.equal(feed.rows[0].txHash, HASH2);
});

test('an unreachable Horizon is a reasoned failure, not an empty feed', async () => {
  const feed = await fetchSettlementFeed({
    feePayer: FEEPAYER,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(feed.ok, false);
  assert.match(feed.reason, /ECONNREFUSED/);
});

test('no fee-payer configured is refused with a reason', async () => {
  const feed = await fetchSettlementFeed({ feePayer: undefined });
  assert.equal(feed.ok, false);
  assert.ok(feed.reason.trim().length > 0);
});

test('an unrecorded hash is `unlabeled` — never `organic`', () => {
  const [row] = labelRows([{ txHash: HASH, to: SELLER, amount: '0.0100000' }], { provenance: {} });
  assert.equal(row.provenance.label, 'unlabeled');
  assert.equal(row.provenance.source, 'absent');
  assert.ok(!KNOWN_LABELS.includes('organic'), 'there is no organic label to reach for');
});

test('a recorded hash carries the label the script wrote', () => {
  const [row] = labelRows([{ txHash: HASH, to: SELLER, amount: '0.0100000' }], {
    provenance: { [HASH]: { label: 'scripted-load' } },
  });
  assert.equal(row.provenance.label, 'scripted-load');
  assert.equal(row.provenance.source, 'recorded');
});

test('an unknown label in the map degrades to unlabeled rather than being echoed', () => {
  const [row] = labelRows([{ txHash: HASH, to: SELLER, amount: '0.0100000' }], {
    provenance: { [HASH]: { label: 'organic' } },
  });
  assert.equal(row.provenance.label, 'unlabeled', 'the feed does not launder an invented label');
});

test('a listing match is labeled as the heuristic it is', () => {
  const records = [
    { id: 'https://x/1', payTo: SELLER, maxAmountRequired: '100000', resource: { serviceName: 'fx' } },
  ];
  const [row] = labelRows([{ txHash: HASH, to: SELLER, amount: '0.0100000' }], { provenance: {}, records });
  assert.equal(row.listing.serviceName, 'fx');
  assert.equal(row.listing.matchedBy, 'price', 'the UI prints this so an inference is not read as a record');
});

test('a payment to an unknown payee joins to no listing', () => {
  const records = [{ id: 'https://x/1', payTo: SELLER, maxAmountRequired: '100000' }];
  const [row] = labelRows([{ txHash: HASH, to: BUYER, amount: '0.0100000' }], { provenance: {}, records });
  assert.equal(row.listing, null);
});
