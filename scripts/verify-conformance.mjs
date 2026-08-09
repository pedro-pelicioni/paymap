#!/usr/bin/env node
/**
 * PAYMAP — stock-client conformance check.
 *
 * The RFP's hard acceptance criterion is that an UNMODIFIED canonical client can pay an
 * independent resource server. This script is that test, and it is deliberately written
 * so that nothing in `apps/agent` is on the code path: the only client code here comes
 * from the published packages.
 *
 *   @x402/fetch            -> wrapFetchWithPayment, x402Client, decodePaymentResponseHeader
 *   @x402/stellar          -> createEd25519Signer
 *   @x402/stellar/exact/client -> ExactStellarScheme
 *   @x402/core/http        -> decodePaymentRequiredHeader   (spec assertion only)
 *
 * `wrapFetchWithPayment` drives the whole loop itself: unpaid request -> read the
 * `PAYMENT-REQUIRED` header -> sign -> resend with `PAYMENT-SIGNATURE` -> read
 * `PAYMENT-RESPONSE`. If the seller drifts off the x402 v2 HTTP transport in any of those
 * four places, this fails. There is no leniency anywhere in this file to hide it.
 *
 * This is a REAL run against stellar:testnet. It moves real (valueless) testnet tokens and
 * prints the settled transaction hash.
 *
 * Usage:
 *   npm run verify:conformance
 *   npm run verify:conformance -- --url http://localhost:4023/v1/cep/01310100
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

// ---------------------------------------------------------------------------
// Tiny transcript printer — every line is evidence, so keep it plain.
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", cyan: "", bold: "", off: "" };

let step = 0;
const say = (msg) => console.log(`  ${msg}`);
const head = (msg) => console.log(`\n${C.bold}${++step}. ${msg}${C.off}`);
const ok = (msg) => say(`${C.green}PASS${C.off}  ${msg}`);
const info = (msg) => say(`${C.dim}      ${msg}${C.off}`);

function die(msg, detail) {
  console.error(`  ${C.red}FAIL${C.off}  ${msg}`);
  if (detail) console.error(`${C.dim}        ${String(detail).split("\n").join("\n        ")}${C.off}`);
  console.error(`\n${C.red}CONFORMANCE CHECK FAILED${C.off} — a stock @x402/fetch client cannot pay this resource.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments and configuration
// ---------------------------------------------------------------------------

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const {
  STELLAR_NETWORK: NETWORK = "stellar:testnet",
  STELLAR_RPC_URL: RPC_URL = "https://soroban-testnet.stellar.org",
  PAYER_SECRET,
} = process.env;

const SELLER_URL = String(arg("seller", process.env.SELLER_URL || "http://localhost:4023")).replace(/\/+$/, "");
const TARGET = arg("url", `${SELLER_URL}/v1/fx/usd-brl`);
const METHOD = arg("method", "GET").toUpperCase();

console.log(`\n${C.bold}PAYMAP — x402 v2 conformance against an unmodified @x402/fetch client${C.off}`);
console.log(`${C.dim}  resource ${TARGET}`);
console.log(`  network  ${NETWORK}`);
console.log(`  client   @x402/fetch wrapFetchWithPayment (no PAYMAP code on the path)${C.off}`);

if (!PAYER_SECRET) die("PAYER_SECRET is not set in .env — run `npm run setup` first.");
if (NETWORK !== "stellar:testnet") die(`Refusing to run on ${NETWORK}; this check is testnet-only.`);

// ---------------------------------------------------------------------------
// 1. The 402 challenge must live where the spec puts it.
//
// specs/transports-v2/http.md: "The `PAYMENT-REQUIRED` header is the canonical HTTP
// transport location for the `PaymentRequired` object." @x402/core's client accepts a
// JSON body only when `body.x402Version === 1`, so a v2 server that answers with a body
// alone is unreachable. We assert the header explicitly, before handing control to the
// SDK, so that this specific drift produces a specific message.
// ---------------------------------------------------------------------------

head("Unpaid probe — the 402 must carry a PAYMENT-REQUIRED header");

let probe;
try {
  probe = await fetch(TARGET, { method: METHOD, headers: { accept: "application/json" } });
} catch (e) {
  die(`Could not reach the resource at ${TARGET}`, `${e.message}\nIs the seller running? \`npm run dev:all\``);
}

if (probe.status !== 402) die(`Expected HTTP 402 from an unpaid request, got ${probe.status}.`);
ok("HTTP 402 Payment Required");

const challengeHeader = probe.headers.get("PAYMENT-REQUIRED");
if (!challengeHeader) {
  die(
    "The 402 carries no PAYMENT-REQUIRED header.",
    "x402 v2 puts the PaymentRequired object in that header. @x402/core only falls back to\n" +
      "the JSON body when body.x402Version === 1, so a stock client cannot read this challenge.",
  );
}

let challenge;
try {
  challenge = decodePaymentRequiredHeader(challengeHeader);
} catch (e) {
  die("PAYMENT-REQUIRED did not decode with @x402/core's decodePaymentRequiredHeader.", e.message);
}
ok(`PAYMENT-REQUIRED decoded — x402Version ${challenge.x402Version}, ${challenge.accepts?.length ?? 0} requirement(s)`);

const req0 = challenge.accepts?.[0] ?? {};
info(`${req0.scheme}@${req0.network}  amount=${req0.amount}  asset=${req0.asset}`);
info(`resource ${challenge.resource?.url ?? "(none)"}`);

if (challenge.x402Version !== 2) die(`Challenge advertises x402Version ${challenge.x402Version}; this check targets v2.`);
if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) die("Challenge lists no `accepts` entries.");
if (req0.maxAmountRequired !== undefined && req0.amount === undefined) {
  die("PaymentRequirements uses the v1 field `maxAmountRequired`; v2 names it `amount`.");
}

// ---------------------------------------------------------------------------
// 2. Build the canonical client and let it drive the whole loop.
// ---------------------------------------------------------------------------

head("Stock client — wrapFetchWithPayment drives 402 -> sign -> settle -> 200");

let signer;
try {
  signer = createEd25519Signer(PAYER_SECRET, NETWORK);
} catch (e) {
  die("createEd25519Signer rejected PAYER_SECRET.", e.message);
}
info(`payer ${signer.address}`);

const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const started = Date.now();
let response;
try {
  response = await fetchWithPayment(TARGET, { method: METHOD, headers: { accept: "application/json" } });
} catch (e) {
  die("wrapFetchWithPayment threw before completing the loop.", e.message);
}
const elapsedMs = Date.now() - started;

if (response.status !== 200) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 600);
  } catch {
    /* body already consumed or absent */
  }
  const hint =
    response.status === 402
      ? "\nA second 402 after payment means the seller never saw the PAYMENT-SIGNATURE header\n" +
        "(v2 clients do not send X-PAYMENT) or the facilitator rejected the payload."
      : "";
  die(`Paid request returned HTTP ${response.status}, expected 200.${hint}`, detail);
}
ok(`HTTP 200 in ${elapsedMs}ms`);

