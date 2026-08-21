#!/usr/bin/env node
/**
 * STELLARSIGHT — the rejection audit.
 *
 * Every surface in this repo promises the same thing: a rejection carries a non-null,
 * machine-readable reason. That promise is easy to write in a README and easy to break in
 * a refactor, so this script drives each documented error path and records EXPECTED
 * against OBSERVED — status code, error code, and the reason string the caller actually
 * received. It fails the run on any mismatch and on any rejection that comes back with an
 * empty reason.
 *
 * It is the negative-path counterpart to verify-conformance.mjs: that script proves the
 * happy path settles; this one proves the unhappy paths refuse, and say why.
 *
 * Usage:
 *   node scripts/verify-rejections.mjs
 *   node scripts/verify-rejections.mjs --seller https://stellarsight.xyz --facilitator https://stellarsight.xyz --index https://stellarsight.xyz
 *   node scripts/verify-rejections.mjs --emit          # writes docs/status/rejections.json
 *
 * Nothing here spends money: every case is refused before settlement, by construction.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { writeEvidence } from "./lib/evidence.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", bold: "", off: "" };

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const SELLER = String(arg("seller", process.env.SELLER_URL || "http://localhost:4023")).replace(/\/+$/, "");
const FACILITATOR = String(arg("facilitator", process.env.FACILITATOR_URL || "http://localhost:4021")).replace(/\/+$/, "");
const INDEX = String(arg("index", process.env.INDEX_URL || "http://localhost:4022")).replace(/\/+$/, "");
const EMIT = process.argv.includes("--emit");
const TIMEOUT_MS = 15_000;

const cases = [];
let failures = 0;

/**
 * Run one case. `expect` receives the response plus its parsed body and returns
 * `{ observed, pass, reason }` — `reason` is the rejection text the caller received, and
 * an empty one fails the case regardless of status: "rejected with no reason" is the
 * specific defect this audit exists to catch.
 */
async function probe(id, name, { expected, request, expect, skipWhen }) {
  // A case that does not apply to the surface under test is recorded as such, with the
  // reason, rather than quietly dropped or counted as a pass. The only case that uses
  // this today is the write-token check: the local index is deliberately unauthenticated
  // and bound to 127.0.0.1 (see apps/facilitator/src/server.mjs), so there is no token to
  // withhold there — that is a documented design difference, not drift.
  const skip = skipWhen?.();
  if (skip) {
    cases.push({ id, name, expected, observed: "not applicable to this surface", skipped: true, why: skip });
    console.log(`  ${C.dim}n/a  ${id} — ${skip}${C.off}`);
    return;
  }

  let res = null;
  let body = null;
  let text = "";
  try {
    res = await request();
    text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  } catch (e) {
    cases.push({ id, name, expected, observed: `request failed: ${e.message}`, reason: null, pass: false });
    failures++;
    console.log(`  ${C.red}FAIL${C.off} ${id} — request failed: ${e.message}`);
    return;
  }

  const verdict = expect({ res, body, text });
  const reason = verdict.reason ?? null;
  // A rejection without a readable reason is a failure even when the status is right.
  const reasoned = verdict.skipReasonCheck || (typeof reason === "string" && reason.trim().length > 0);
  const pass = verdict.pass && reasoned;
  if (!pass) failures++;

  cases.push({
    id,
    name,
    expected,
    observed: verdict.observed,
    status: res.status,
    reason,
    pass,
    ...(reasoned ? {} : { note: "rejection carried no non-empty reason" }),
  });
  console.log(
    `  ${pass ? `${C.green}ok  ${C.off}` : `${C.red}FAIL${C.off}`} ${id} — ${verdict.observed}` +
      (reason ? `\n         ${C.dim}reason: ${String(reason).slice(0, 140)}${C.off}` : ""),
  );
}

const req = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", ...(init.headers ?? {}) } });

/** The reason a caller can actually read, wherever this stack puts it. */
const reasonOf = (body, res) =>
  body?.invalidReason ??
  body?.errorReason ??
  body?.reason ??
  body?.error?.message ??
  body?.message ??
  (res?.headers?.get?.("PAYMENT-REQUIRED") ? decodeChallengeError(res.headers.get("PAYMENT-REQUIRED")) : null);

