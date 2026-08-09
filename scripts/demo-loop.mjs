#!/usr/bin/env node
/**
 * STARSIGHT — end-to-end proof.
 *
 * An agent that has never seen this API:
 *   1. discovers a resource through the bazaar index,
 *   2. calls it and gets HTTP 402,
 *   3. signs a payment with the PAYER wallet using @x402/stellar/exact/client,
 *   4. replays the call and unlocks the resource,
 *   5. prints the settled Stellar transaction hash.
 *
 * The agent holds SXT but needs ZERO XLM — the facilitator's FEEPAYER sponsors fees.
 *
 * Run:  node scripts/demo-loop.mjs   (facilitator + seller must be running)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const TX_DOC_PATH = join(ROOT, "docs", "TESTNET-TXS.md");

const {
  PAYER_SECRET,
  STELLAR_RPC_URL = "https://soroban-testnet.stellar.org",
  INDEX_URL = "http://localhost:4022",
  SELLER_URL = "http://localhost:4023",
  FACILITATOR_URL = "http://localhost:4021",
  ASSET_CODE = "SXT",
} = process.env;

const NETWORK = "stellar:testnet";
const X402_VERSION = 2;

if (!PAYER_SECRET) {
  console.error("[demo] PAYER_SECRET missing — run `npm run setup` first.");
  process.exit(1);
}

const settled = [];
const step = (n, title) => console.log(`\n${"-".repeat(70)}\n${n}. ${title}\n${"-".repeat(70)}`);

// ---------------------------------------------------------------------------
// The agent's wallet
// ---------------------------------------------------------------------------

const signer = createEd25519Signer(PAYER_SECRET, NETWORK);
const client = new ExactStellarScheme(signer, { url: STELLAR_RPC_URL });

// ---------------------------------------------------------------------------
// One full 402 -> pay -> 200 round trip
// ---------------------------------------------------------------------------

async function payAndFetch(label, url, { method = "GET", body } = {}) {
  const init = {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  // --- first call: expect 402 -------------------------------------------------
  const unpaid = await fetch(url, init);
  if (unpaid.status !== 402) {
    console.log(`   unexpected status ${unpaid.status} (expected 402)`);
    console.log(`   ${(await unpaid.text()).slice(0, 300)}`);
    return null;
  }

  const challenge = await unpaid.json();
  const requirements = challenge.accepts?.[0];
  if (!requirements) {
    console.log("   402 body carried no `accepts` entry — cannot pay.");
    return null;
  }

  const human =
    requirements.extra?.humanAmount ??
    `${Number(requirements.amount) / 1e7} ${requirements.extra?.assetCode ?? ASSET_CODE}`;
  console.log(`   402 received — price ${human}`);
  console.log(`   payTo ${requirements.payTo}`);
  console.log(`   asset ${requirements.asset}`);
  if (challenge.extensions?.bazaar) console.log(`   bazaar discovery metadata present`);

  // --- sign the payment -------------------------------------------------------
  // createPaymentPayload returns only { x402Version, payload }; the caller assembles
  // the rest of the v2 PaymentPayload envelope.
  const signed = await client.createPaymentPayload(X402_VERSION, requirements);

  const paymentPayload = {
    x402Version: X402_VERSION,
    resource: challenge.resource,
    accepted: requirements,
    payload: signed.payload,
    extensions: challenge.extensions,
  };

  const header = Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64");
  console.log(`   payment signed by ${signer.address}`);

  // --- second call: paid ------------------------------------------------------
  const paid = await fetch(url, {
    ...init,
    headers: { ...init.headers, "X-PAYMENT": header },
  });

  const paidBody = await paid.json().catch(() => ({}));

  if (paid.status !== 200) {
    console.log(`   payment rejected (${paid.status}): ${paidBody.error ?? "no reason given"}`);
    return null;
  }

  const receiptHeader = paid.headers.get("x-payment-response");
  let receipt = null;
  if (receiptHeader) {
    try {
      receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
    } catch {
      /* keep going — the body already carries the hash */
    }
  }

  const txHash = receipt?.transaction ?? paidBody?.paidWith?.transaction ?? null;

  const extHeader = paid.headers.get("extension-responses");
  if (extHeader) {
    try {
      const ext = JSON.parse(Buffer.from(extHeader, "base64").toString("utf8"));
      console.log(`   EXTENSION-RESPONSES: bazaar=${ext.bazaar?.status}`);
    } catch {
      /* non-fatal */
    }
  }

  console.log(`   200 OK — resource unlocked`);
  console.log(`   ${JSON.stringify(paidBody.data).slice(0, 220)}`);
  if (txHash) {
    console.log(`   settled tx  ${txHash}`);
    console.log(`   explorer    https://stellar.expert/explorer/testnet/tx/${txHash}`);
    settled.push({ step: `demo: ${label}`, hash: txHash });
  }
  return { paidBody, txHash };
}

