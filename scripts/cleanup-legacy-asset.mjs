#!/usr/bin/env node
/**
 * STELLARSIGHT — legacy asset cleanup.
 *
 * An earlier run of scripts/setup-testnet.mjs issued a test asset under the
 * project's former name (PREGO). The project asset is now SXT, but the stale
 * PREGO trustlines and balances are still on the accounts and show up on
 * stellar.expert. This script removes them so the on-chain footprint shows
 * only SXT.
 *
 * For every account it finds each non-native balance whose asset_code is NOT
 * the keeper code (SXT) and:
 *   1. pays the full balance back to the issuing account — a trustline cannot
 *      be removed while it still holds a balance;
 *   2. removes the trustline with changeTrust(limit: "0").
 *
 * Run:  node scripts/cleanup-legacy-asset.mjs   (or: npm run cleanup)
 *
 * Idempotent: with nothing to clean it exits 0 without touching any file.
 * Defensive: every account is wrapped in try/catch, so one failing account
 * never aborts the run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");
const TX_DOC_PATH = join(ROOT, "docs", "TESTNET-TXS.md");

const NETWORK_PASSPHRASE = Networks.TESTNET; // "Test SDF Network ; September 2015"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

function readEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`\nNo .env at ${ENV_PATH}. Run \`npm run setup\` first.\n`);
    process.exit(1);
  }
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = readEnv();
const HORIZON_URL = env.HORIZON_URL || "https://horizon-testnet.stellar.org";
/** The asset we keep. Everything else non-native is legacy and gets removed. */
const KEEP_CODE = env.ASSET_CODE || "SXT";

const horizon = new Horizon.Server(HORIZON_URL);

// ---------------------------------------------------------------------------
// tx recording
// ---------------------------------------------------------------------------

/** Collected transaction hashes, appended to docs/TESTNET-TXS.md at the end. */
const txs = [];
const record = (step, hash) => {
  if (!hash) return;
  txs.push({ step, hash });
};

