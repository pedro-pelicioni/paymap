#!/usr/bin/env node
/**
 * STELLARSIGHT — paid resource server (the "seller").
 *
 * Three paid endpoints behind x402, priced in SXT, each declaring bazaar discovery
 * metadata so an agent can find them without a human ever reading docs.
 *
 * We implement the 402 challenge INLINE against our own facilitator rather than using
 * `@x402/express`'s paymentMiddleware. Reason: inline keeps the exact x402 v2 wire
 * shapes under our control and removes a layer we cannot debug inside the deadline.
 * All cryptography still comes from @x402/stellar via the facilitator — nothing is
 * reimplemented here.
 *
 * Real symbols used (verified against node_modules, not invented):
 *   @x402/extensions -> declareDiscoveryExtension(config) -> { bazaar: { info, schema } }
 *                       validateRouteTemplate(t) -> returns the template when valid, else undefined
 *   @x402/core/http  -> encodePaymentRequiredHeader / encodePaymentResponseHeader
 *                       decodePaymentSignatureHeader
 *
 * x402 v2 wire shapes (verified in @x402/core/dist/esm/x402Client-*.d.mts):
 *   PaymentRequired = { x402Version, error?, resource: ResourceInfo, accepts: PaymentRequirements[], extensions? }
 *   PaymentRequirements = { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
 *   PaymentPayload = { x402Version, resource?, accepted: PaymentRequirements, payload, extensions? }
 *   ResourceInfo = { url, description?, mimeType?, serviceName?, tags?, iconUrl? }
 *
 * x402 v2 HTTP transport (specs/transports-v2/http.md):
 *   402 challenge  -> response header `PAYMENT-REQUIRED`  — "the canonical HTTP transport
 *                     location for the PaymentRequired object". The body is explicitly "a
 *                     server implementation concern"; the spec's own example ships `{}`.
 *   signed payload -> request  header `PAYMENT-SIGNATURE`
 *   settlement     -> response header `PAYMENT-RESPONSE`
 * We use the SDK's own codecs for all three rather than hand-rolling base64, so the wire
 * format cannot drift from what a stock client decodes. The v1 spellings (`X-PAYMENT`,
 * `X-PAYMENT-RESPONSE`) and the JSON challenge body are kept purely for backward
 * compatibility with older clients — nothing here depends on them.
 *
 * `scripts/verify-conformance.mjs` proves this by driving an unmodified @x402/fetch client
 * through the whole loop; `npm run verify:conformance`.
 *
 * Port: 4023
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { declareDiscoveryExtension, validateRouteTemplate } from "@x402/extensions";
import {
  PAYMENT_REQUIRED_CACHE_CONTROL,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const {
  ASSET_SAC,
  ASSET_CODE = "SXT",
  SELLER_PUBLIC,
  FACILITATOR_URL = "http://localhost:4021",
  INDEX_URL = "http://localhost:4022",
} = process.env;

const NETWORK = "stellar:testnet";
const PORT = 4023;
const SELF_URL = process.env.SELLER_URL || `http://localhost:${PORT}`;
const X402_VERSION = 2;
const DECIMALS = 7; // classic Stellar assets (and their SACs) use 7 decimals

if (!ASSET_SAC || !SELLER_PUBLIC) {
  console.error("[seller] ASSET_SAC / SELLER_PUBLIC missing — run `npm run setup` first.");
  process.exit(1);
}

/** Convert a human SXT amount to atomic token units. */
const atomic = (n) => String(Math.round(Number(n) * 10 ** DECIMALS));

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const POSTAL_CODES = {
  "01310100": {
    postalCode: "01310-100",
    street: "Avenida Paulista",
    neighborhood: "Bela Vista",
    city: "Sao Paulo",
    state: "SP",
    country: "BR",
  },
  "20031170": {
    postalCode: "20031-170",
    street: "Avenida Rio Branco",
    neighborhood: "Centro",
    city: "Rio de Janeiro",
    state: "RJ",
    country: "BR",
  },
  "70150900": {
    postalCode: "70150-900",
    street: "Praca dos Tres Poderes",
    neighborhood: "Zona Civica",
    city: "Brasilia",
    state: "DF",
    country: "BR",
  },
};

