#!/usr/bin/env node
/**
 * scripts/load-baseline.mjs — measure what ONE fee-payer account can actually do.
 *
 * WHY THIS EXISTS
 *
 * The facilitator today signs and fee-bumps every settlement from a single FEEPAYER
 * account. Stellar gives each account one sequence number, so concurrent settlements from
 * one source do not run concurrently — they queue, and under enough load they collide
 * (`tx_bad_seq`) or get throttled (`TRY_AGAIN_LATER`). A channel-account pool is the fix,
 * and it is the first funded deliverable of Tranche 1.
 *
 * A deliverable that says "settlement got faster" is worth nothing without the number it
 * got faster THAN. This script produces that number, before the pool exists, from the
 * configuration actually deployed. It is the honest "before".
 *
 * WHAT IT DOES
 *
 *   1. One warm-up payment, serially, to prove the stack is live and to time the
 *      uncontended path. That is the floor: no amount of concurrency beats it.
 *   2. N payments fired at once through the same facilitator, each a real 402 -> sign ->
 *      settle -> 200 against the reference seller, using the same @x402/fetch client path
 *      the conformance harness drives.
 *   3. Latency distribution, throughput, and a breakdown of every failure — with
 *      sequence-number contention counted separately from everything else, because that
 *      is the specific thing the pool is meant to remove.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not simulate. It needs a running stack (`npm run dev:all`) and a funded testnet
 * FEEPAYER, and it spends real testnet fees — which is the point: numbers from a mock
 * would not survive a reviewer running this themselves.
 *
 * USAGE
 *   npm run load:baseline                 # 10 concurrent, the default
 *   npm run load:baseline -- -n 25        # 25 concurrent
 *   npm run load:baseline -- -n 25 --report
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { payAndFetch, loadConfig } from '../apps/agent/src/pay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'eval', 'load-baseline.json');
const REPORT_PATH = join(ROOT, 'docs', 'LOAD-BASELINE.md');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.findIndex((a) => a === name || a === name.replace(/^--/, '-'));
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CONCURRENCY = Math.max(1, Number(flag('--concurrent', flag('-n', '10'))) || 10);
const WRITE_REPORT = argv.includes('--report');

/**
 * Failures that mean "one account, many transactions" rather than "the payment was wrong".
 *
 * The first alternatives are the explicit Stellar result codes. The last one is not
 * self-evidently about sequencing and is included deliberately: `@x402/stellar` collapses
 * a rejected submission into `settle_exact_stellar_transaction_submission_failed` without
 * surfacing the underlying `tx_bad_seq`, so on the evidence of the message alone the
 * cause is unknowable.
 *
 * That is why this script does not classify by message alone. It runs a SERIAL CONTROL
 * GROUP of identical payments first. If the same payments succeed one-at-a-time and fail
 * in parallel, the difference is concurrency — not the payment, not the asset, not the
 * network. The control group is what earns the attribution; the regex only labels it.
 */
const CONTENTION = /bad_seq|badseq|sequence|try_again_later|tx_insufficient_fee|rate.?limit|429|transaction_submission_failed/i;

