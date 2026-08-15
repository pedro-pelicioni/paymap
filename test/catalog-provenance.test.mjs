/**
 * test/catalog-provenance.test.mjs — telling demo breadth from real resources.
 *
 * The catalog ships a demo corpus so the ranker has a realistic spread to rank. That is
 * defensible, and it is also the single easiest thing for a reader to mistake for
 * traction. The defence is not to hide the corpus but to make it separable: every seeded
 * record is flagged, the flag survives the wire projection, and `?seeded=false` answers
 * "what here can actually be paid?" as a query rather than an eyeball count.
 *
 * These tests exist so that separation cannot rot silently — a demo record that loses its
 * flag would quietly start counting as real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCatalog } from '../packages/index/src/index.mjs';
import { seedCatalog, SEED_RECORDS, asSeedRecord } from '../packages/index/src/seed.mjs';
import { listResources, searchResources, toDiscoveryResource } from '../packages/index/src/discovery.mjs';

const seeded = () => {
  const catalog = createCatalog();
  seedCatalog(catalog);
  return catalog;
};

/** A record that looks like a real announcement: no seeded flag, a settlement behind it. */
const liveRecord = (id = 'https://real.test/v1/thing') => ({
  id,
  resource: { url: id, serviceName: 'Real Service', description: 'A resource somebody actually paid for.' },
  type: 'http',
  network: 'stellar:testnet',
  scheme: 'exact',
  payTo: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
  asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  maxAmountRequired: '10000',
  extensions: ['bazaar'],
  lastSeenAt: Date.now(),
  settlements: 1,
});

test('every seeded record is flagged and pinned to zero settlements', () => {
  const catalog = seeded();
  for (const rec of catalog.all()) {
    assert.equal(rec.seeded, true, `${rec.id} is in the seed corpus but not flagged`);
    assert.equal(rec.settlements, 0, `${rec.id} is a demo record claiming ${rec.settlements} settlements`);
  }
});

test('asSeedRecord cannot be used to smuggle a settlement count', () => {
  const inflated = asSeedRecord({ ...SEED_RECORDS[0], settlements: 900_000 });
  assert.equal(inflated.settlements, 0);
  assert.equal(inflated.seeded, true);
});

test('the seeded flag survives the wire projection', () => {
  const projected = toDiscoveryResource(asSeedRecord(SEED_RECORDS[0]));
  assert.equal(projected.seeded, true, 'a spec client can no longer tell demo from real');
});

test('a live record carries no seeded flag', () => {
  const projected = toDiscoveryResource(liveRecord());
  assert.equal(projected.seeded, undefined);
});

test('seeded=false returns only what can actually be paid', () => {
  const catalog = seeded();
  const demoCount = catalog.size();
  catalog.upsert(liveRecord());

  const { body } = listResources(catalog, { seeded: 'false', limit: '100' });
  assert.equal(body.total, 1, 'exactly the one real resource');
  assert.equal(body.items[0].resource, 'https://real.test/v1/thing');

  const all = listResources(catalog, { limit: '100' });
  assert.equal(all.body.total, demoCount + 1, 'the default listing still returns everything');
});

test('seeded=true returns only the demo corpus', () => {
  const catalog = seeded();
  const demoCount = catalog.size();
  catalog.upsert(liveRecord());

  const { body } = listResources(catalog, { seeded: 'true', limit: '100' });
  assert.equal(body.total, demoCount);
  assert.ok(body.items.every((i) => i.seeded === true));
});

test('the filter applies to search, not only to listing', () => {
  const catalog = seeded();
  catalog.upsert({
    ...liveRecord('https://real.test/v1/fx'),
    resource: { url: 'https://real.test/v1/fx', serviceName: 'Real FX', description: 'usd brl exchange rate' },
  });

  const unfiltered = searchResources(catalog, { query: 'usd brl exchange rate', limit: '20' });
  assert.ok(unfiltered.body.resources.length > 1, 'the demo corpus also matches this query');

  const live = searchResources(catalog, { query: 'usd brl exchange rate', seeded: 'false', limit: '20' });
  assert.equal(live.body.resources.length, 1, 'only the payable resource survives the filter');
  assert.equal(live.body.resources[0].resource, 'https://real.test/v1/fx');
});

test('an absent filter changes nothing — the default stays "show everything"', () => {
  const catalog = seeded();
  const withUndefined = listResources(catalog, { seeded: undefined, limit: '100' });
  const without = listResources(catalog, { limit: '100' });
  assert.equal(withUndefined.body.total, without.body.total);
  assert.equal(without.body.total, catalog.size());
});

test('a real resource that shares an id with a seed record clears the flag', () => {
  // This is the promotion path: the demo entry is a placeholder until someone announces
  // the real thing, and the moment they do it must stop being labelled a demo.
  const catalog = seeded();
  const seedId = catalog.all().find((r) => r.seeded)?.id;
  assert.ok(seedId, 'expected at least one seeded record');

  catalog.upsert({ ...liveRecord(seedId), id: seedId });
  const promoted = catalog.get(seedId);
  assert.notEqual(promoted.seeded, true, 'the record is still labelled a demo after a real announcement');
});