// ---------------------------------------------------------------------------
// Route catalogue — the single source of truth for pricing, handlers and discovery
// ---------------------------------------------------------------------------

/**
 * Each entry declares its own bazaar discovery extension with PER-PARAMETER
 * DESCRIPTIONS (RFP 3.2 seller helpers). `declareDiscoveryExtension` returns
 * `{ bazaar: { info, schema } }`; `method` is normally filled in by the resource
 * server extension, so we inject it ourselves since we run the challenge inline.
 */
const ROUTES = [
  {
    key: "fx",
    method: "GET",
    path: "/v1/fx/usd-brl",
    aliases: [],
    priceSxt: 0.01,
    serviceName: "stellarsight-fx",
    description: "USD/BRL exchange rate with bid, ask and mid price.",
    tags: ["fx", "forex", "usd", "brl", "quote", "finance"],
    discovery: declareDiscoveryExtension({
      input: {},
      inputSchema: { properties: {}, required: [] },
      output: {
        example: {
          pair: "USD/BRL",
          bid: 5.4312,
          ask: 5.4389,
          mid: 5.435,
          asOf: "2026-08-06T12:00:00.000Z",
          source: "stellarsight-mock",
        },
      },
    }),
    handler: () => {
      const mid = 5.435 + (Math.random() - 0.5) * 0.02;
      return {
        pair: "USD/BRL",
        bid: Number((mid - 0.0038).toFixed(4)),
        ask: Number((mid + 0.0039).toFixed(4)),
        mid: Number(mid.toFixed(4)),
        asOf: new Date().toISOString(),
        source: "stellarsight-mock",
      };
    },
  },
  {
    key: "postal",
    method: "GET",
    // Brazilian postal-code lookup. This route uses a routeTemplate so the
    // traversal-validation path in the index is exercised.
    path: "/v1/cep/:cep",
    aliases: ["/v1/postal-code/:cep"],
    routeTemplate: "/v1/cep/:cep",
    priceSxt: 0.005,
    serviceName: "stellarsight-postal",
    description:
      "Brazilian postal code lookup returning street, neighborhood, city and state.",
    tags: ["postal-code", "address", "brazil", "geocoding", "lookup"],
    discovery: declareDiscoveryExtension({
      input: { cep: "01310100" },
      inputSchema: {
        properties: {
          cep: {
            type: "string",
            description:
              "Brazilian postal code, 8 digits, hyphen optional. Example: 01310100.",
          },
        },
        required: ["cep"],
      },
      pathParams: { cep: "01310100" },
      pathParamsSchema: {
        properties: {
          cep: {
            type: "string",
            description: "Brazilian postal code, 8 digits, hyphen optional.",
          },
        },
        required: ["cep"],
      },
      output: {
        example: {
          postalCode: "01310-100",
          street: "Avenida Paulista",
          neighborhood: "Bela Vista",
          city: "Sao Paulo",
          state: "SP",
          country: "BR",
        },
      },
    }),
    handler: (req) => {
      const raw = String(req.params.cep ?? "").replace(/\D/g, "");
      const hit = POSTAL_CODES[raw];
      if (hit) return { ...hit, found: true };
      return {
        postalCode: raw,
        found: false,
        message: "Postal code not present in the demo dataset.",
        knownSamples: Object.keys(POSTAL_CODES),
      };
    },
  },
  {
    key: "ocr",
    method: "POST",
    path: "/v1/ocr/nota-fiscal",
    aliases: ["/v1/ocr/invoice"],
    priceSxt: 0.05,
    serviceName: "stellarsight-ocr",
    description:
      "Invoice OCR — Brazilian electronic invoice (NF-e), returning structured line items and totals.",
    tags: ["ocr", "invoice", "nfe", "brazil", "document", "extraction"],
    discovery: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        imageUrl: "https://example.com/invoice.png",
        language: "pt-BR",
      },
      inputSchema: {
        properties: {
          imageUrl: {
            type: "string",
            description:
              "Publicly reachable URL of the invoice image or PDF to run OCR against.",
          },
          imageBase64: {
            type: "string",
            description:
              "Base64-encoded invoice image. Supply this instead of imageUrl for private documents.",
          },
          language: {
            type: "string",
            description: "BCP-47 language tag for the document. Defaults to pt-BR.",
          },
        },
        required: ["imageUrl"],
      },
      output: {
        example: {
          documentType: "NFe",
          accessKey: "35240612345678000199550010000012341000012345",
          issuer: { name: "Example Trading Ltd", taxId: "12.345.678/0001-99" },
          total: 1234.56,
          currency: "BRL",
          lineItems: [{ description: "Item A", quantity: 2, unitPrice: 100, total: 200 }],
          confidence: 0.97,
        },
      },
    }),
    handler: (req) => {
      const body = req.body ?? {};
      return {
        documentType: "NFe",
        accessKey: "35240612345678000199550010000012341000012345",
        issuedAt: new Date().toISOString(),
        issuer: { name: "Example Trading Ltd", taxId: "12.345.678/0001-99" },
        recipient: { name: "Demo Customer Inc", taxId: "98.765.432/0001-10" },
        currency: "BRL",
        lineItems: [
          { description: "Consulting hours", quantity: 2, unitPrice: 400.0, total: 800.0 },
          { description: "Support plan", quantity: 1, unitPrice: 434.56, total: 434.56 },
        ],
        total: 1234.56,
        taxes: { icms: 148.15, pis: 8.15, cofins: 37.51 },
        confidence: 0.97,
        language: body.language ?? "pt-BR",
        sourceEcho: body.imageUrl ?? (body.imageBase64 ? "<base64>" : null),
        note: "Mock OCR output for demonstration purposes.",
      };
    },
  },
];