/** How many payments the serial control group makes. Small: it is a control, not a load test. */
const CONTROL_N = 4;

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};
const ms = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)}ms`);

async function main() {
  const cfg = loadConfig({});
  const target = `${cfg.sellerUrl}/v1/fx/usd-brl`;

  console.log('\nSTELLARSIGHT load baseline — single fee-payer, no channel pool');
  console.log(`  facilitator  ${cfg.facilitatorUrl}`);
  console.log(`  seller       ${target}`);
  console.log(`  concurrency  ${CONCURRENCY}\n`);

  /* 1. warm-up: the uncontended floor -------------------------------------- */
  process.stdout.write('  warm-up (serial, 1 payment) ... ');
  const warm = await payAndFetch(target, { params: {} });
  if (!warm.ok) {
    console.error(`FAILED\n\n  ${warm.code}: ${warm.reason}\n`);
    console.error('  The stack must be running and the FEEPAYER funded:');
    console.error('    npm run setup && npm run dev:all\n');
    return 1;
  }
  console.log(`ok in ${ms(warm.timings.totalMs)} (settle ${ms(warm.timings.settleMs)}) tx ${warm.txHash?.slice(0, 12)}…`);

  /* 2. serial control group ------------------------------------------------- */
  // The experiment that makes the whole measurement attributable: the SAME payments,
  // one at a time. Whatever fails here is broken for reasons that have nothing to do
  // with concurrency, and must not be charged to it.
  process.stdout.write(`  serial control (${CONTROL_N} payments, one at a time) ... `);
  const serial = [];
  const serialStart = Date.now();
  for (let i = 0; i < CONTROL_N; i++) {
    serial.push(await payAndFetch(target, { params: { _c: String(i) } }));
  }
  const serialWallMs = Date.now() - serialStart;
  const serialOk = serial.filter((r) => r.ok);
  console.log(`${serialOk.length}/${CONTROL_N} succeeded in ${ms(serialWallMs)}`);

  /* 3. the contended run ---------------------------------------------------- */
  process.stdout.write(`  firing ${CONCURRENCY} concurrent payments ... `);
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      payAndFetch(target, { params: { _n: String(i) } }).then(
        (r) => ({ ...r, i }),
        (err) => ({ ok: false, i, code: 'THREW', reason: String(err?.message ?? err), timings: { totalMs: 0, settleMs: 0 } }),
      ),
    ),
  );
  const wallMs = Date.now() - startedAt;
  console.log(`done in ${ms(wallMs)}\n`);

  /* 3. what happened -------------------------------------------------------- */
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const contended = failed.filter((r) => CONTENTION.test(`${r.code} ${r.reason}`));
  const other = failed.filter((r) => !CONTENTION.test(`${r.code} ${r.reason}`));

  const totals = ok.map((r) => r.timings.totalMs).sort((a, b) => a - b);
  const settles = ok.map((r) => r.timings.settleMs).filter(Boolean).sort((a, b) => a - b);

  const serialSuccessRate = serialOk.length / CONTROL_N;
  const concurrentSuccessRate = ok.length / CONCURRENCY;

  const summary = {
    generatedAt: new Date().toISOString(),
    configuration: {
      feePayers: 1,
      channelPool: false,
      note: 'single FEEPAYER account signs and fee-bumps every settlement; one sequence number for all of them',
      facilitator: cfg.facilitatorUrl,
      network: 'stellar:testnet',
    },
    warmup: { totalMs: warm.timings.totalMs, settleMs: warm.timings.settleMs, tx: warm.txHash },
    // The control group. Identical payments, issued one at a time.
    serialControl: {
      attempted: CONTROL_N,
      succeeded: serialOk.length,
      successRate: Math.round(serialSuccessRate * 100) / 100,
      wallClockMs: serialWallMs,
      p50Ms: pct(serialOk.map((r) => r.timings.totalMs).sort((a, b) => a - b), 50),
      transactions: serialOk.map((r) => r.txHash).filter(Boolean),
    },
    run: {
      concurrency: CONCURRENCY,
      wallClockMs: wallMs,
      succeeded: ok.length,
      failed: failed.length,
      sequenceContention: contended.length,
      otherFailures: other.length,
      throughputPerMin: ok.length ? Math.round((ok.length / wallMs) * 60_000) : 0,
      successRate: Math.round(concurrentSuccessRate * 100) / 100,
    },
    // The finding, stated as the comparison that produced it rather than as an assertion.
    attribution: {
      serialSuccessRate: Math.round(serialSuccessRate * 100) / 100,
      concurrentSuccessRate: Math.round(concurrentSuccessRate * 100) / 100,
      concurrencyPenalty: Math.round((serialSuccessRate - concurrentSuccessRate) * 100) / 100,
      conclusion:
        serialSuccessRate > concurrentSuccessRate + 0.2
          ? 'Identical payments succeed serially and fail in parallel. The difference is contention on the single fee-payer sequence number, which is what a channel-account pool removes.'
          : 'No material difference between serial and concurrent success. Sequence contention is NOT the limiting factor at this concurrency.',
    },
    latencyMs: {
      p50: pct(totals, 50),
      p95: pct(totals, 95),
      max: totals[totals.length - 1] ?? null,
      settleP50: pct(settles, 50),
      settleP95: pct(settles, 95),
    },
    // The measurement that justifies the pool: how much slower the SAME payment gets
    // purely because others were in flight.
    contentionFactor: totals.length && warm.timings.totalMs
      ? Math.round((pct(totals, 50) / warm.timings.totalMs) * 100) / 100
      : null,
    failures: failed.map((r) => ({ i: r.i, code: r.code, reason: String(r.reason ?? '').slice(0, 200) })),
    transactions: ok.map((r) => r.txHash).filter(Boolean),
  };

  console.log(`  serial control     ${serialOk.length}/${CONTROL_N} succeeded  (${Math.round(serialSuccessRate * 100)}%)`);
  console.log(`  concurrent         ${ok.length}/${CONCURRENCY} succeeded  (${Math.round(concurrentSuccessRate * 100)}%)`);
  console.log(`  sequence conflicts ${contended.length}`);
  console.log(`  other failures     ${other.length}`);
  console.log(`  latency p50/p95    ${ms(summary.latencyMs.p50)} / ${ms(summary.latencyMs.p95)}`);
  console.log(`  uncontended floor  ${ms(warm.timings.totalMs)}`);
  console.log(`  contention factor  ${summary.contentionFactor ?? 'n/a'}x slower at p50 than a lone payment`);
  console.log(`  throughput         ~${summary.run.throughputPerMin} settlements/min`);
  console.log(`\n  ${summary.attribution.conclusion}\n`);

  if (other.length) {
    console.log('  non-contention failures (these the pool would NOT fix):');
    for (const f of other.slice(0, 5)) console.log(`    [${f.code}] ${String(f.reason).slice(0, 120)}`);
    console.log('');
  }

  mkdirSync(dirname(JSON_PATH), { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`  raw results -> ${JSON_PATH}`);

  if (WRITE_REPORT) {
    writeFileSync(REPORT_PATH, renderReport(summary), 'utf8');
    console.log(`  report      -> ${REPORT_PATH}`);
  }
  console.log('');
  return 0;
}

function renderReport(s) {
  return `# Load baseline — one fee-payer, before the channel pool