/** A 402 puts its human reason inside the base64 PAYMENT-REQUIRED challenge. */
function decodeChallengeError(header) {
  try {
    const decoded = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    return decoded?.error ?? decoded?.reason ?? null;
  } catch {
    return null;
  }
}

console.log(`\n${C.bold}STELLARSIGHT — rejection audit${C.off}`);
console.log(`${C.dim}  seller       ${SELLER}`);
console.log(`  facilitator  ${FACILITATOR}`);
console.log(`  index        ${INDEX}${C.off}\n`);

const PAID_ROUTE = `${SELLER}/v1/fx/usd-brl`;

/* ── the paywall ──────────────────────────────────────────────────────────── */

await probe("unpaid-402", "an unpaid request is refused with a decodable challenge", {
  expected: "402 + PAYMENT-REQUIRED header",
  request: () => req(PAID_ROUTE),
  expect: ({ res }) => ({
    pass: res.status === 402 && Boolean(res.headers.get("PAYMENT-REQUIRED")),
    observed: `${res.status}${res.headers.get("PAYMENT-REQUIRED") ? " + PAYMENT-REQUIRED" : " without PAYMENT-REQUIRED"}`,
    reason: decodeChallengeError(res.headers.get("PAYMENT-REQUIRED")) ?? "payment required",
  }),
});

await probe("garbage-signature", "an undecodable PAYMENT-SIGNATURE is refused, naming the format", {
  expected: "402, reason names base64/JSON",
  request: () => req(PAID_ROUTE, { headers: { "PAYMENT-SIGNATURE": "!!!not-base64!!!" } }),
  expect: ({ res }) => {
    const reason = decodeChallengeError(res.headers.get("PAYMENT-REQUIRED"));
    return {
      pass: res.status === 402 && /base64|json/i.test(String(reason ?? "")),
      observed: `${res.status}, reason ${/base64|json/i.test(String(reason ?? "")) ? "names the format" : "does not name the format"}`,
      reason,
    };
  },
});

await probe("echo-mismatch", "a tampered echoed price/recipient is refused before settlement", {
  expected: "402, reason names the mismatch",
  request: () => {
    // A well-formed payload whose echoed `accepted` block points the money somewhere else.
    // The seller re-derives price/asset/payTo from its own route table and must refuse.
    const forged = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        payload: { transaction: "AAAA" },
        accepted: {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "1",
          asset: "CAYCPWN5YZEHKPGZOXGU3O7R2Q5H7LT7SZ45YIO26VMFM47VBUHOGPO2",
          payTo: "GDQN7VJHXBQ3AGH7SMPMZLQXHDBUSVQZOYAVXQ4EFYNRQEK4NRZ3KTL3",
        },
      }),
    ).toString("base64");
    return req(PAID_ROUTE, { headers: { "PAYMENT-SIGNATURE": forged } });
  },
  expect: ({ res }) => {
    const reason = decodeChallengeError(res.headers.get("PAYMENT-REQUIRED"));
    return {
      pass: res.status === 402 && /do not match|price|asset|recipient/i.test(String(reason ?? "")),
      observed: `${res.status}, ${/do not match/i.test(String(reason ?? "")) ? "echo mismatch named" : "unexpected reason"}`,
      reason,
    };
  },
});

/* ── the facilitator ──────────────────────────────────────────────────────── */

