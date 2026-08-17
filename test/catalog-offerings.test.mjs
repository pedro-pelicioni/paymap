/**
 * Offerings: one resource, several priced ways to call it.
 *
 * Regression suite for issue #1 — the single-tuple record model silently replaced
 * a whole listing when a second payment profile for the same resource arrived.
 * The fix keys offerings by CONTENT (scheme|network|asset|payTo|canonical extra),
 * deliberately not by a semantic profile field: the upstream spec has not named
 * the discriminator yet (extra.uptoProfile is still in open PRs), and a content
 * key loses nothing no matter where that discriminator lands. When it lands, the
 * key can tighten — these tests pin that nothing is lost in the meantime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCatalog, offeringKeyOf, canonicalJson } from '../packages/index/src/index.mjs';
import { toDiscoveryResource } from '../packages/index/src/discovery.mjs';

const URL_ = 'https://api.example.com/v1/metered';
const base = () => ({
  resource: { url: URL_, serviceName: 'metered-svc', description: 'metered resource' },
  type: 'http',
  network: 'stellar:testnet',
  scheme: 'upto',
  payTo: 'GPAYTO0000000000000000000000000000000000000000000000000',
  asset: 'CASSET000000000000000000000000000000000000000000000000',
  input: { type: 'http', method: 'GET' },
  extensions: ['bazaar'],
});

test('two upto profiles of one resource coexist instead of overwriting (issue #1)', () => {
  const cat = createCatalog();
  const a = cat.upsert({ ...base(), maxAmountRequired: '10000000', extra: { uptoProfile: 'contract' } });
  const b = cat.upsert({ ...base(), maxAmountRequired: '5000000', extra: { uptoProfile: 'stateless' } });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(cat.size(), 1, 'still one resource');

  const rec = cat.get(URL_);
  assert.equal(rec.requirements.length, 2, 'both offerings stored');
  const ceilings = rec.requirements.map((o) => o.maxAmountRequired).sort();
  assert.deepEqual(ceilings, ['10000000', '5000000'].sort());
  // mirrors track the most recently seen offering
  assert.equal(rec.maxAmountRequired, '5000000');
  assert.deepEqual(rec.extra, { uptoProfile: 'stateless' });
});

test('the wire emits one accepts entry per offering, mirror first', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), maxAmountRequired: '10000000', extra: { uptoProfile: 'contract' } });
  cat.upsert({ ...base(), maxAmountRequired: '5000000', extra: { uptoProfile: 'stateless' } });

  const wire = toDiscoveryResource(cat.get(URL_));
  assert.equal(wire.accepts.length, 2);
  // accepts[0] is the offering the native mirrors track
  assert.equal(wire.accepts[0].amount, wire.maxAmountRequired);
  assert.deepEqual(wire.accepts[0].extra, { uptoProfile: 'stateless' });
  assert.deepEqual(wire.accepts[1].extra, { uptoProfile: 'contract' });
  for (const entry of wire.accepts) {
    for (const k of ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra']) {
      assert.ok(k in entry, `accepts entry carries ${k}`);
    }
  }
});

test('re-seeing the same offering is a price update, not an accumulation', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), maxAmountRequired: '10000000', extra: { uptoProfile: 'contract' } });
  cat.upsert({ ...base(), maxAmountRequired: '12000000', extra: { uptoProfile: 'contract' } });

  const rec = cat.get(URL_);
  assert.equal(rec.requirements.length, 1, 'same offering replaced in place');
  assert.equal(rec.requirements[0].maxAmountRequired, '12000000');
  assert.equal(toDiscoveryResource(rec).accepts.length, 1);
});

test('a price update with no extra at all keeps the old single-tuple semantics', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), maxAmountRequired: '10000000' });
  cat.upsert({ ...base(), maxAmountRequired: '5000000' });

  const rec = cat.get(URL_);
  assert.equal(rec.requirements.length, 1);
  assert.equal(rec.maxAmountRequired, '5000000');
});

test('exact alongside upto for the same resource coexists', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), scheme: 'exact', maxAmountRequired: '300000' });
  cat.upsert({ ...base(), scheme: 'upto', maxAmountRequired: '10000000' });

  const rec = cat.get(URL_);
  assert.equal(rec.requirements.length, 2);
  assert.deepEqual(rec.requirements.map((o) => o.scheme).sort(), ['exact', 'upto']);
});

test('requirement filters match ANY offering, not only the mirrored latest', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), scheme: 'upto', maxAmountRequired: '10000000' });
  cat.upsert({ ...base(), scheme: 'exact', maxAmountRequired: '300000' });

  // mirror is now exact; the upto offering must still be discoverable
  assert.equal(cat.get(URL_).scheme, 'exact');
  assert.equal(cat.list({ scheme: 'upto' }).total, 1);
  assert.equal(cat.list({ scheme: 'exact' }).total, 1);
  assert.equal(cat.list({ scheme: 'nonexistent' }).total, 0);
});

test('hostile extra is soft-dropped: the field dies, the listing survives', () => {
  const cat = createCatalog();
  const big = { pad: 'x'.repeat(4096) };
  const r1 = cat.upsert({ ...base(), maxAmountRequired: '1', extra: big });
  assert.equal(r1.ok, true);
  assert.ok(r1.dropped.includes('extra'), 'oversized extra reported as dropped');
  assert.equal(cat.get(URL_).extra, undefined);

  const r2 = cat.upsert({ ...base(), maxAmountRequired: '2', extra: 'not-an-object' });
  assert.equal(r2.ok, true);
  assert.ok(r2.dropped.includes('extra'));
});

test('offering identity survives a JSON round trip (durable-store proxy)', () => {
  const cat = createCatalog();
  cat.upsert({ ...base(), maxAmountRequired: '10000000', extra: { uptoProfile: 'contract' } });
  cat.upsert({ ...base(), maxAmountRequired: '5000000', extra: { uptoProfile: 'stateless' } });

  const thawed = JSON.parse(JSON.stringify(cat.get(URL_)));
  assert.equal(toDiscoveryResource(thawed).accepts.length, 2);

  // and a rehydrating catalog keeps merging correctly on top of the thawed record
  const cat2 = createCatalog();
  cat2.upsert(thawed);
  cat2.upsert({ ...base(), maxAmountRequired: '7000000', extra: { uptoProfile: 'contract' } });
  const rec2 = cat2.get(URL_);
  assert.equal(rec2.requirements.length, 2, 'round trip did not duplicate offerings');
  const contract = rec2.requirements.find((o) => o.extra?.uptoProfile === 'contract');
  assert.equal(contract.maxAmountRequired, '7000000');
});

test('a record stored before requirements existed still projects one accepts entry', () => {
  const legacy = {
    id: URL_,
    resource: { url: URL_, serviceName: 'legacy' },
    type: 'http',
    network: 'stellar:testnet',
    scheme: 'exact',
    payTo: 'GLEGACY',
    asset: 'CLEGACY',
    maxAmountRequired: '42',
    lastSeenAt: 1,
    settlements: 0,
  };
  const wire = toDiscoveryResource(legacy);
  assert.equal(wire.accepts.length, 1);
  assert.equal(wire.accepts[0].amount, '42');
});

test('offeringKeyOf is order-insensitive in extra and price-insensitive', () => {
  const k1 = offeringKeyOf({ scheme: 'upto', network: 'n', asset: 'a', payTo: 'p', maxAmountRequired: '1', extra: { b: 2, a: 1 } });
  const k2 = offeringKeyOf({ scheme: 'upto', network: 'n', asset: 'a', payTo: 'p', maxAmountRequired: '999', extra: { a: 1, b: 2 } });
  assert.equal(k1, k2);
  assert.equal(canonicalJson({ b: { d: 4, c: 3 }, a: 1 }), '{"a":1,"b":{"c":3,"d":4}}');
});
