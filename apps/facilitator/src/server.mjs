#!/usr/bin/env node
/**
 * STELLARSIGHT — self-hosted x402 facilitator (RFP 3.1 "self-facilitation").
 *
 * We run our OWN facilitator. There is no dependency on any third-party relayer —
 * in particular NOT on the OpenZeppelin Channels relayer, which is AGPL and therefore
 * disqualifying for this project. All verify/settle cryptography comes from the
 * Apache-2.0 `@x402/stellar` package; we never reimplement it.
 *
 * Real symbols used (verified against node_modules, not invented):
 *   @x402/stellar/exact/facilitator -> ExactStellarScheme  (class; .verify/.settle)
 *   @x402/stellar                   -> createEd25519Signer
 *   @x402/core/facilitator          -> x402Facilitator     (class; .register/.registerExtension/.getSupported/.verify/.settle)
 *   @x402/extensions/bazaar         -> BAZAAR, extractDiscoveryInfo, validateAndExtract
 *
 * Ports: 4021 facilitator, 4022 bazaar index (packages/index mounted here).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR, extractDiscoveryInfo, validateAndExtract } from "@x402/extensions/bazaar";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const {
  STELLAR_RPC_URL = "https://soroban-testnet.stellar.org",
  ASSET_SAC,
  ASSET_CODE = "SXT",
  FEEPAYER_SECRET,
  SELLER_PUBLIC,
} = process.env;

const NETWORK = "stellar:testnet";
const FACILITATOR_PORT = 4021;
const INDEX_PORT = 4022;

if (!FEEPAYER_SECRET) {
  console.error("[facilitator] FEEPAYER_SECRET missing — run `npm run setup` first.");
  process.exit(1);
}
if (!ASSET_SAC) {
  console.error("[facilitator] ASSET_SAC missing — run `npm run setup` first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bazaar index — owned by another agent (packages/index). Import defensively so
// this server always boots; fall back to a tiny in-memory catalog with the same
// API surface described in CONTRACT.md.
// ---------------------------------------------------------------------------

let indexPkg = null;
let usingIndexStub = false;

try {
  indexPkg = await import("../../../packages/index/src/index.mjs");
  if (typeof indexPkg.createCatalog !== "function") {
    throw new Error("createCatalog not exported");
  }
  console.log("[facilitator] packages/index loaded (real implementation)");
} catch (e) {
  usingIndexStub = true;
  console.warn(`[facilitator] packages/index unavailable (${e.message}) — using in-memory stub`);
  // TODO(stellarsight): remove this stub once packages/index ships. Same public API,
  // naive substring matching instead of BM25.
  indexPkg = {
    createCatalog() {
      const store = new Map();
      return {
        upsert(record) {
          if (!record?.id) return { ok: false, dropped: [], reason: "record.id is required" };
          store.set(record.id, { ...store.get(record.id), ...record });
          return { ok: true, dropped: [] };
        },
        list({ type, payTo, scheme, network, extensions, limit = 20, offset = 0 } = {}) {
          let items = [...store.values()];
          if (type) items = items.filter((i) => i.type === type);
          if (payTo) items = items.filter((i) => i.payTo === payTo);
          if (scheme) items = items.filter((i) => i.scheme === scheme);
          if (network) items = items.filter((i) => i.network === network);
          if (extensions) {
            const want = Array.isArray(extensions) ? extensions : [extensions];
            items = items.filter((i) => want.every((w) => (i.extensions ?? []).includes(w)));
          }
          const total = items.length;
          return { items: items.slice(offset, offset + limit), total, limit, offset };
        },
        search({ query = "", limit = 20, cursor } = {}) {
          const q = String(query).toLowerCase().trim();
          const all = [...store.values()];
          const items = q
            ? all.filter((i) => JSON.stringify(i).toLowerCase().includes(q))
            : all;
          const start = cursor ? Number(cursor) || 0 : 0;
          const page = items.slice(start, start + limit);
          const nextCursor = start + limit < items.length ? String(start + limit) : null;
          return {
            items: page,
            partialResults: false,
            pagination: { limit, cursor: nextCursor },
          };
        },
        size: () => store.size,
      };
    },
    validateResourceBlock: (block) => ({ value: block, dropped: [] }),
    validateRouteTemplate: (t) =>
      typeof t === "string" && t.startsWith("/")
        ? { valid: true }
        : { valid: false, reason: "routeTemplate must be a string starting with /" },
    scoreHybrid: (_query, docs) => docs,
  };
}

const catalog = indexPkg.createCatalog();

// ---------------------------------------------------------------------------
// Catalog seeding — a bazaar index with three entries makes discovery look like a toy
// and makes the ranker invisible. Load the demo corpus from packages/index/src/seed.mjs
// BEFORE any route is mounted, so the index is never observed in a half-seeded state.
//
// Ordering guarantees the live resources win: seeding happens here at boot, while the
// seller announces its real routes afterwards over POST /discovery/resources. `upsert`
// is keyed by id, so a live announcement overwrites any seed record sharing its id and
// clears the `seeded` flag with it. Seed records are additionally pinned to
// `settlements: 0` (see asSeedRecord) so they can never inflate an observed-settlement
// total. Set SEED_CATALOG=0 to boot an empty index.
// ---------------------------------------------------------------------------

const seedEnabled = process.env.SEED_CATALOG !== "0";

if (seedEnabled) {
  try {
    const { seedCatalog } = await import("../../../packages/index/src/seed.mjs");
    const summary = seedCatalog(catalog);
    console.log(
      `[index] seeded ${summary.inserted} demo records (catalog size ${catalog.size()})`,
    );
    if (summary.rejected?.length) {
      console.warn(`[index] ${summary.rejected.length} seed record(s) rejected:`);
      for (const r of summary.rejected) console.warn(`[index]   ${r.url} — ${r.reason}`);
    }
  } catch (e) {
    console.warn(`[index] catalog seeding skipped (${e.message}) — index starts empty`);
  }
} else {
  console.log("[index] catalog seeding disabled (SEED_CATALOG=0)");
}

// ---------------------------------------------------------------------------
// x402 wiring — all cryptography delegated to @x402/stellar (Apache-2.0).
// FEEPAYER signs AND acts as feeBumpSigner, so the paying agent needs zero XLM.
// ---------------------------------------------------------------------------

const feePayerSigner = createEd25519Signer(FEEPAYER_SECRET, NETWORK);

// `maxTransactionFeeStroops` is a SAFETY CEILING, not a fee we pay. @x402/stellar
// simulates the transfer, and if the simulation-derived fee exceeds this number it
// refuses at /verify before any money moves. Its default is 50_000.
//
// That default is too tight for this scheme and was empirically breaking payments.
// A SEP-41 SAC transfer with a sponsored fee bump simulates around 57_000 stroops on
// testnet today — above the default — and the margin moves with network load, so the
// failure is intermittent: it disappears when you test and returns under load, which
// is the worst way for a reviewer to meet it. Observed: four consecutive /verify
// rejections at 57_031–57_038 stroops, and a settlement that squeaked through at
// max_fee 57_227 an hour later.
//
// 500_000 stroops is 0.05 XLM. It is 8.7x the observed simulation and still small
// enough to catch a genuinely runaway transaction, which is what the ceiling is for.
// The FEEPAYER pays this, never the buyer.
const MAX_TRANSACTION_FEE_STROOPS = Number(
  process.env.MAX_TRANSACTION_FEE_STROOPS ?? 500_000,
);

const stellarScheme = new ExactStellarScheme([feePayerSigner], {
  rpcConfig: { url: STELLAR_RPC_URL },
  areFeesSponsored: true,
  feeBumpSigner: feePayerSigner,
  maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
});

const facilitator = new x402Facilitator().register(NETWORK, stellarScheme);
try {
  facilitator.registerExtension(BAZAAR);
} catch (e) {
  console.warn(`[facilitator] BAZAAR extension registration failed: ${e.message}`);
}

// ---------------------------------------------------------------------------
// SSE event bus — lets the web console watch the payment loop live.
// ---------------------------------------------------------------------------

const sseClients = new Set();

function emit(event) {
  const payload = { ts: Date.now(), ...event };
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
  console.log(`[event] ${payload.type}`, payload.detail ?? "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept both spec field names and common aliases so we never 400 on a nit. */