// Validate every routeTemplate up front — fail loudly at boot, never at request time.
for (const r of ROUTES) {
  if (!r.routeTemplate) continue;
  const ok = validateRouteTemplate(r.routeTemplate);
  if (!ok) {
    console.warn(
      `[seller] routeTemplate rejected by @x402/extensions: ${r.routeTemplate} — dropping it`,
    );
    delete r.routeTemplate;
  } else {
    console.log(`[seller] routeTemplate valid: ${r.routeTemplate}`);
  }
}

// ---------------------------------------------------------------------------
// x402 helpers
// ---------------------------------------------------------------------------

/** Build the discovery extension block, injecting the HTTP method and routeTemplate. */
function discoveryFor(route) {
  const block = JSON.parse(JSON.stringify(route.discovery)); // deep clone; never mutate the declaration
  if (block.bazaar?.info?.input) block.bazaar.info.input.method = route.method;
  if (route.routeTemplate) block.bazaar.routeTemplate = route.routeTemplate;
  return block;
}

function resourceInfoFor(route) {
  return {
    url: `${SELF_URL}${route.path}`,
    description: route.description,
    mimeType: "application/json",
    serviceName: route.serviceName,
    tags: route.tags,
  };
}

function requirementsFor(route) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET_SAC,
    amount: atomic(route.priceSxt),
    payTo: SELLER_PUBLIC,
    maxTimeoutSeconds: 120,
    extra: {
      assetCode: ASSET_CODE,
      humanAmount: `${route.priceSxt} ${ASSET_CODE}`,
      areFeesSponsored: true,
    },
  };
}

/** The x402 v2 `PaymentRequired` object for a route. */
function paymentRequiredFor(route, error) {
  return {
    x402Version: X402_VERSION,
    error,
    resource: resourceInfoFor(route),
    accepts: [requirementsFor(route)],
    extensions: discoveryFor(route),
  };
}