// ---------------------------------------------------------------------------
// Append settled hashes to docs/TESTNET-TXS.md
// ---------------------------------------------------------------------------

function appendTxDoc() {
  if (!settled.length) return;
  mkdirSync(dirname(TX_DOC_PATH), { recursive: true });

  const rows = settled
    .map(
      (t) =>
        `| ${t.step} | \`${t.hash}\` | https://stellar.expert/explorer/testnet/tx/${t.hash} |`,
    )
    .join("\n");

  if (existsSync(TX_DOC_PATH)) {
    const prev = readFileSync(TX_DOC_PATH, "utf8").trimEnd();
    writeFileSync(TX_DOC_PATH, `${prev}\n${rows}\n`, "utf8");
  } else {
    const header = `# STARSIGHT — testnet transactions\n\n| Step | Hash | Explorer |\n|---|---|---|\n`;
    writeFileSync(TX_DOC_PATH, header + rows + "\n", "utf8");
  }
  console.log(`\n   appended ${settled.length} settlement hash(es) to docs/TESTNET-TXS.md`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  STARSIGHT — agent discovers, pays and unlocks a resource");
  console.log("=".repeat(70));
  console.log(`  agent wallet ${signer.address}`);
  console.log(`  index        ${INDEX_URL}`);
  console.log(`  seller       ${SELLER_URL}`);
  console.log(`  facilitator  ${FACILITATOR_URL}`);

  // -- 1. discovery ----------------------------------------------------------
  step(1, "Discover a resource through the bazaar index");
  let discovered = [];
  try {
    const res = await fetch(`${INDEX_URL}/discovery/search?query=postal%20code&limit=10`);
    const json = await res.json();
    discovered = json.items ?? [];
    console.log(`   /discovery/search returned ${discovered.length} item(s)`);
    for (const d of discovered.slice(0, 5)) {
      console.log(`     - ${d.id}  (${d.resource?.serviceName ?? "?"})`);
    }
    if (!discovered.length) {
      const all = await (await fetch(`${INDEX_URL}/discovery/resources?limit=20`)).json();
      discovered = all.items ?? [];
      console.log(`   fell back to /discovery/resources: ${discovered.length} item(s)`);
    }
  } catch (e) {
    console.log(`   index unreachable (${e.message}) — falling back to the known seller URL`);
  }

  const postalHit = discovered.find((d) => String(d.id).includes("/cep/"));
  const postalUrl = postalHit
    ? String(postalHit.id).replace(":cep", "01310100")
    : `${SELLER_URL}/v1/cep/01310100`;

  // -- 2. pay for the discovered resource ------------------------------------
  step(2, `Call the discovered resource: ${postalUrl}`);
  await payAndFetch("postal-code lookup", postalUrl);

  // -- 3. a second, differently-shaped resource ------------------------------
  step(3, `Call a second resource: ${SELLER_URL}/v1/fx/usd-brl`);
  await payAndFetch("fx usd-brl", `${SELLER_URL}/v1/fx/usd-brl`);

  // -- 4. a POST resource with a JSON body -----------------------------------
  step(4, `Call a POST resource: ${SELLER_URL}/v1/ocr/nota-fiscal`);
  await payAndFetch("ocr invoice", `${SELLER_URL}/v1/ocr/nota-fiscal`, {
    method: "POST",
    body: { imageUrl: "https://example.com/invoice.png", language: "pt-BR" },
  });

  // -- 5. confirm the facilitator auto-cataloged what it settled -------------
  step(5, "Confirm the facilitator auto-cataloged the settled resources");
  try {
    const res = await fetch(`${INDEX_URL}/discovery/resources?limit=50`);
    const json = await res.json();
    console.log(`   index now holds ${json.total ?? json.items?.length ?? 0} resource(s):`);
    for (const i of json.items ?? []) {
      console.log(`     - ${i.id}  settlements=${i.settlements}`);
    }
  } catch (e) {
    console.log(`   could not read the index: ${e.message}`);
  }

  appendTxDoc();

  console.log("\n" + "=".repeat(70));
  console.log(`  DONE — ${settled.length} payment(s) settled on Stellar testnet`);
  for (const s of settled) {
    console.log(`    ${s.step.padEnd(28)} https://stellar.expert/explorer/testnet/tx/${s.hash}`);
  }
  console.log("=".repeat(70) + "\n");

  if (!settled.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\ndemo-loop failed:", e);
  process.exit(1);
});
