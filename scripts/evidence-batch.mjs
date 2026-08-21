#!/usr/bin/env node
/**
 * STELLARSIGHT — scripted settlement batch.
 *
 * Settles N real payments across the seller's priced routes and records every hash with
 * the label `scripted-load`. The label is the point.
 *
 * A settlement count is only evidence if the reader knows what produced it. Published
 * x402 volume on Stellar today is dominated by soak tests and self-payments that are
 * presented, unlabeled, as adoption. This script generates volume too — it is a script,
 * it pays our own seller — so it writes down that that is what happened: the batch lands
 * in docs/status/batch-<date>.json under `label: "scripted load — not organic traffic"`,
 * every hash enters docs/status/provenance.json as `scripted-load`, and the rows appended
 * to docs/TESTNET-TXS.md carry a `load:` prefix so the console's replay pool (which
 * matches `demo:`/`conformance:`) never picks them up and the explorer renders them amber.
 *
 * SERIAL, deliberately. docs/LOAD-BASELINE.md already publishes what this stack does
 * under concurrency — 1/10 at concurrency 10, one fee-payer, one sequence number — and
 * this is not a second attempt at that measurement. It is breadth: many payments, several
 * payers, every route, each one settled and checkable. Running it in parallel would
 * measure the bottleneck we already published instead of producing the evidence.
 *
 * Usage:
 *   node scripts/evidence-batch.mjs                 # 50 payments, 1 payer (from .env)
 *   node scripts/evidence-batch.mjs --count 20
 *   node scripts/evidence-batch.mjs --count 50 --payers 3   # creates 2 extra payers in-run
 *   node scripts/evidence-batch.mjs --count 6 --dry-run     # no payments; prints the plan
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { payAndFetch, loadConfig } from '../apps/agent/src/pay.mjs';
import { writeEvidence, updateProvenance, appendTxRows } from './lib/evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const COUNT = Math.max(1, Number.parseInt(arg('count', '50'), 10) || 50);
const PAYERS = Math.max(1, Number.parseInt(arg('payers', '1'), 10) || 1);
const DRY = process.argv.includes('--dry-run');
/** A short pause between payments: one fee-payer, one sequence number (LOAD-BASELINE.md). */
const GAP_MS = Math.max(0, Number.parseInt(arg('gap-ms', '400'), 10) || 0);

/**
 * The seller's three priced routes, rotated so the batch covers all of them — each with
 * the method and payload it actually takes. `/v1/ocr/nota-fiscal` is a POST with a JSON
 * body; calling it as a GET answers 404, not a 402 challenge, which is a batch failure
 * that says nothing about the payment path.
 */