/**
 * Answer 402 the way the v2 HTTP transport specifies: the `PaymentRequired` object goes in
 * the `PAYMENT-REQUIRED` header, base64-encoded with the SDK's own encoder.
 *
 * The same object is ALSO mirrored into the JSON body. That is backward compatibility for
 * pre-header clients and a courtesy to anyone reading the wire with curl — it is not the
 * protocol. `@x402/core` only reads a body challenge when `x402Version === 1`, so a client
 * that finds nothing in the header finds nothing at all, which is exactly the failure this
 * seller used to produce.
 */
function send402(res, route, error) {
  const paymentRequired = paymentRequiredFor(route, error);
  return res
    .status(402)
    .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
    .set("Cache-Control", PAYMENT_REQUIRED_CACHE_CONTROL)
    .json(paymentRequired);
}

/**
 * Read the signed payload from wherever the client put it.
 * v2 clients send `PAYMENT-SIGNATURE`; `X-PAYMENT` is the v1 spelling, still accepted.
 */
function extractPaymentHeader(req) {
  const value = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (!value) return null;
  return {
    name: req.headers["payment-signature"] ? "PAYMENT-SIGNATURE" : "X-PAYMENT",
    value: Array.isArray(value) ? value[0] : value,
  };
}

async function callFacilitator(path, body) {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

// ---------------------------------------------------------------------------
// The paywall
// ---------------------------------------------------------------------------

function paywall(route) {
  return async (req, res, next) => {
    const header = extractPaymentHeader(req);

    if (!header) {
      return send402(res, route, "PAYMENT-SIGNATURE header is required.");
    }

    let paymentPayload;
    try {
      paymentPayload = decodePaymentSignatureHeader(header.value);
    } catch (e) {
      return send402(
        res,
        route,
        `The ${header.name} header is not valid base64-encoded JSON: ${e.message}`,
      );
    }

    const paymentRequirements = paymentPayload.accepted ?? requirementsFor(route);

    // Never trust the client's echoed requirements about money.
    const expected = requirementsFor(route);
    if (
      paymentRequirements.payTo !== expected.payTo ||
      paymentRequirements.asset !== expected.asset ||
      BigInt(paymentRequirements.amount ?? 0) < BigInt(expected.amount)
    ) {
      return send402(
        res,
        route,
        `The payment requirements echoed in ${header.name} do not match this resource's price, asset or recipient.`,
      );
    }

    try {
      const verify = await callFacilitator("/verify", {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: expected,
      });

      if (!verify.json?.isValid) {
        const reason =
          verify.json?.invalidReason ?? "Facilitator rejected the payment without a reason.";
        console.log(`[seller] verify rejected: ${reason}`);
        return send402(res, route, reason);
      }

      const settle = await callFacilitator("/settle", {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: expected,
      });

      if (!settle.json?.success) {
        const reason =
          settle.json?.errorReason ?? "Facilitator failed to settle the payment without a reason.";
        console.log(`[seller] settle failed: ${reason}`);
        return send402(res, route, reason);
      }

      // Forward the settlement receipt and any extension responses to the client.
      // `PAYMENT-RESPONSE` is the v2 header a stock client reads first; `X-PAYMENT-RESPONSE`
      // is the v1 spelling, kept so older clients still see the receipt.
      const receipt = encodePaymentResponseHeader(settle.json);
      res.set("PAYMENT-RESPONSE", receipt);
      res.set("X-PAYMENT-RESPONSE", receipt);
      const extResponses = settle.headers?.get?.("EXTENSION-RESPONSES");
      if (extResponses) res.set("EXTENSION-RESPONSES", extResponses);

      console.log(
        `[seller] paid ${route.priceSxt} ${ASSET_CODE} -> ${route.path} tx=${settle.json.transaction}`,
      );
      req.x402 = settle.json;
      return next();
    } catch (e) {
      return send402(res, route, `Could not reach the facilitator at ${FACILITATOR_URL}: ${e.message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
// A browser client can only read the x402 headers if they are explicitly exposed, and can
// only send PAYMENT-SIGNATURE if preflight allows it. Both lists carry the v2 names first
// and the v1 spellings after.
app.use(
  cors({
    origin: true,
    exposedHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-PAYMENT-RESPONSE",
      "EXTENSION-RESPONSES",
    ],
    allowedHeaders: [
      "content-type",
      "accept",
      "payment-signature",
      "x-payment",
      "access-control-expose-headers",
    ],
  }),
);
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "stellarsight-seller",
    network: NETWORK,
    asset: ASSET_SAC,
    assetCode: ASSET_CODE,
    payTo: SELLER_PUBLIC,
    facilitator: FACILITATOR_URL,
    routes: ROUTES.map((r) => ({
      method: r.method,
      path: r.path,
      price: `${r.priceSxt} ${ASSET_CODE}`,
    })),
  }),
);

/** Machine-readable catalogue of everything this seller offers. */
app.get("/.well-known/x402", (_req, res) =>
  res.json({
    x402Version: X402_VERSION,
    resources: ROUTES.map((r) => ({
      resource: resourceInfoFor(r),
      accepts: [requirementsFor(r)],
      extensions: discoveryFor(r),
      routeTemplate: r.routeTemplate,
    })),
  }),
);

for (const route of ROUTES) {
  const paths = [route.path, ...(route.aliases ?? [])];
  const verb = route.method.toLowerCase();
  for (const p of paths) {
    app[verb](p, paywall(route), (req, res) => {
      res.json({
        ok: true,
        data: route.handler(req),
        paidWith: {
          asset: ASSET_CODE,
          amount: `${route.priceSxt}`,
          transaction: req.x402?.transaction ?? null,
          explorer: req.x402?.transaction
            ? `https://stellar.expert/explorer/testnet/tx/${req.x402.transaction}`
            : null,
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Boot — pre-register routes with the bazaar index so discovery works before any
// payment has ever been settled.
// ---------------------------------------------------------------------------

async function preRegister({ quiet = false } = {}) {
  for (const route of ROUTES) {
    const disc = discoveryFor(route);
    const record = {
      id: `${SELF_URL}${route.path}`,
      resource: {
        url: `${SELF_URL}${route.path}`,
        serviceName: route.serviceName,
        tags: route.tags,
        description: route.description,
      },
      type: "http",
      network: NETWORK,
      scheme: "exact",
      payTo: SELLER_PUBLIC,
      asset: ASSET_SAC,
      maxAmountRequired: atomic(route.priceSxt),
      input: disc.bazaar?.info?.input ?? { type: "http", method: route.method },
      output: disc.bazaar?.info?.output ?? { type: "json" },
      routeTemplate: route.routeTemplate,
      extensions: ["bazaar"],
      lastSeenAt: Date.now(),
      settlements: 0,
    };
    try {
      const res = await fetch(`${INDEX_URL}/discovery/resources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!quiet) console.log(`[seller] pre-registered ${route.path} -> ${res.status}`);
    } catch (e) {
      if (!quiet) console.warn(`[seller] could not pre-register ${route.path}: ${e.message}`);
    }
  }
}

app.listen(PORT, async () => {
  console.log(`\n[seller] STELLARSIGHT paid API  http://localhost:${PORT}`);
  for (const r of ROUTES) {
    console.log(
      `[seller]   ${r.method.padEnd(4)} ${r.path.padEnd(24)} ${r.priceSxt} ${ASSET_CODE}`,
    );
  }
  console.log(`[seller]   asset ${ASSET_CODE} ${ASSET_SAC}`);
  console.log(`[seller]   payTo ${SELLER_PUBLIC}\n`);
  // Give the facilitator/index a moment if they booted together.
  setTimeout(preRegister, 1200);
  // The index is in-memory, so it empties whenever the facilitator restarts.
  // Re-announce ourselves periodically to heal that without any manual step.
  setInterval(() => preRegister({ quiet: true }), 30_000).unref?.();
});