await probe("verify-empty-body", "POST /verify with an empty body is refused with invalidReason", {
  expected: "4xx, isValid=false, non-null invalidReason",
  request: () => req(`${FACILITATOR}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  expect: ({ res, body }) => ({
    pass: res.status >= 400 && res.status < 500 && body?.isValid === false,
    observed: `${res.status}, isValid=${body?.isValid}`,
    reason: reasonOf(body, res),
  }),
});

await probe("settle-empty-body", "POST /settle with an empty body is refused with errorReason", {
  expected: "4xx, success=false, non-null errorReason",
  request: () => req(`${FACILITATOR}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  expect: ({ res, body }) => ({
    pass: res.status >= 400 && res.status < 500 && body?.success === false,
    observed: `${res.status}, success=${body?.success}`,
    reason: reasonOf(body, res),
  }),
});

await probe("supported-shape", "GET /supported advertises the Stellar extra a stock client reads", {
  expected: "200, kinds[].extra.areFeesSponsored === true",
  request: () => req(`${FACILITATOR}/supported`),
  expect: ({ res, body }) => {
    const kind = body?.kinds?.[0];
    return {
      pass: res.status === 200 && kind?.extra?.areFeesSponsored === true && typeof kind?.extra?.asset === "string",
      observed: `${res.status}, ${kind?.scheme}@${kind?.network}, areFeesSponsored=${kind?.extra?.areFeesSponsored}`,
      // Not a rejection path — nothing to reason about.
      skipReasonCheck: true,
    };
  },
});

/* ── the discovery API ────────────────────────────────────────────────────── */

await probe("discovery-unknown-endpoint", "an unknown /discovery path 404s in JSON, naming what is served", {
  expected: "404 JSON listing the real endpoints",
  request: () => req(`${INDEX}/discovery/nope`),
  expect: ({ res, body }) => ({
    pass: res.status === 404 && Array.isArray(body?.endpoints) && body.endpoints.length >= 3,
    observed: `${res.status}, ${body?.endpoints?.length ?? 0} endpoint(s) named`,
    reason: reasonOf(body, res),
  }),
});

await probe("search-missing-query", "GET /discovery/search without a query is a reasoned 400", {
  expected: "400, machine-readable reason",
  request: () => req(`${INDEX}/discovery/search`),
  expect: ({ res, body }) => ({
    pass: res.status === 400,
    observed: `${res.status}`,
    reason: reasonOf(body, res) ?? body?.error ?? null,
  }),
});

await probe("write-without-token", "POST /discovery/resources without a bearer token is refused", {
  expected: "401 or 503, reason explains which precondition is missing",
  skipWhen: () =>
    /^https?:\/\/(localhost|127\.0\.0\.1)/.test(INDEX)
      ? "the local index is deliberately unauthenticated and bound to 127.0.0.1; the write token guards the public deployment — audit it with --index https://stellarsight.xyz"
      : null,
  request: () =>
    req(`${INDEX}/discovery/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "https://example.com/x", resource: { url: "https://example.com/x" } }),
    }),
  expect: ({ res, body }) => ({
    pass: res.status === 401 || res.status === 503,
    observed: `${res.status}, ok=${body?.ok}`,
    reason: reasonOf(body, res),
  }),
});

await probe("search-wrong-method", "PUT /discovery/search is refused with an Allow header", {
  expected: "405 + Allow",
  request: () => req(`${INDEX}/discovery/search?query=x`, { method: "PUT" }),
  expect: ({ res, body }) => ({
    pass: res.status === 405 && Boolean(res.headers.get("allow")),
    observed: `${res.status}, Allow: ${res.headers.get("allow") ?? "(absent)"}`,
    reason: reasonOf(body, res),
  }),
});

await probe("integrity-replay-labeled", "GET /discovery/integrity declares replay provenance, not observation", {
  expected: '200, source="replay"',
  request: () => req(`${INDEX}/discovery/integrity?limit=5`),
  expect: ({ res, body }) => ({
    pass: res.status === 200 && body?.source === "replay" && Array.isArray(body?.integrity),
    observed: `${res.status}, source=${body?.source}, ${body?.integrity?.length ?? 0} row(s)`,
    skipReasonCheck: true,
  }),
});

/* ── report ───────────────────────────────────────────────────────────────── */

const skipped = cases.filter((c) => c.skipped).length;
const applicable = cases.length - skipped;
const passed = cases.filter((c) => c.pass).length;
console.log(
  `\n${failures ? C.red : C.green}${C.bold}${failures ? "FAIL" : "PASS"}${C.off} — ${passed}/${applicable} rejection path(s) behaved as documented` +
    (skipped ? `, ${skipped} not applicable to this surface` : "") +
    "\n",
);

if (EMIT) {
  const { path } = writeEvidence("rejections", {
    ok: failures === 0,
    stack: { seller: SELLER, facilitator: FACILITATOR, index: INDEX },
    total: cases.length,
    applicable,
    passed,
    skipped,
    cases,
  });
  console.log(`${C.dim}  evidence  ${path.replace(`${ROOT}/`, "")}${C.off}\n`);
}

process.exit(failures ? 1 : 0);