const ROUTES = [
  { path: '/v1/fx/usd-brl', method: 'GET', params: {} },
  { path: '/v1/cep/01310100', method: 'GET', params: {} },
  {
    path: '/v1/ocr/nota-fiscal',
    method: 'POST',
    params: { imageUrl: 'https://example.com/invoice.png', language: 'pt-BR' },
  },
];

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function main() {
  const cfg = loadConfig({});

  console.log('\nSTELLARSIGHT — scripted settlement batch');
  console.log(`  seller       ${cfg.sellerUrl}`);
  console.log(`  facilitator  ${cfg.facilitatorUrl}`);
  console.log(`  payments     ${COUNT} across ${ROUTES.length} route(s), serial, ${GAP_MS}ms apart`);
  console.log(`  routes       ${ROUTES.map((r) => `${r.method} ${r.path}`).join(', ')}`);
  console.log(`  label        scripted-load — this is our own script paying our own seller\n`);

  if (PAYERS > 1) {
    // Extra payers would need funding + a trustline + SXT before they can pay, which is
    // scripts/setup-testnet.mjs's job. Rather than half-implement it here and produce a
    // batch whose "3 payers" is really one payer plus two failures, say so and continue
    // with the configured payer.
    console.log(
      `  note: --payers ${PAYERS} needs funded accounts with an SXT trustline; this batch uses the\n` +
        `        configured PAYER only. Create and fund additional payers with scripts/setup-testnet.mjs\n` +
        `        and re-run with PAYER_SECRET pointing at each.\n`,
    );
  }

  if (DRY) {
    for (let i = 0; i < COUNT; i++) {
      const r = ROUTES[i % ROUTES.length];
      console.log(`  [dry] ${i + 1}/${COUNT} ${r.method} ${r.path}`);
    }
    console.log('\n  --dry-run: nothing was paid.\n');
    return 0;
  }

  const results = [];
  const startedAt = new Date().toISOString();

  for (let i = 0; i < COUNT; i++) {
    const r = ROUTES[i % ROUTES.length];
    const target = `${cfg.sellerUrl}${r.path}`;
    process.stdout.write(`  ${String(i + 1).padStart(3)}/${COUNT} ${r.path.padEnd(24)} `);
    const out = await payAndFetch(target, {
      method: r.method,
      // `_b` distinguishes otherwise identical calls in the seller's log without
      // changing what is bought.
      params: { ...r.params, _b: String(i) },
    });
    if (out.ok) {
      console.log(`ok ${String(Math.round(out.timings?.totalMs ?? 0)).padStart(5)}ms  ${out.txHash?.slice(0, 12)}…`);
      results.push({ ok: true, route: r.path, txHash: out.txHash, totalMs: out.timings?.totalMs ?? null, settleMs: out.timings?.settleMs ?? null });
    } else {
      console.log(`FAIL ${out.code}: ${String(out.reason).slice(0, 80)}`);
      results.push({ ok: false, route: r.path, code: out.code, reason: out.reason });
    }
    if (i < COUNT - 1 && GAP_MS) await sleep(GAP_MS);
  }

  /* ── aggregate ─────────────────────────────────────────────────────────── */

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const latencies = succeeded.map((r) => r.totalMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);

  const perRoute = {};
  for (const r of results) {
    perRoute[r.route] ??= { attempted: 0, settled: 0 };
    perRoute[r.route].attempted++;
    if (r.ok) perRoute[r.route].settled++;
  }

  // One artifact per RUN, not per day: a second batch on the same date must not overwrite
  // the first, or provenance.json ends up listing hashes that no batch file accounts for.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const name = `batch-${stamp}`;

  const { path } = writeEvidence(
    name,
    {
      label: 'scripted load — not organic traffic',
      note:
        'Generated by scripts/evidence-batch.mjs: this repo paying its own seller, serially. ' +
        'Counted as breadth of settlement, never as adoption or demand.',
      startedAt,
      payer: succeeded.length ? 'configured PAYER (see docs/TESTNET-TXS.md)' : null,
      concurrency: 1,
      gapMs: GAP_MS,
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      perRoute,
      latenciesMs: {
        p50: pct(latencies, 50),
        p95: pct(latencies, 95),
        min: latencies[0] ?? null,
        max: latencies[latencies.length - 1] ?? null,
      },
      hashes: succeeded.map((r) => ({ hash: r.txHash, route: r.route, totalMs: r.totalMs })),
      failures: failed.map((r) => ({ route: r.route, code: r.code, reason: r.reason })),
    },
    { kind: 'scripted-load' },
  );

  if (succeeded.length) {
    updateProvenance(
      Object.fromEntries(succeeded.map((r) => [r.txHash, { label: 'scripted-load', run: process.env.GITHUB_RUN_ID ?? null }])),
    );
    appendTxRows(succeeded.map((r) => ({ step: `load: ${r.route} (scripted batch)`, hash: r.txHash })));
  }

  console.log(`\n  settled   ${succeeded.length}/${results.length}`);
  console.log(`  latency   p50 ${Math.round(pct(latencies, 50) ?? 0)}ms · p95 ${Math.round(pct(latencies, 95) ?? 0)}ms`);
  for (const [route, s] of Object.entries(perRoute)) console.log(`  ${route.padEnd(24)} ${s.settled}/${s.attempted}`);
  console.log(`\n  evidence  ${path.replace(`${ROOT}/`, '')}`);
  console.log(`  appended  ${succeeded.length} row(s) to docs/TESTNET-TXS.md, labeled "load:"\n`);

  return failed.length && !succeeded.length ? 1 : 0;
}

process.exit(await main());