function readPaymentBody(body = {}) {
  const paymentPayload = body.paymentPayload ?? body.payload ?? body.payment;
  const paymentRequirements =
    body.paymentRequirements ?? body.requirements ?? body.accepts?.[0];
  return { paymentPayload, paymentRequirements };
}

/** Every rejection MUST carry a non-null human-readable reason (RFP hard criterion). */
function reasonOf(value, fallback) {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const s = value.message ?? value.reason ?? value.error;
    if (typeof s === "string" && s.trim()) return s;
  }
  return fallback;
}

/** Turn a machine code such as `unexpected_verify_error` into a readable sentence. */
function humanize(code) {
  const words = String(code).replace(/[_-]+/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Build the human-readable rejection reason the RFP requires.
 *
 * `@x402/stellar` reports failures as short machine codes (`unexpected_verify_error`,
 * `insufficient_funds`, …) and sometimes a richer `invalidMessage`/`errorMessage`.
 * A bare code is not human-readable, so we always emit a sentence and keep the raw
 * code appended in brackets for machine consumers.
 */
function explainRejection(result, codeField, messageField, fallback) {
  const code = result?.[codeField];
  const message = result?.[messageField];

  const hasSentence = typeof message === "string" && message.trim().length > 0;
  const hasCode = typeof code === "string" && code.trim().length > 0;

  if (hasSentence && hasCode) return `${message.trim()} [${code.trim()}]`;
  if (hasSentence) return message.trim();
  if (hasCode) {
    const readable = humanize(code);
    // Already a sentence (contains a space)? Then leave it be.
    return code.includes(" ") ? code : `${readable} [${code.trim()}]`;
  }
  return fallback;
}

function encodeExtensionResponses(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** Pull bazaar discovery metadata off the payload/requirements, if present. */
function readDiscovery(paymentPayload, paymentRequirements) {
  // Preferred: the library's own extractor.
  for (const fn of [
    () => validateAndExtract?.(paymentRequirements, paymentPayload),
    () => extractDiscoveryInfo?.(paymentRequirements),
    () => extractDiscoveryInfo?.(paymentPayload),
  ]) {
    try {
      const out = fn();
      if (out && (out.info || out.input || out.discoveryInfo)) return out;
    } catch {
      /* try the next strategy */
    }
  }
  // Fallback: read the raw extension block we know the seller attaches.
  const raw =
    paymentPayload?.extensions?.bazaar ??
    paymentRequirements?.extensions?.bazaar ??
    paymentRequirements?.extra?.bazaar ??
    paymentRequirements?.outputSchema?.bazaar;
  return raw ?? null;
}

/**
 * Map an x402 settle into the canonical catalog record from CONTRACT.md.
 *
 * NOTE on shapes: in x402 **v2** the resource metadata lives on
 * `PaymentPayload.resource` (a ResourceInfo), NOT on PaymentRequirements, and the
 * price field is `amount` — v1 called it `maxAmountRequired` and inlined the
 * resource. We read both so either version settles cleanly.
 */
function toCatalogRecord(paymentPayload, paymentRequirements, discovery) {
  const info = discovery?.info ?? discovery ?? {};
  const input = info.input ?? {};

  // v2: payload.resource (ResourceInfo). v1: requirements.resource (a bare url string).
  const resourceInfo =
    paymentPayload?.resource ??
    (typeof paymentRequirements?.resource === "string"
      ? { url: paymentRequirements.resource, description: paymentRequirements.description }
      : (paymentRequirements?.resource ?? {}));

  const url = resourceInfo.url ?? "";
  const meta = paymentRequirements?.extra ?? {};
  const id = input.toolName ? `${url}#${input.toolName}` : url;

  return {
    id,
    resource: {
      url,
      serviceName: resourceInfo.serviceName ?? meta.serviceName ?? "stellarsight-seller",
      tags: resourceInfo.tags ?? discovery?.tags ?? meta.tags ?? [],
      iconUrl: resourceInfo.iconUrl ?? discovery?.iconUrl ?? meta.iconUrl,
      description: resourceInfo.description ?? paymentRequirements?.description ?? "",
    },
    type: input.type === "mcp" ? "mcp" : "http",
    network: paymentRequirements?.network ?? NETWORK,
    scheme: paymentRequirements?.scheme ?? "exact",
    payTo: paymentRequirements?.payTo ?? SELLER_PUBLIC,
    asset: paymentRequirements?.asset ?? ASSET_SAC,
    maxAmountRequired: String(
      paymentRequirements?.amount ?? paymentRequirements?.maxAmountRequired ?? "0",
    ),
    input,
    output: info.output ?? { type: "json" },
    routeTemplate: discovery?.routeTemplate ?? info.routeTemplate,
    extensions: ["bazaar"],
    lastSeenAt: Date.now(),
    settlements: 1,
  };
}

// ---------------------------------------------------------------------------
// Facilitator app (4021)
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: true, exposedHeaders: ["EXTENSION-RESPONSES", "X-PAYMENT-RESPONSE"] }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "stellarsight-facilitator",
    network: NETWORK,
    asset: ASSET_SAC,
    assetCode: ASSET_CODE,
    feePayer: feePayerSigner.address,
    areFeesSponsored: true,
    indexBackend: usingIndexStub ? "stub" : "packages/index",
    catalogSize: catalog.size(),
  });
});