/** Build + sign + submit a classic tx. Returns hash, or null on failure. */
async function submitClassic(label, sourceKp, buildOps) {
  try {
    const account = await horizon.loadAccount(sourceKp.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 10),
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    buildOps(builder);
    const tx = builder.setTimeout(60).build();
    tx.sign(sourceKp);
    const res = await horizon.submitTransaction(tx);
    log(`     ${label}: ok  ${res.hash}`);
    record(label, res.hash);
    return res.hash;
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    const detail = codes ? JSON.stringify(codes) : e.message;
    log(`     ${label}: FAILED — ${detail}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// balance inspection
// ---------------------------------------------------------------------------

/**
 * Legacy rows on an account: non-native, not the keeper asset, not the
 * account's own issued asset, and not a liquidity-pool share (those are not
 * removable with a plain changeTrust and we never create them).
 */
function legacyBalances(pub, balances) {
  const legacy = [];
  for (const b of balances) {
    if (b.asset_type === "native") continue;
    if (b.asset_type === "liquidity_pool_shares") {
      log(`     skip: liquidity pool share ${b.liquidity_pool_id ?? ""} (not handled)`);
      continue;
    }
    if (!b.asset_code || !b.asset_issuer) continue;
    // An issuer never holds a trustline to its own asset — never touch such a row.
    if (b.asset_issuer === pub) continue;
    if (b.asset_code === KEEP_CODE) continue;
    legacy.push(b);
  }
  return legacy;
}

/** Print the current non-native balances of an account. */
async function showBalances(role, pub) {
  const acct = await horizon.loadAccount(pub);
  const rows = acct.balances.map((b) =>
    b.asset_type === "native"
      ? `XLM (native)  ${b.balance}`
      : `${b.asset_code ?? b.asset_type}  ${b.balance}  (issuer ${b.asset_issuer ?? "-"})`,
  );
  log(`   ${role} ${pub}`);
  for (const r of rows) log(`     ${r}`);
  return acct.balances;
}

// ---------------------------------------------------------------------------
// per-account cleanup
// ---------------------------------------------------------------------------

async function cleanAccount(role, secret) {
  const result = { role, cleaned: 0, failed: 0, skipped: false };
  let kp;
  try {
    kp = Keypair.fromSecret(secret);
  } catch {
    log(`\n   ${role}: invalid or missing secret in .env — skipping`);
    result.skipped = true;
    return result;
  }
  const pub = kp.publicKey();

  try {
    const acct = await horizon.loadAccount(pub);
    const legacy = legacyBalances(pub, acct.balances);

    if (legacy.length === 0) {
      log(`   ${role.padEnd(8)} ${pub}  — nothing to clean`);
      return result;
    }

    log(`   ${role.padEnd(8)} ${pub}`);
    for (const b of legacy) {
      const asset = new Asset(b.asset_code, b.asset_issuer);
      const amount = b.balance;
      log(`     legacy ${b.asset_code}: balance ${amount}`);

      // (a) Return the full balance to the issuer. Sending an asset back to its
      //     issuer burns it and is the only way to empty the trustline.
      if (Number(amount) > 0) {
        const hash = await submitClassic(
          `cleanup: return ${amount} ${b.asset_code} to issuer (${role})`,
          kp,
          (builder) =>
            builder.addOperation(
              Operation.payment({ destination: b.asset_issuer, asset, amount }),
            ),
        );
        if (!hash) {
          log(`     ${b.asset_code}: could not empty balance — leaving trustline in place`);
          result.failed++;
          continue;
        }
        // Let the ledger close so the next tx picks up a fresh sequence number.
        await sleep(1500);
      } else {
        log(`     balance already 0 — going straight to trustline removal`);
      }

      // (b) Remove the now-empty trustline.
      const hash = await submitClassic(
        `cleanup: remove legacy ${b.asset_code} trustline (${role})`,
        kp,
        (builder) => builder.addOperation(Operation.changeTrust({ asset, limit: "0" })),
      );
      if (hash) {
        result.cleaned++;
        await sleep(1000);
      } else {
        result.failed++;
      }
    }
  } catch (e) {
    // One bad account must never abort the whole run.
    log(`   ${role}: ERROR — ${e?.message ?? e}`);
    result.failed++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// docs/TESTNET-TXS.md — append only
// ---------------------------------------------------------------------------

function appendTxDoc() {
  if (txs.length === 0) return;
  mkdirSync(dirname(TX_DOC_PATH), { recursive: true });
  const rows = txs
    .map(
      (t) =>
        `| ${t.step} | \`${t.hash}\` | https://stellar.expert/explorer/testnet/tx/${t.hash} |`,
    )
    .join("\n");

  if (existsSync(TX_DOC_PATH)) {
    // Append — never rewrite. Existing rows are preserved verbatim.
    const prev = readFileSync(TX_DOC_PATH, "utf8").trimEnd();
    writeFileSync(TX_DOC_PATH, `${prev}\n${rows}\n`, "utf8");
  } else {
    const header = `# STELLARSIGHT — testnet transactions

All transactions below are on **Stellar testnet**.

| Step | Hash | Explorer |
|---|---|---|
`;
    writeFileSync(TX_DOC_PATH, header + rows + "\n", "utf8");
  }
  log(`\n   appended ${txs.length} hash(es) to docs/TESTNET-TXS.md`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ROLES = ["ISSUER", "SELLER", "PAYER", "FEEPAYER"];

async function main() {
  log(`\nSTELLARSIGHT — legacy asset cleanup (keeping ${KEEP_CODE}, removing everything else)\n`);
  log(`   horizon ${HORIZON_URL}`);
  log(`   network ${NETWORK_PASSPHRASE}\n`);

  log("1/3  scanning accounts");
  const results = [];
  for (const role of ROLES) {
    results.push(await cleanAccount(role, env[`${role}_SECRET`]));
  }

  const cleaned = results.reduce((n, r) => n + r.cleaned, 0);
  const failed = results.reduce((n, r) => n + r.failed, 0);

  if (txs.length === 0) {
    log("\n   Nothing to clean — no legacy trustlines found on any account.");
    log(`   All accounts already hold only ${KEEP_CODE} (and native XLM).\n`);
    process.exit(0);
  }

  log("\n2/3  recording transactions");
  appendTxDoc();

  log("\n3/3  verifying final balances");
  await sleep(1500);
  for (const role of ROLES) {
    const secret = env[`${role}_SECRET`];
    if (!secret) continue;
    try {
      await showBalances(role, Keypair.fromSecret(secret).publicKey());
    } catch (e) {
      log(`   ${role}: could not re-query — ${e?.message ?? e}`);
    }
  }

  log("\n" + "=".repeat(78));
  log(`  cleanup done — ${cleaned} trustline(s) removed, ${failed} failure(s)`);
  log(`  ${txs.length} transaction(s) appended to docs/TESTNET-TXS.md`);
  log("=".repeat(78) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\ncleanup-legacy-asset failed:", e);
  process.exit(1);
});
