#!/usr/bin/env node
/**
 * STELLARSIGHT — testnet bootstrap.
 *
 * Removes ALL external blockers: zero web forms, zero captchas, zero API keys.
 * We issue our OWN classic asset (SXT) and wrap it as a Stellar Asset Contract,
 * so we never need the Circle USDC faucet. The x402 Stellar spec accepts ANY
 * SEP-41 token, and a wrapped classic asset IS a SEP-41 token.
 *
 * Run:  node scripts/setup-testnet.mjs
 * Idempotent: if /.env already exists with keys, we reuse them.
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
  rpc,
} from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");
const TX_DOC_PATH = join(ROOT, "docs", "TESTNET-TXS.md");

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET; // "Test SDF Network ; September 2015"
const ASSET_CODE = "SXT";
const FRIENDBOT = "https://friendbot.stellar.org";

const horizon = new Horizon.Server(HORIZON_URL);
const sorobanRpc = new rpc.Server(RPC_URL);

/** Collected transaction hashes for docs/TESTNET-TXS.md */
const txs = [];
const record = (step, hash) => {
  if (!hash) return;
  txs.push({ step, hash });
  console.log(`   tx ${hash}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// .env helpers (idempotency)
// ---------------------------------------------------------------------------

function readExistingEnv() {
  if (!existsSync(ENV_PATH)) return {};
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

/** Reuse a secret from .env when present, else mint a fresh keypair. */
function keypairFor(role, existing) {
  const secret = existing[`${role}_SECRET`];
  if (secret && secret.startsWith("S")) {
    try {
      const kp = Keypair.fromSecret(secret);
      log(`   ${role.padEnd(8)} reused  ${kp.publicKey()}`);
      return { kp, fresh: false };
    } catch {
      /* fall through to regeneration */
    }
  }
  const kp = Keypair.random();
  log(`   ${role.padEnd(8)} created ${kp.publicKey()}`);
  return { kp, fresh: true };
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

async function accountExists(pub) {
  try {
    await horizon.loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

/** Fund via friendbot. Retries once. Never throws — logs and continues. */
async function fund(role, pub) {
  if (await accountExists(pub)) {
    log(`   ${role.padEnd(8)} already funded`);
    return true;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) {
        log(`   ${role.padEnd(8)} funded via friendbot`);
        return true;
      }
      const body = await res.text();
      // Friendbot returns 400 when the account already exists — that's fine.
      if (body.includes("op_already_exists") || body.includes("already funded")) {
        log(`   ${role.padEnd(8)} already funded (friendbot said so)`);
        return true;
      }
      log(`   ${role.padEnd(8)} friendbot attempt ${attempt} failed: ${res.status}`);
    } catch (e) {
      log(`   ${role.padEnd(8)} friendbot attempt ${attempt} error: ${e.message}`);
    }
    if (attempt === 1) await sleep(2000);
  }
  // Last resort: it may actually have landed.
  return await accountExists(pub);
}

// ---------------------------------------------------------------------------
// Classic transaction submission
// ---------------------------------------------------------------------------

/** Build + sign + submit a classic tx. Returns hash or null (never throws). */
async function submitClassic(label, sourceKp, buildOps, extraSigners = []) {
  try {
    const account = await horizon.loadAccount(sourceKp.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 10),
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    buildOps(builder);
    const tx = builder.setTimeout(60).build();
    tx.sign(sourceKp, ...extraSigners);
    const res = await horizon.submitTransaction(tx);
    log(`   ${label}: ok`);
    record(label, res.hash);
    return res.hash;
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    const detail = codes ? JSON.stringify(codes) : e.message;
    // Idempotent-safe failures we deliberately swallow.
    if (String(detail).includes("op_low_reserve")) {
      log(`   ${label}: SKIPPED (low reserve) — ${detail}`);
      return null;
    }
    log(`   ${label}: FAILED — ${detail}`);
    return null;
  }
}

async function hasTrustline(pub, asset) {
  try {
    const acct = await horizon.loadAccount(pub);
    return acct.balances.some(
      (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
    );
  } catch {
    return false;
  }
}

async function assetBalance(pub, asset) {
  try {
    const acct = await horizon.loadAccount(pub);
    const b = acct.balances.find(
      (x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer(),
    );
    return b ? Number(b.balance) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// SAC deploy
// ---------------------------------------------------------------------------

/**
 * Deploy (wrap) the Stellar Asset Contract for our classic asset.
 * `Asset.contractId()` gives the deterministic id without any network call, but the
 * contract instance must ALSO be created on-chain via the createStellarAssetContract
 * host function before anyone can call it. Catches "already exists" and continues.
 */
async function deploySac(asset, issuerKp) {
  const contractId = asset.contractId(NETWORK_PASSPHRASE);
  log(`   deterministic SAC id: ${contractId}`);

  // Already deployed? Then getContractData/getLedgerEntries resolves the instance.
  try {
    const existing = await sorobanRpc.getContractData(
      contractId,
      // instance storage key
      (await import("@stellar/stellar-sdk")).xdr.ScVal.scvLedgerKeyContractInstance(),
    );
    if (existing) {
      log("   SAC already deployed on-chain — skipping createStellarAssetContract");
      return { contractId, hash: null, alreadyDeployed: true };
    }
  } catch {
    /* not deployed yet — proceed */
  }

  try {
    const account = await sorobanRpc.getAccount(issuerKp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 100),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(120)
      .build();

    const prepared = await sorobanRpc.prepareTransaction(tx);
    prepared.sign(issuerKp);
    const sent = await sorobanRpc.sendTransaction(prepared);

    if (sent.status === "ERROR") {
      throw new Error(`sendTransaction ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }

    // Poll for confirmation.
    let got = await sorobanRpc.getTransaction(sent.hash);
    for (let i = 0; i < 30 && got.status === "NOT_FOUND"; i++) {
      await sleep(1000);
      got = await sorobanRpc.getTransaction(sent.hash);
    }

    if (got.status === "SUCCESS") {
      log("   SAC deployed");
      record("Deploy SAC (createStellarAssetContract)", sent.hash);
      return { contractId, hash: sent.hash, alreadyDeployed: false };
    }
    throw new Error(`SAC deploy status=${got.status}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (
      msg.includes("already exists") ||
      msg.includes("ExistingValue") ||
      msg.includes("AlreadyExists")
    ) {
      log("   SAC already exists — continuing");
      return { contractId, hash: null, alreadyDeployed: true };
    }
    log(`   SAC deploy FAILED (continuing with deterministic id): ${msg}`);
    // The deterministic id is still correct; a later run can retry the deploy.
    return { contractId, hash: null, alreadyDeployed: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

function writeEnv(vals) {
  const body = `# STELLARSIGHT — generated by scripts/setup-testnet.mjs
# TESTNET ONLY. Never put mainnet secrets here.
STELLAR_NETWORK=stellar:testnet
STELLAR_RPC_URL=${RPC_URL}
HORIZON_URL=${HORIZON_URL}
NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}

ISSUER_SECRET=${vals.ISSUER_SECRET}
ISSUER_PUBLIC=${vals.ISSUER_PUBLIC}
ASSET_CODE=${ASSET_CODE}
ASSET_SAC=${vals.ASSET_SAC}

SELLER_SECRET=${vals.SELLER_SECRET}
SELLER_PUBLIC=${vals.SELLER_PUBLIC}

PAYER_SECRET=${vals.PAYER_SECRET}
PAYER_PUBLIC=${vals.PAYER_PUBLIC}

FEEPAYER_SECRET=${vals.FEEPAYER_SECRET}
FEEPAYER_PUBLIC=${vals.FEEPAYER_PUBLIC}

FACILITATOR_URL=http://localhost:4021
INDEX_URL=http://localhost:4022
SELLER_URL=http://localhost:4023
`;
  writeFileSync(ENV_PATH, body, "utf8");
  log(`\n   wrote ${ENV_PATH}`);
}

function writeTxDoc() {
  mkdirSync(dirname(TX_DOC_PATH), { recursive: true });
  const rows = txs
    .map(
      (t) =>
        `| ${t.step} | \`${t.hash}\` | https://stellar.expert/explorer/testnet/tx/${t.hash} |`,
    )
    .join("\n");
  const header = `# STELLARSIGHT — testnet transactions

All transactions below are on **Stellar testnet**. Generated by \`scripts/setup-testnet.mjs\`
and appended to by \`scripts/demo-loop.mjs\`.

| Step | Hash | Explorer |
|---|---|---|
`;
  // Preserve prior demo-loop rows if the file already exists.
  let existingRows = "";
  if (existsSync(TX_DOC_PATH)) {
    const prev = readFileSync(TX_DOC_PATH, "utf8");
    const demoRows = prev
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.includes("stellar.expert") && l.includes("demo"))
      .join("\n");
    if (demoRows) existingRows = "\n" + demoRows;
  }
  writeFileSync(TX_DOC_PATH, header + rows + existingRows + "\n", "utf8");
  log(`   wrote ${TX_DOC_PATH}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("\nSTELLARSIGHT testnet setup — no faucets, no captchas, no API keys.\n");

  const existing = readExistingEnv();
  const reusing = Boolean(existing.ISSUER_SECRET);
  if (reusing) log("Found existing /.env — reusing keys (idempotent run).\n");

  log("1/8  keypairs");
  const issuer = keypairFor("ISSUER", existing);
  const seller = keypairFor("SELLER", existing);
  const payer = keypairFor("PAYER", existing);
  const feepayer = keypairFor("FEEPAYER", existing);

  log("\n2/8  funding via friendbot");
  for (const [role, k] of [
    ["ISSUER", issuer],
    ["SELLER", seller],
    ["PAYER", payer],
    ["FEEPAYER", feepayer],
  ]) {
    await fund(role, k.kp.publicKey());
  }
  log("   sleeping 2s for ledger close…");
  await sleep(2000);

  const asset = new Asset(ASSET_CODE, issuer.kp.publicKey());
  log(`\n3/8  asset ${ASSET_CODE}:${issuer.kp.publicKey()}`);
  // A classic asset "exists" the moment the issuer pays it out — there is no separate
  // issuance op. We set the issuer's home domain so wallets can discover the asset.
  await submitClassic("Issuer setOptions (home domain)", issuer.kp, (b) =>
    b.addOperation(Operation.setOptions({ homeDomain: "stellarsight.local" })),
  );

  log("\n4/8  trustlines");
  for (const [role, k] of [
    ["SELLER", seller],
    ["PAYER", payer],
  ]) {
    if (await hasTrustline(k.kp.publicKey(), asset)) {
      log(`   ${role} trustline already present`);
      continue;
    }
    await submitClassic(`changeTrust ${role} -> ${ASSET_CODE}`, k.kp, (b) =>
      b.addOperation(Operation.changeTrust({ asset, limit: "1000000" })),
    );
  }

  log("\n5/8  distribution");
  const bal = await assetBalance(payer.kp.publicKey(), asset);
  if (bal >= 10000) {
    log(`   PAYER already holds ${bal} ${ASSET_CODE} — skipping payment`);
  } else {
    await submitClassic(`Payment ISSUER -> PAYER 10000 ${ASSET_CODE}`, issuer.kp, (b) =>
      b.addOperation(
        Operation.payment({
          destination: payer.kp.publicKey(),
          asset,
          amount: "10000",
        }),
      ),
    );
  }

  log("\n6/8  Stellar Asset Contract (SAC)");
  const sac = await deploySac(asset, issuer.kp);

  log("\n7/8  writing /.env");
  writeEnv({
    ISSUER_SECRET: issuer.kp.secret(),
    ISSUER_PUBLIC: issuer.kp.publicKey(),
    ASSET_SAC: sac.contractId,
    SELLER_SECRET: seller.kp.secret(),
    SELLER_PUBLIC: seller.kp.publicKey(),
    PAYER_SECRET: payer.kp.secret(),
    PAYER_PUBLIC: payer.kp.publicKey(),
    FEEPAYER_SECRET: feepayer.kp.secret(),
    FEEPAYER_PUBLIC: feepayer.kp.publicKey(),
  });

  log("\n8/8  writing docs/TESTNET-TXS.md");
  writeTxDoc();

  // ---- summary table -------------------------------------------------------
  const finalPayerBal = await assetBalance(payer.kp.publicKey(), asset);
  const rows = [
    ["ISSUER", issuer.kp.publicKey()],
    ["SELLER (payTo)", seller.kp.publicKey()],
    ["PAYER (agent)", payer.kp.publicKey()],
    ["FEEPAYER", feepayer.kp.publicKey()],
    ["ASSET", `${ASSET_CODE}`],
    ["ASSET_SAC", sac.contractId],
    ["PAYER balance", `${finalPayerBal} ${ASSET_CODE}`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  log("\n" + "=".repeat(78));
  log("  STELLARSIGHT testnet ready");
  log("=".repeat(78));
  for (const [k, v] of rows) log(`  ${k.padEnd(w)}  ${v}`);
  log("=".repeat(78));
  log(`  ${txs.length} transaction(s) recorded in docs/TESTNET-TXS.md`);
  if (sac.error) {
    log(`  NOTE: SAC deploy did not confirm (${sac.error}).`);
    log(`        The deterministic id above is still correct; re-run to retry.`);
  }
  log("=".repeat(78) + "\n");
}

main().catch((e) => {
  console.error("\nsetup-testnet failed:", e);
  process.exit(1);
});