Produced by \`npm run load:baseline -- -n ${s.run.concurrency} --report\` on ${s.generatedAt}.
Raw results: [\`eval/load-baseline.json\`](../eval/load-baseline.json).

This is the **"before"**. The facilitator currently signs and fee-bumps every settlement
from a single \`FEEPAYER\` account, and a Stellar account has one sequence number, so
concurrent settlements queue behind each other by construction. Tranche 1 replaces this
with a channel-account pool; these are the numbers it has to beat.

## Configuration under test

| | |
|---|---|
| Fee-payer accounts | ${s.configuration.feePayers} |
| Channel pool | ${s.configuration.channelPool ? 'yes' : 'no'} |
| Network | ${s.configuration.network} |
| Concurrency | ${s.run.concurrency} |

## The controlled experiment

The same payment, against the same stack, issued two ways:

| | Attempted | Succeeded | Success rate |
|---|---|---|---|
| **Serial** (one at a time) | ${s.serialControl.attempted} | ${s.serialControl.succeeded} | **${Math.round(s.serialControl.successRate * 100)}%** |
| **Concurrent** | ${s.run.concurrency} | ${s.run.succeeded} | **${Math.round(s.run.successRate * 100)}%** |

${s.attribution.conclusion}

Nothing about the payment changed between the two rows — same asset, same seller, same
signer, same facilitator, same network. Only the timing did. That is what makes the
failure attributable to the single fee-payer's sequence number rather than to the
payment, and it is why the pool is the first thing Tranche 1 buys.

\`@x402/stellar\` reports these as \`settle_exact_stellar_transaction_submission_failed\`
without surfacing the underlying Stellar result code, so the control group is the only way
to attribute them honestly. The message alone would not let anyone — including us — tell a
sequence collision from a genuinely bad payment.

## Result

| Measure | Value |
|---|---|
| Uncontended payment (warm-up, serial) | ${ms(s.warmup.totalMs)} |
| Serial control, p50 | ${ms(s.serialControl.p50Ms)} |
| p50 under load | ${ms(s.latencyMs.p50)} |
| p95 under load | ${ms(s.latencyMs.p95)} |
| Max under load | ${ms(s.latencyMs.max)} |
| **Contention factor at p50** | **${s.contentionFactor ?? 'n/a'}×** |
| Succeeded | ${s.run.succeeded}/${s.run.concurrency} |
| Sequence-number contention failures | ${s.run.sequenceContention} |
| Other failures | ${s.run.otherFailures} |
| Throughput | ~${s.run.throughputPerMin} settlements/min |

## How to read the contention factor

It is p50-under-load divided by the same payment made alone. A value near 1 means
concurrency is free; anything well above 1 is the sequence number serialising work that
had no reason to be serial. It is the single number Tranche 1 is accountable for.

Sequence-contention failures are counted separately from every other failure on purpose:
a channel pool removes the first category and does nothing about the second, so folding
them together would overstate what the deliverable buys.

## What this does NOT show

The latency numbers under load are computed over the payments that **succeeded**. When
most of the run fails, that sample is small and survivorship-biased — a fast p50 next to a
low success rate means "the ones that got through were fine", not "the system was fine".
The success rate is the headline here; the latency is context.

## Tranche 1 target

- A pool of channel accounts, round-robin leased, each with its own sequence number.
- 25–50 concurrent settlements with **zero** sequence-number failures.
- Sequence-drift quarantine and reconciliation demonstrated by fault injection.
- This same script re-run and published as the "after", against this file.
`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(await main());

export { CONTENTION };