// ---------------------------------------------------------------------------
// 3. The settlement receipt must live where the spec puts it.
// ---------------------------------------------------------------------------

head("Settlement receipt — PAYMENT-RESPONSE header");

const receiptHeader = response.headers.get("PAYMENT-RESPONSE");
if (!receiptHeader) {
  die(
    "The 200 carries no PAYMENT-RESPONSE header.",
    "x402 v2 returns the SettlementResponse there. X-PAYMENT-RESPONSE is the v1 name.",
  );
}

let settle;
try {
  settle = decodePaymentResponseHeader(receiptHeader);
} catch (e) {
  die("PAYMENT-RESPONSE did not decode with @x402/fetch's decodePaymentResponseHeader.", e.message);
}

if (settle.success !== true) die(`Settlement reported success=false: ${settle.errorReason ?? "no errorReason given"}`);
ok("PAYMENT-RESPONSE decoded, success=true");

const txHash = String(settle.transaction ?? "").trim();
if (!/^[0-9a-f]{64}$/i.test(txHash)) die(`Settlement carried no usable transaction hash (got ${JSON.stringify(settle.transaction)}).`);

const explorer = `https://stellar.expert/explorer/testnet/tx/${txHash}`;

head("Resource body");
const payload = await response.json();
info(JSON.stringify(payload?.data ?? payload).slice(0, 240));

console.log(`\n${C.green}${C.bold}CONFORMANCE CHECK PASSED${C.off}`);
console.log(`  An unmodified @x402/fetch client completed 402 -> sign -> settle -> 200.`);
console.log(`\n  ${C.bold}tx${C.off}       ${txHash}`);
console.log(`  ${C.bold}payer${C.off}    ${settle.payer ?? signer.address}`);
console.log(`  ${C.bold}network${C.off}  ${settle.network ?? NETWORK}`);
console.log(`  ${C.bold}explorer${C.off} ${C.cyan}${explorer}${C.off}`);
console.log(`\n  ${C.dim}Append to docs/TESTNET-TXS.md:${C.off}`);
console.log(`  | \`${txHash.slice(0, 8)}…\` | ${req0.amount ? Number(req0.amount) / 1e7 : "?"} SXT | ${new URL(TARGET).pathname} | [link](${explorer}) |`);
console.log("");