app.get("/supported", (_req, res) => {
  let kinds;
  try {
    const supported = facilitator.getSupported();
    kinds = (supported.kinds ?? []).map((k) => ({
      ...k,
      x402Version: k.x402Version ?? 2,
      extra: { ...(k.extra ?? {}), areFeesSponsored: true, asset: ASSET_SAC },
    }));
  } catch (e) {
    console.warn(`[supported] getSupported failed (${e.message}) — using static kind`);
    kinds = [];
  }
  if (!kinds.length) {
    kinds = [
      {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: { areFeesSponsored: true, asset: ASSET_SAC },
      },
    ];
  }
  res.json({ kinds });
});

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = readPaymentBody(req.body);

  if (!paymentPayload || !paymentRequirements) {
    const invalidReason =
      "Request body must include both `paymentPayload` and `paymentRequirements`.";
    emit({ type: "verify", ok: false, detail: invalidReason });
    return res.status(400).json({ isValid: false, invalidReason, payer: null });
  }

  try {
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    const isValid = Boolean(result?.isValid);
    const invalidReason = isValid
      ? null
      : explainRejection(
          result,
          "invalidReason",
          "invalidMessage",
          "Payment verification failed for an unspecified reason.",
        );
    const payer = result?.payer ?? paymentPayload?.payload?.from ?? null;

    emit({
      type: "verify",
      ok: isValid,
      payer,
      detail: isValid ? "payment authorization valid" : invalidReason,
    });
    return res.json({ isValid, invalidReason, payer });
  } catch (e) {
    const invalidReason = reasonOf(e, "Verification threw an unexpected error.");
    emit({ type: "verify", ok: false, detail: invalidReason });
    return res.json({ isValid: false, invalidReason, payer: null });
  }
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = readPaymentBody(req.body);

  if (!paymentPayload || !paymentRequirements) {
    const errorReason =
      "Request body must include both `paymentPayload` and `paymentRequirements`.";
    emit({ type: "settle", ok: false, detail: errorReason });
    return res.status(400).json({
      success: false,
      errorReason,
      transaction: null,
      network: NETWORK,
      payer: null,
    });
  }

  let bazaarResponse = null;

  try {
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    const success = Boolean(result?.success);
    const errorReason = success
      ? null
      : explainRejection(
          result,
          "errorReason",
          "errorMessage",
          "Settlement failed for an unspecified reason.",
        );
    const transaction = result?.transaction ?? null;
    const payer = result?.payer ?? paymentPayload?.payload?.from ?? null;

    emit({
      type: "settle",
      ok: success,
      payer,
      transaction,
      explorer: transaction
        ? `https://stellar.expert/explorer/testnet/tx/${transaction}`
        : null,
      detail: success ? "settled on stellar testnet" : errorReason,
    });

    // --- bazaar discovery: auto-catalog the resource on a successful settle ---
    if (success) {
      const discovery = readDiscovery(paymentPayload, paymentRequirements);
      if (discovery) {
        try {
          const record = toCatalogRecord(paymentPayload, paymentRequirements, discovery);
          // Prefer the O(1) keyed lookup. The previous `list({ limit: 1000 })` scan was
          // silently capped at the catalog's MAX_LIMIT of 100 — harmless while the index
          // held three records, but now that it boots seeded a resource beyond the first
          // page would look brand new and have its settlement history reset on every
          // settle. `list` stays as the fallback for the in-memory stub, which has no get().
          const prior =
            catalog.get?.(record.id) ??
            catalog.list({ limit: 100 }).items.find((i) => i.id === record.id);
          if (prior) record.settlements = (prior.settlements ?? 0) + 1;

          const up = catalog.upsert(record);
          if (up?.ok) {
            bazaarResponse = { status: "success" };
            emit({
              type: "catalog",
              ok: true,
              id: record.id,
              settlements: record.settlements,
              detail: `cataloged ${record.id}`,
            });
          } else {
            bazaarResponse = {
              status: "rejected",
              rejectedReason: reasonOf(up?.reason, "Catalog rejected the resource record."),
            };
            emit({ type: "catalog", ok: false, detail: bazaarResponse.rejectedReason });
          }
        } catch (e) {
          bazaarResponse = {
            status: "rejected",
            rejectedReason: reasonOf(e, "Cataloging threw an unexpected error."),
          };
          emit({ type: "catalog", ok: false, detail: bazaarResponse.rejectedReason });
        }
      }
    }

    if (bazaarResponse) {
      res.setHeader("EXTENSION-RESPONSES", encodeExtensionResponses({ bazaar: bazaarResponse }));
    }
    return res.json({ success, errorReason, transaction, network: NETWORK, payer });
  } catch (e) {
    const errorReason = reasonOf(e, "Settlement threw an unexpected error.");
    emit({ type: "settle", ok: false, detail: errorReason });
    return res.json({
      success: false,
      errorReason,
      transaction: null,
      network: NETWORK,
      payer: null,
    });
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now(), detail: "connected" })}\n\n`);
  sseClients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connection closing */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Bazaar index app (4022) — HTTP surface over packages/index.
// ---------------------------------------------------------------------------

const indexApp = express();
indexApp.use(cors({ origin: true }));
indexApp.use(express.json({ limit: "2mb" }));

indexApp.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "stellarsight-index",
    backend: usingIndexStub ? "stub" : "packages/index",
    size: catalog.size(),
  }),
);

indexApp.get("/discovery/resources", (req, res) => {
  try {
    const { type, payTo, scheme, network, extensions } = req.query;
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const offset = Number(req.query.offset ?? 0) || 0;
    const out = catalog.list({
      type,
      payTo,
      scheme,
      network,
      extensions: extensions
        ? String(extensions)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      limit,
      offset,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ items: [], total: 0, error: reasonOf(e, "list failed") });
  }
});

indexApp.get("/discovery/search", (req, res) => {
  try {
    const { query = "", cursor, type, payTo, scheme, network } = req.query;
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const out = catalog.search({ query, limit, cursor, type, payTo, scheme, network });
    res.json(out);
  } catch (e) {
    res.status(500).json({
      items: [],
      partialResults: true,
      pagination: { limit: 20, cursor: null },
      error: reasonOf(e, "search failed"),
    });
  }
});

/** Lets the seller pre-register routes at boot so discovery works before any payment. */
indexApp.post("/discovery/resources", (req, res) => {
  try {
    const out = catalog.upsert(req.body);
    if (out?.ok) emit({ type: "catalog", ok: true, id: req.body?.id, detail: "pre-registered" });
    res.status(out?.ok ? 200 : 400).json(out ?? { ok: false, dropped: [], reason: "upsert failed" });
  } catch (e) {
    res.status(400).json({ ok: false, dropped: [], reason: reasonOf(e, "upsert failed") });
  }
});

// ---------------------------------------------------------------------------
// Boot
//
// Only when executed directly (`node apps/facilitator/src/server.mjs`). When this module
// is imported — api/facilitator.mjs wraps `app` as a Vercel function so /supported,
// /verify and /settle answer on the public domain — binding ports would crash the
// runtime. The hand-rolled indexApp stays local-only either way: the deployed discovery
// API is api/discovery/*, which serves the same packages/index without the KNOWN DRIFT
// documented in CONTRACT.md.
// ---------------------------------------------------------------------------

const runDirect =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirect) {
  app.listen(FACILITATOR_PORT, () => {
    console.log(`\n[facilitator] x402 facilitator  http://localhost:${FACILITATOR_PORT}`);
    console.log(`[facilitator]   GET  /supported  /health  /events`);
    console.log(`[facilitator]   POST /verify     /settle`);
    console.log(`[facilitator]   asset   ${ASSET_CODE} ${ASSET_SAC}`);
    console.log(`[facilitator]   feePayer ${feePayerSigner.address} (fees sponsored)`);
  });

  indexApp.listen(INDEX_PORT, () => {
    console.log(`[index]       bazaar index    http://localhost:${INDEX_PORT}`);
    console.log(`[index]         GET /discovery/resources  /discovery/search`);
    console.log(`[index]         backend: ${usingIndexStub ? "in-memory stub" : "packages/index"}\n`);
  });
}

export { app, indexApp };
