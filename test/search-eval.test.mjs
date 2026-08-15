/**
 * test/search-eval.test.mjs — the evaluation harness itself is tested.
 *
 * A published nDCG is only worth the arithmetic behind it. If `ndcgAt` were subtly wrong
 * — a 0-based discount, IDCG taken from the retrieved set instead of the ideal one — the
 * number in the README would be confidently false and nothing would catch it. So the
 * metrics are checked against hand-computed values, and the golden set is checked for the
 * two ways it can rot: a judged id that no longer exists, and a duplicate query id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCatalog } from '../packages/index/src/index.mjs';
import { seedCatalog } from '../packages/index/src/seed.mjs';
import { loadGolden, ndcgAt, recallAt, reciprocalRankAt, runEval } from '../scripts/eval-search.mjs';

/* ─────────────────────────── metric arithmetic ─────────────────────────── */

test('ndcg: a perfect ranking scores exactly 1', () => {
  const rel = { a: 3, b: 2, c: 1 };
  assert.equal(ndcgAt(['a', 'b', 'c'], rel, 10), 1);
});

test('ndcg: reversing a perfect ranking scores strictly less than 1', () => {
  const rel = { a: 3, b: 2, c: 1 };
  const reversed = ndcgAt(['c', 'b', 'a'], rel, 10);
  assert.ok(reversed < 1, `expected < 1, got ${reversed}`);
  assert.ok(reversed > 0, 'a reversed but complete ranking still has gain');
});

test('ndcg: hand-computed value, exponential gain and log2(rank+1) discount', () => {
  // One relevant document at grade 3, retrieved second.
  //   DCG  = (2^3 - 1) / log2(3) = 7 / 1.584962... = 4.416508...
  //   IDCG = (2^3 - 1) / log2(2) = 7
  //   nDCG = 0.630929...
  const got = ndcgAt(['miss', 'hit'], { hit: 3 }, 10);
  assert.ok(Math.abs(got - 7 / Math.log2(3) / 7) < 1e-12, `got ${got}`);
  assert.ok(Math.abs(got - 0.6309297535714574) < 1e-9, `got ${got}`);
});

test('ndcg: documents past the cut-off contribute nothing', () => {
  const rel = { hit: 3 };
  assert.equal(ndcgAt(['a', 'b', 'c', 'hit'], rel, 3), 0);
  assert.ok(ndcgAt(['a', 'b', 'c', 'hit'], rel, 4) > 0);
});

test('ndcg: a query with no judged document is null, never 0', () => {
  // Scoring it 0 would drag the mean down for a query that has no right answer at all.
  assert.equal(ndcgAt(['a'], {}, 10), null);
});

test('recall: counts only grade >= 2, and only inside the cut-off', () => {
  const rel = { a: 3, b: 2, marginal: 1 };
  assert.equal(recallAt(['a', 'b'], rel, 20), 1, 'both answers found');
  assert.equal(recallAt(['a'], rel, 20), 0.5, 'one of two answers found');
  assert.equal(recallAt(['marginal'], rel, 20), 0, 'grade 1 is not an answer');
  assert.equal(recallAt(['x', 'x', 'a'], rel, 2), 0, 'a hit past the cut-off does not count');
});

test('reciprocal rank: 1/rank of the first real answer, 0 when there is none', () => {
  const rel = { good: 3, marginal: 1 };
  assert.equal(reciprocalRankAt(['good'], rel, 10), 1);
  assert.equal(reciprocalRankAt(['x', 'good'], rel, 10), 0.5);
  assert.equal(reciprocalRankAt(['x', 'x', 'good'], rel, 10), 1 / 3);
  assert.equal(reciprocalRankAt(['marginal', 'x'], rel, 10), 0, 'grade 1 does not stop the scan');
  assert.equal(reciprocalRankAt(['x', 'y'], rel, 10), 0);
});

/* ─────────────────────────── golden-set hygiene ─────────────────────────── */

test('golden set: every judged id exists in the seeded catalog', () => {
  const catalog = createCatalog();
  seedCatalog(catalog);
  const golden = loadGolden();
  for (const q of golden) {
    for (const id of Object.keys(q.relevant ?? {})) {
      assert.ok(catalog.get(id), `query ${q.id} judges "${id}", which is not in the catalog`);
    }
  }
});

test('golden set: query ids are unique and every entry has a non-empty query', () => {
  const golden = loadGolden();
  const seen = new Set();
  for (const q of golden) {
    assert.ok(typeof q.query === 'string' && q.query.trim().length > 0, `${q.id} has no query`);
    assert.ok(!seen.has(q.id), `duplicate golden id ${q.id}`);
    seen.add(q.id);
  }
  assert.ok(golden.length >= 50, `expected at least 50 graded queries, got ${golden.length}`);
});

test('golden set: grades are integers in 0..3', () => {
  for (const q of loadGolden()) {
    for (const [id, grade] of Object.entries(q.relevant ?? {})) {
      assert.ok(Number.isInteger(grade) && grade >= 0 && grade <= 3, `${q.id} grades ${id} as ${grade}`);
    }
  }
});

test('golden set: includes no-match probes, so silence is measured rather than assumed', () => {
  const noMatch = loadGolden().filter((q) => Object.keys(q.relevant ?? {}).length === 0);
  assert.ok(noMatch.length >= 2, `expected at least 2 no-match probes, got ${noMatch.length}`);
});

/* ─────────────────────────────── end to end ─────────────────────────────── */

test('runEval: produces every published metric against the real ranker', () => {
  const run = runEval();
  for (const key of ['ndcgAt10', 'recallAt20', 'mrrAt10', 'precisionAt1']) {
    const v = run.metrics[key];
    assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `${key} is not a ratio: ${v}`);
  }
  assert.equal(run.queries.judged + run.queries.noMatch, run.queries.total);
  assert.ok(run.corpus.records > 0, 'the corpus must not be empty');
});

test('runEval: the ranker beats a shuffled ordering of the same corpus', () => {
  // The floor this asserts is deliberately low. It is not "the ranking is good", it is
  // "the ranking is doing something" — the assertion that would have caught a search
  // silently degraded to catalog order.
  const run = runEval();
  const golden = loadGolden().filter((q) => Object.keys(q.relevant ?? {}).length > 0);
  const catalog = createCatalog();
  seedCatalog(catalog);
  const allIds = catalog.all().map((r) => r.id);

  let randomTotal = 0;
  for (const q of golden) {
    randomTotal += ndcgAt(allIds.slice(0, 20), q.relevant, 10) ?? 0;
  }
  const randomMean = randomTotal / golden.length;
  assert.ok(
    run.metrics.ndcgAt10 > randomMean * 1.5,
    `ranker nDCG@10 ${run.metrics.ndcgAt10} is not meaningfully above unranked catalog order ${randomMean.toFixed(4)}`,
  );
});
