/**
 * test/express-middleware.test.mjs — @stellarsight/express, the installable seller paywall.
 *
 * Run with:  npm test        (or: node --test test/express-middleware.test.mjs)
 *
 * NOTHING HERE TOUCHES TESTNET. The facilitator and the bazaar index are stubbed with
 * local `node:http` servers on ephemeral ports, which is also what makes the hostile
 * cases testable at all: a real facilitator would reject a forged payload for its own
 * reasons and we would never learn whether the MIDDLEWARE would have caught it first.
 *
 * Four properties are under test, in order of how much money they protect:
 *
 *   TRUST      — `paymentPayload.accepted` is attacker-controlled. The middleware must
 *                re-derive price/asset/payTo/network from the route declaration and
 *                refuse any echo that disagrees, and must hand the FACILITATOR its own
 *                requirements rather than the client's.
 *   REASONS    — every rejection carries a non-null, human-readable reason. A 402 with
 *                `error: null` leaves the paying agent with no way to decide whether to
 *                retry, top up, or give up. This is a project-wide rule.
 *   WIRE       — the 402 challenge and the settlement receipt are encoded with
 *                `@x402/core`'s own codecs, so a stock client decodes exactly what a
 *                stock server would have written.
 *   DISCOVERY  — the bazaar extension is built by the stock `declareDiscoveryExtension`
 *                and is present on the challenge, in `/.well-known/x402`, and in the
 *                record announced to the index BEFORE any payment has been settled.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test, { after } from 'node:test';

import express from 'express';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { PaymentRequirementsSchema } from '@x402/core/schemas';

import { stellarsightPaywall, toAtomicUnits, x402CorsOptions } from '@stellarsight/express';

const NETWORK = 'stellar:testnet';
const PAY_TO = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_PAY_TO = 'GATTACKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ASSET = 'CASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ASSET = 'CFAKEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYER = 'GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'ffb6c8d2a1e0000000000000000000000000000000000000000000000000beef';
const BASE_URL = 'https://api.acme.test';
/** A closed port on loopback — connecting here fails fast instead of hanging. */
const DEAD_FACILITATOR = 'http://127.0.0.1:9';

const teardown = [];
after(async () => {
  for (const close of teardown.reverse()) await close();
});

/* ══════════════════════════════════════════════════════════════════════════
   Harness — stub facilitator, stub bazaar index, real Express seller
   ══════════════════════════════════════════════════════════════════════════ */

function startStub(handle) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      handle({ method: req.method, path: req.url, body, headers: req.headers }, res);
    });
  });
  server.listen(0, '127.0.0.1');
  teardown.push(() => new Promise((resolve) => server.close(resolve)));
  return once(server, 'listening').then(() => ({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  }));
}

const okVerify = () => ({ status: 200, json: { isValid: true, invalidReason: null, payer: PAYER } });
const okSettle = () => ({
  status: 200,
  json: { success: true, errorReason: null, transaction: TX, network: NETWORK, payer: PAYER },
});

/** A facilitator whose /verify and /settle answers can be swapped per test. */
async function startFacilitator() {
  const behaviour = { verify: okVerify, settle: okSettle };
  const calls = { verify: [], settle: [] };

  const { url } = await startStub((req, res) => {
    const kind = req.path === '/verify' ? 'verify' : req.path === '/settle' ? 'settle' : null;
    if (!kind || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    calls[kind].push(req.body);
    const out = behaviour[kind](req.body) ?? {};
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.json ?? {}));
  });

  return {
    url,
    calls,
    behaviour,
    reset() {
      behaviour.verify = okVerify;
      behaviour.settle = okSettle;
      calls.verify.length = 0;
      calls.settle.length = 0;
    },
  };
}

/** A bazaar index that records every announcement it receives. */
async function startIndex() {
  const records = [];
  const { url } = await startStub((req, res) => {
    if (req.method === 'POST' && req.path === '/discovery/resources') {
      records.push(req.body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dropped: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return { url, records };
}

function makePaywall(overrides = {}) {
  const pay = stellarsightPaywall({
    facilitator: DEAD_FACILITATOR,
    payTo: PAY_TO,
    asset: ASSET,
    assetCode: 'SXT',
    network: NETWORK,
    baseUrl: BASE_URL,
    announce: false,
    logger: false,
    facilitatorTimeoutMs: 2000,
    ...overrides,
  });
  teardown.push(() => pay.stop());
  return pay;
}

/** A real Express app behind the middleware, listening on an ephemeral port. */
async function startSeller({ paywall = {}, declare } = {}) {
  const pay = makePaywall(paywall);
  const app = express();
  app.use(express.json());

  (declare ?? defaultDeclare)(app, pay);

  const server = app.listen(0, '127.0.0.1');
  teardown.push(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  return { pay, app, url: `http://127.0.0.1:${server.address().port}` };
}

const defaultDeclare = (app, pay) => {
  app.get(
    '/v1/fx',
    pay('/v1/fx', {
      price: '0.02',
      serviceName: 'acme-fx',
      description: 'USD/BRL exchange rate with bid, ask and mid price.',
      tags: ['fx', 'forex'],
      output: { example: { pair: 'USD/BRL', mid: 5.435 } },
    }),
    (req, res) => res.json({ ok: true, stellarsight: req.stellarsight, x402: req.x402 }),
  );
  app.get('/.well-known/x402', pay.wellKnownHandler());
};

/** Fetch the 402 challenge and hand back the decoded PaymentRequired object. */
async function challenge(seller, path = '/v1/fx') {
  const res = await fetch(`${seller.url}${path}`);
  const header = res.headers.get('payment-required');
  assert.ok(header, 'the 402 must carry a PAYMENT-REQUIRED header');
  return { res, decoded: decodePaymentRequiredHeader(header) };
}

/** Replay a request with a signed payload echoing `accepted`. */
function paidFetch(seller, accepted, { path = '/v1/fx', header = 'PAYMENT-SIGNATURE', init = {} } = {}) {
  const value = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { signature: 'stub-signature', authorization: { from: PAYER } },
  });
  return fetch(`${seller.url}${path}`, { ...init, headers: { ...(init.headers ?? {}), [header]: value } });
}

/**
 * THE REASON INVARIANT, asserted on every rejection in this file.
 * A 402 whose `error` is null/empty in either the header or the body is a failure,
 * whatever else the response got right.
 */
async function assertRejection(res, matcher) {
  assert.equal(res.status, 402, 'a rejected payment must answer 402');
  const header = res.headers.get('payment-required');
  assert.ok(header, 'every 402 must carry a PAYMENT-REQUIRED header so the client can retry');

  const decoded = decodePaymentRequiredHeader(header);
  const body = await res.json();

  for (const [where, object] of [
    ['PAYMENT-REQUIRED header', decoded],
    ['JSON body', body],
  ]) {
    assert.notEqual(object.error, null, `the ${where} carried a null reason`);
    assert.equal(typeof object.error, 'string', `the ${where} carried a non-string reason`);
    assert.ok(object.error.trim().length > 0, `the ${where} carried an empty reason`);
  }
  if (matcher) assert.match(decoded.error, matcher);
  return decoded;
}

/** Poll until `predicate()` holds, or fail with `label` after `timeoutMs`. */
async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   The 402 challenge
   [x402 v2 HTTP transport: "the canonical HTTP transport location for the
    PaymentRequired object" is the PAYMENT-REQUIRED response header; the body is
    a server implementation concern]
   ══════════════════════════════════════════════════════════════════════════ */

test('challenge: an unpaid request answers 402 with a PAYMENT-REQUIRED header a stock client can decode', async () => {
  const seller = await startSeller();
  const { res, decoded } = await challenge(seller);

  assert.equal(res.status, 402);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepts.length, 1);
  assert.equal(decoded.resource.url, `${BASE_URL}/v1/fx`);
  assert.equal(decoded.resource.serviceName, 'acme-fx');
  assert.deepEqual(decoded.resource.tags, ['fx', 'forex']);
  // The reason invariant applies to the very first 402 too — "you have not paid" is
  // still a rejection and still has to say so.
  assert.equal(typeof decoded.error, 'string');
  assert.match(decoded.error, /PAYMENT-SIGNATURE/);
});

test('challenge: accepts[0] validates against @x402/core PaymentRequirementsSchema', async () => {
  // [CONTRACT.md: x402 v2 names the price `amount`, NOT `maxAmountRequired`; the v1 name
  //  fails PaymentRequirementsSchema in the installed @x402/core]
  // Reading back our own field names would only prove we are self-consistent. Parsing
  // with the SDK's own schema is what proves a stock client can construct a payment.
  const seller = await startSeller();
  const { decoded } = await challenge(seller);

  const parsed = PaymentRequirementsSchema.parse(decoded.accepts[0]);
  assert.equal(parsed.scheme, 'exact');
  assert.equal(parsed.network, NETWORK);
  assert.equal(parsed.asset, ASSET);
  assert.equal(parsed.payTo, PAY_TO);
  assert.equal(parsed.amount, '200000');
  assert.equal(decoded.accepts[0].extra.humanAmount, '0.02 SXT');
  assert.equal(decoded.accepts[0].extra.areFeesSponsored, true);
});

test('challenge: the JSON body mirrors the header object and the response is uncacheable', async () => {
  // The body mirror is backward compatibility for pre-header clients and for anyone
  // reading the wire with curl — but it must not DIVERGE from the header, or the two
  // classes of client see two different prices.
  const seller = await startSeller();
  const { res, decoded } = await challenge(seller);

  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), decoded);
});

test('challenge: prices are converted to atomic units by string arithmetic, not floats', async () => {
  // Math.round(0.07 * 1e7) is 700000.0000000001 before rounding. Every "off by one
  // stroop" bug in a paid API starts exactly there.
  const seller = await startSeller({
    declare: (app, pay) => {
      app.get('/v1/seven', pay('/v1/seven', { price: '0.07' }), (_req, res) => res.json({ ok: true }));
      app.get('/v1/tiny', pay('/v1/tiny', { price: '0.0000001' }), (_req, res) => res.json({ ok: true }));
    },
  });

  assert.equal((await challenge(seller, '/v1/seven')).decoded.accepts[0].amount, '700000');
  assert.equal((await challenge(seller, '/v1/tiny')).decoded.accepts[0].amount, '1');
});

/* ══════════════════════════════════════════════════════════════════════════
   Discovery — the endpoint is findable BEFORE its first payment
   [@x402/extensions: declareDiscoveryExtension(config) -> { bazaar: { info, schema } }]
   ══════════════════════════════════════════════════════════════════════════ */

test('discovery: the 402 carries a well-formed bazaar extension built by declareDiscoveryExtension', async () => {
  const seller = await startSeller();
  const { decoded } = await challenge(seller);

  const bazaar = decoded.extensions?.bazaar;
  assert.ok(bazaar, 'the challenge must carry a bazaar discovery extension');

  // info — what an agent reads to learn how to CALL the endpoint.
  assert.equal(bazaar.info.input.type, 'http');
  // `method` is normally injected by the resource-server extension; we run the challenge
  // inline, so the middleware has to inject it or every listing is uncallable.
  assert.equal(bazaar.info.input.method, 'GET');
  assert.equal(bazaar.info.output.type, 'json');
  assert.deepEqual(bazaar.info.output.example, { pair: 'USD/BRL', mid: 5.435 });

  // schema — the machine-checkable description of `info`.
  assert.equal(bazaar.schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(bazaar.schema.type, 'object');
  assert.deepEqual(bazaar.schema.required, ['input']);
  assert.ok(bazaar.schema.properties.input.required.includes('method'));
  assert.deepEqual(bazaar.schema.properties.input.properties.method.enum, ['GET', 'HEAD', 'DELETE']);
});

test('discovery: query and path parameter documentation survives onto the wire', async () => {
  // RFP 3.2 seller helpers: per-parameter descriptions are the difference between an
  // agent that can call the endpoint and one that can only see that it exists.
  const seller = await startSeller({
    declare: (app, pay) => {
      app.get(
        '/v1/cep/:cep',
        pay('/v1/cep/:cep', {
          price: '0.005',
          serviceName: 'acme-postal',
          input: { cep: '01310100' },
          inputSchema: {
            properties: { cep: { type: 'string', description: 'Brazilian postal code, 8 digits.' } },
            required: ['cep'],
          },
          pathParams: { cep: '01310100' },
          output: { example: { city: 'Sao Paulo' } },
        }),
        (_req, res) => res.json({ ok: true }),
      );
    },
  });

  const { decoded } = await challenge(seller, '/v1/cep/01310100');
  const bazaar = decoded.extensions.bazaar;

  assert.deepEqual(bazaar.info.input.queryParams, { cep: '01310100' });
  assert.deepEqual(bazaar.info.input.pathParams, { cep: '01310100' });
  assert.equal(
    bazaar.schema.properties.input.properties.queryParams.properties.cep.description,
    'Brazilian postal code, 8 digits.',
  );
  // A parameterised path IS the routeTemplate — the developer should not have to say it twice.
  assert.equal(bazaar.routeTemplate, '/v1/cep/:cep');
});

test('discovery: a POST route declares bodyType and a body example', async () => {
  const seller = await startSeller({
    declare: (app, pay) => {
      app.post(
        '/v1/ocr',
        pay('/v1/ocr', {
          method: 'POST',
          price: '0.05',
          input: { imageUrl: 'https://example.com/invoice.png' },
          inputSchema: { properties: { imageUrl: { type: 'string' } }, required: ['imageUrl'] },
          output: { example: { total: 1234.56 } },
        }),
        (_req, res) => res.json({ ok: true }),
      );
    },
  });

  const res = await fetch(`${seller.url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const decoded = decodePaymentRequiredHeader(res.headers.get('payment-required'));
  const info = decoded.extensions.bazaar.info;

  assert.equal(info.input.method, 'POST');
  assert.equal(info.input.bodyType, 'json');
  assert.deepEqual(info.input.body, { imageUrl: 'https://example.com/invoice.png' });
});

test('discovery: a traversal-shaped routeTemplate is rejected when the route is DECLARED', async () => {
  // [spec: routeTemplate must not contain ".." or "://"] — the developer is looking at
  // their terminal at declaration time and is not at 3am when an agent pays.
  const pay = makePaywall();
  assert.throws(() => pay('/v1/thing', { price: '0.01', routeTemplate: '/a/../b' }), /routeTemplate/);
  assert.throws(
    () => pay('/v1/thing', { price: '0.01', routeTemplate: '/go/http://evil.example' }),
    /routeTemplate/,
  );
  // A legitimate template still passes.
  assert.doesNotThrow(() => pay('/v1/thing/:id', { price: '0.01' }));
});

test('discovery: each caller gets its own copy of the extension, so one consumer cannot poison the next', async () => {
  // The stored declaration is deep-cloned per use. Without that, anything that mutates a
  // challenge — a serializer, a logging middleware, a test — permanently corrupts the
  // metadata every later buyer sees.
  const pay = makePaywall();
  pay('/v1/thing', { price: '0.01', output: { example: { a: 1 } } });

  const first = pay.wellKnown();
  first.resources[0].extensions.bazaar.info.input.method = 'MUTATED';
  first.resources[0].extensions.bazaar.info.output.example.a = 999;

  const second = pay.wellKnown();
  assert.equal(second.resources[0].extensions.bazaar.info.input.method, 'GET');
  assert.equal(second.resources[0].extensions.bazaar.info.output.example.a, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
   TRUST — the client's echoed requirements are a hint, never an input to price
   ══════════════════════════════════════════════════════════════════════════ */

test('trust: an echoed amount below the real price is rejected', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, { ...decoded.accepts[0], amount: '1' });
  await assertRejection(res, /amount is 1 atomic units but this resource costs 200000/);
  assert.equal(facilitator.calls.verify.length, 0, 'a mismatched echo must never reach the facilitator');
});

test('trust: an echoed payTo pointing somewhere else is rejected', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, { ...decoded.accepts[0], payTo: OTHER_PAY_TO });
  await assertRejection(res, /payTo/);
  assert.equal(facilitator.calls.verify.length, 0);
});

test('trust: an echoed asset swapped for a worthless token is rejected', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, { ...decoded.accepts[0], asset: OTHER_ASSET });
  await assertRejection(res, /asset/);
  assert.equal(facilitator.calls.verify.length, 0);
});

test('trust: an echoed network moved to another chain is rejected', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, { ...decoded.accepts[0], network: 'eip155:8453' });
  await assertRejection(res, /network/);
});

test('trust: a non-integer echoed amount is rejected instead of crashing the request', async () => {
  // BigInt('0.02') and BigInt('1e9') both THROW. An unguarded comparison here turns a
  // hostile header into a 500 from the express error handler — which carries no reason,
  // no challenge, and no way for the client to recover.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  for (const amount of ['0.02', '1e9', '-200000', 'lots', '', null]) {
    const res = await paidFetch(seller, { ...decoded.accepts[0], amount });
    await assertRejection(res, /atomic units/);
  }
  assert.equal(facilitator.calls.verify.length, 0);
});

test('trust: an echo that reports several wrong fields names all of them', async () => {
  // One reason per response, but it must be diagnosable. Naming only the first wrong
  // field makes a misconfigured client fix one thing at a time across many round trips.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, {
    ...decoded.accepts[0],
    payTo: OTHER_PAY_TO,
    asset: OTHER_ASSET,
    amount: '1',
  });
  const rejection = await assertRejection(res);
  for (const field of ['payTo', 'asset', 'amount']) {
    assert.match(rejection.error, new RegExp(field), `the reason did not mention ${field}`);
  }
});

test('trust: overpaying is allowed', async () => {
  // Paying MORE than the price is the client's business — the seller has no reason to
  // refuse it, and a strict equality check would break any client that rounds up.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, { ...decoded.accepts[0], amount: '999999999' });
  assert.equal(res.status, 200);
});

test('trust: the facilitator is handed the SERVER\'s requirements, never the client\'s echo', async () => {
  // This is the property the whole file exists for. Even an echo that PASSES the
  // comparison (overpay, extra junk fields) must not be what /verify and /settle see —
  // otherwise `extra` becomes an attacker-controlled channel into the facilitator.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);
  const expected = decoded.accepts[0];

  const res = await paidFetch(seller, {
    ...expected,
    amount: '999999999',
    maxTimeoutSeconds: 999999,
    extra: { areFeesSponsored: true, sneaky: 'attacker-controlled' },
  });
  assert.equal(res.status, 200);

  for (const kind of ['verify', 'settle']) {
    assert.equal(facilitator.calls[kind].length, 1, `${kind} should have been called once`);
    const sent = facilitator.calls[kind][0].paymentRequirements;
    assert.deepEqual(sent, expected, `${kind} received requirements that were not the server's own`);
    assert.equal(sent.extra.sneaky, undefined);
    assert.equal(facilitator.calls[kind][0].x402Version, 2);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   REASONS — project-wide rule: no rejection is ever reasonless
   ══════════════════════════════════════════════════════════════════════════ */

test('reason: NO rejection path can emit a null or empty reason', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const dead = await startSeller({ paywall: { facilitator: DEAD_FACILITATOR, facilitatorTimeoutMs: 1500 } });
  const { decoded } = await challenge(seller);
  const good = decoded.accepts[0];

  const scenarios = [
    {
      name: 'no payment header at all',
      act: () => fetch(`${seller.url}/v1/fx`),
    },
    {
      name: 'a PAYMENT-SIGNATURE header that is not base64 JSON',
      act: () => fetch(`${seller.url}/v1/fx`, { headers: { 'PAYMENT-SIGNATURE': 'not-base64-!!!' } }),
    },
    {
      name: 'a header that decodes to a JSON scalar rather than a payload object',
      act: () =>
        fetch(`${seller.url}/v1/fx`, {
          headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify('hello')).toString('base64') },
        }),
    },
    {
      name: 'a payload with no signed authorization',
      act: () =>
        fetch(`${seller.url}/v1/fx`, {
          headers: {
            'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: good }),
          },
        }),
    },
    {
      name: 'an echoed price that does not match',
      act: () => paidFetch(seller, { ...good, amount: '1' }),
    },
    {
      name: 'the facilitator saying isValid:false and giving no invalidReason',
      arrange: () => {
        facilitator.behaviour.verify = () => ({ status: 200, json: { isValid: false, invalidReason: null } });
      },
      act: () => paidFetch(seller, good),
    },
    {
      name: 'the facilitator answering /verify with HTTP 500 and an empty object',
      arrange: () => {
        facilitator.behaviour.verify = () => ({ status: 500, json: {} });
      },
      act: () => paidFetch(seller, good),
    },
    {
      name: 'the facilitator answering /verify with HTML instead of JSON',
      arrange: () => {
        facilitator.behaviour.verify = () => ({ status: 502, raw: '<html>bad gateway</html>' });
      },
      act: () => paidFetch(seller, good),
    },
    {
      name: 'the facilitator saying success:false and giving no errorReason',
      arrange: () => {
        facilitator.behaviour.settle = () => ({ status: 200, json: { success: false, errorReason: null } });
      },
      act: () => paidFetch(seller, good),
    },
    {
      name: 'the facilitator dropping /settle with HTTP 503',
      arrange: () => {
        facilitator.behaviour.settle = () => ({ status: 503, json: { oops: true } });
      },
      act: () => paidFetch(seller, good),
    },
    {
      name: 'the facilitator being unreachable entirely',
      act: () => paidFetch(dead, good),
    },
  ];

  for (const scenario of scenarios) {
    facilitator.reset();
    scenario.arrange?.();
    const res = await scenario.act();
    const rejection = await assertRejection(res);
    assert.ok(
      rejection.error.length > 12,
      `"${scenario.name}" produced a reason too short to act on: ${JSON.stringify(rejection.error)}`,
    );
    // Every rejection is also a fresh, payable offer — never a dead end.
    assert.equal(rejection.accepts[0].amount, '200000', `"${scenario.name}" lost the price`);
    assert.ok(rejection.extensions?.bazaar, `"${scenario.name}" lost the discovery metadata`);
  }
});

test('reason: a facilitator rejection is quoted verbatim rather than paraphrased', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  facilitator.behaviour.verify = () => ({
    status: 200,
    json: { isValid: false, invalidReason: 'insufficient_funds: payer holds 0.001 SXT' },
  });
  const res = await paidFetch(seller, decoded.accepts[0]);
  await assertRejection(res, /insufficient_funds: payer holds 0\.001 SXT/);
});

test('reason: a settle failure never reaches the handler', async () => {
  // Serving the resource on a failed settlement is giving the product away.
  const facilitator = await startFacilitator();
  let handlerRuns = 0;
  const seller = await startSeller({
    paywall: { facilitator: facilitator.url },
    declare: (app, pay) => {
      app.get('/v1/fx', pay('/v1/fx', { price: '0.02' }), (_req, res) => {
        handlerRuns += 1;
        res.json({ ok: true });
      });
    },
  });
  const { decoded } = await challenge(seller);

  facilitator.behaviour.settle = () => ({
    status: 200,
    json: { success: false, errorReason: 'transaction expired before submission' },
  });
  const res = await paidFetch(seller, decoded.accepts[0]);
  await assertRejection(res, /expired/);
  assert.equal(handlerRuns, 0, 'the handler must not run when settlement failed');
});

/* ══════════════════════════════════════════════════════════════════════════
   Settlement — the paid path
   ══════════════════════════════════════════════════════════════════════════ */

test('settlement: a verified payment reaches the handler with a decodable PAYMENT-RESPONSE', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, decoded.accepts[0]);
  assert.equal(res.status, 200);

  const receipt = decodePaymentResponseHeader(res.headers.get('payment-response'));
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, TX);
  assert.equal(receipt.payer, PAYER);
  // The v1 spelling carries the same bytes so older clients still see a receipt.
  assert.equal(res.headers.get('x-payment-response'), res.headers.get('payment-response'));

  const body = await res.json();
  assert.equal(body.stellarsight.transaction, TX);
  assert.equal(body.stellarsight.payer, PAYER);
  assert.equal(body.stellarsight.route.path, '/v1/fx');
  assert.equal(body.stellarsight.requirements.amount, '200000');
  assert.equal(body.x402.transaction, TX, 'req.x402 stays compatible with the reference seller');
});

test('settlement: the v1 X-PAYMENT request spelling is still accepted', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, decoded.accepts[0], { header: 'X-PAYMENT' });
  assert.equal(res.status, 200);
  assert.equal(facilitator.calls.settle.length, 1);
});

test('settlement: a rejection names the header the client actually used', async () => {
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const v2 = await paidFetch(seller, { ...decoded.accepts[0], amount: '1' });
  await assertRejection(v2, /PAYMENT-SIGNATURE/);

  const v1 = await paidFetch(seller, { ...decoded.accepts[0], amount: '1' }, { header: 'X-PAYMENT' });
  await assertRejection(v1, /X-PAYMENT/);
});

test('settlement: EXTENSION-RESPONSES from the facilitator is forwarded to the client', async () => {
  // [CONTRACT.md: EXTENSION-RESPONSES = base64(JSON) of { bazaar: { status, rejectedReason? } }]
  // This is how the buyer learns whether the bazaar accepted the catalog echo. Dropping it
  // silently loses the only feedback channel the discovery extension has.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });
  const { decoded } = await challenge(seller);

  const extension = Buffer.from(JSON.stringify({ bazaar: { status: 'success' } })).toString('base64');
  facilitator.behaviour.settle = () => ({ ...okSettle(), headers: { 'EXTENSION-RESPONSES': extension } });

  const res = await paidFetch(seller, decoded.accepts[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('extension-responses'), extension);
  assert.equal((await res.json()).stellarsight.extensionResponses, extension);
});

test('settlement: onSettled is called once, and a throwing callback never voids a settled payment', async () => {
  const facilitator = await startFacilitator();
  const seen = [];
  const seller = await startSeller({
    paywall: {
      facilitator: facilitator.url,
      onSettled: (stellarsight) => {
        seen.push(stellarsight.transaction);
        throw new Error('bookkeeping exploded');
      },
    },
  });
  const { decoded } = await challenge(seller);

  const res = await paidFetch(seller, decoded.accepts[0]);
  assert.equal(res.status, 200, 'the chain already moved the money; a logging bug cannot undo that');
  assert.deepEqual(seen, [TX]);
});

/* ══════════════════════════════════════════════════════════════════════════
   Announcement — discoverable before the first payment
   ══════════════════════════════════════════════════════════════════════════ */

test('announce: routes are published to the bazaar with no payment having ever settled', async () => {
  const index = await startIndex();
  const pay = makePaywall({ index: index.url });
  pay('/v1/fx/:pair', {
    price: '0.02',
    serviceName: 'acme-fx',
    description: 'USD/BRL exchange rate with bid, ask and mid price.',
    tags: ['fx', 'forex'],
    output: { example: { mid: 5.435 } },
  });

  const result = await pay.announce();
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.announced, [`${BASE_URL}/v1/fx/:pair`]);

  assert.equal(index.records.length, 1);
  const record = index.records[0];
  assert.equal(record.id, `${BASE_URL}/v1/fx/:pair`);
  assert.equal(record.resource.url, `${BASE_URL}/v1/fx/:pair`);
  assert.equal(record.resource.serviceName, 'acme-fx');
  assert.equal(record.type, 'http');
  assert.equal(record.network, NETWORK);
  assert.equal(record.scheme, 'exact');
  assert.equal(record.payTo, PAY_TO);
  assert.equal(record.asset, ASSET);
  assert.equal(record.maxAmountRequired, '200000');
  assert.equal(record.input.type, 'http');
  assert.equal(record.input.method, 'GET');
  assert.equal(record.output.type, 'json');
  assert.equal(record.routeTemplate, '/v1/fx/:pair');
  assert.deepEqual(record.extensions, ['bazaar']);
  // The index merges settlements with Math.max, so re-announcing 0 can never erase
  // observed payment history.
  assert.equal(record.settlements, 0);
});

test('announce: declaring a route arms a boot announcement and a repeat, without any manual call', async () => {
  // The index is in-memory and empties whenever it restarts, so a one-shot announcement
  // is not enough: a seller that booted first would silently vanish from the catalog.
  // The timers are unref()d, so this must also not be why the test process hangs.
  const index = await startIndex();
  const pay = makePaywall({ index: index.url, announce: true, announceDelayMs: 10, announceIntervalMs: 60 });
  pay('/v1/fx', { price: '0.02', serviceName: 'acme-fx' });

  await waitFor(() => index.records.length >= 1, 'the boot announcement to arrive');
  await waitFor(() => index.records.length >= 3, 'the periodic re-announcement to repeat');
  assert.ok(index.records.every((r) => r.id === `${BASE_URL}/v1/fx`));

  pay.stop();
  const settled = index.records.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(index.records.length, settled, 'pay.stop() must silence the announcer');
});

test('announce: a route declared without a path learns it from the router, not from the client', async () => {
  // `pay({ price })` with no path still has to work — but the path it learns must come
  // from the host app's own router (`req.route.path`), never from anything the caller
  // sent, or a request is enough to choose what URL gets published to the catalog.
  const index = await startIndex();
  const seller = await startSeller({
    paywall: { index: index.url },
    declare: (app, pay) => {
      app.get('/v1/learned/:id', pay({ price: '0.01' }), (_req, res) => res.json({ ok: true }));
    },
  });

  assert.deepEqual((await seller.pay.announce()).announced, [], 'nothing to announce before the first request');

  const { decoded } = await challenge(seller, '/v1/learned/abc?x=../../etc/passwd');
  assert.equal(decoded.resource.url, `${BASE_URL}/v1/learned/:id`);
  assert.equal(decoded.extensions.bazaar.routeTemplate, undefined, 'a learned path is not promoted to a template');

  assert.deepEqual((await seller.pay.announce()).announced, [`${BASE_URL}/v1/learned/:id`]);
  assert.equal(index.records[0].resource.url, `${BASE_URL}/v1/learned/:id`);
});

test('announce: with no baseUrl nothing is published, and the skip says why', async () => {
  // The only origin available at request time is the client-controlled Host header.
  // Announcing that would let any caller list these routes under a URL they own.
  const index = await startIndex();
  const pay = makePaywall({ index: index.url, baseUrl: undefined });
  pay('/v1/fx', { price: '0.02' });

  const result = await pay.announce();
  assert.deepEqual(result.announced, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /baseUrl/);
  assert.match(result.skipped[0].reason, /Host header/);
  assert.equal(index.records.length, 0);
});

test('announce: an index that rejects an announcement reports a reason instead of throwing', async () => {
  const { url } = await startStub((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, dropped: [], reason: 'resource.url is not absolute' }));
  });
  const pay = makePaywall({ index: url });
  pay('/v1/fx', { price: '0.02' });

  const result = await pay.announce();
  assert.deepEqual(result.announced, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /resource\.url is not absolute/);
});

test('announce: a route with no declared path is skipped with an actionable reason', async () => {
  const index = await startIndex();
  const pay = makePaywall({ index: index.url });
  pay({ price: '0.02' }); // no path — cannot be announced until a request reveals it

  const result = await pay.announce();
  assert.deepEqual(result.announced, []);
  assert.match(result.skipped[0].reason, /path/);
  assert.match(result.skipped[0].reason, /pay\(/);
});

/* ══════════════════════════════════════════════════════════════════════════
   The seller's own catalogue
   ══════════════════════════════════════════════════════════════════════════ */

test('catalogue: /.well-known/x402 describes every priced route with a payable offer', async () => {
  const seller = await startSeller();
  const res = await fetch(`${seller.url}/.well-known/x402`);
  const body = await res.json();

  assert.equal(body.x402Version, 2);
  assert.equal(body.resources.length, 1);
  const entry = body.resources[0];
  assert.equal(entry.resource.url, `${BASE_URL}/v1/fx`);
  assert.doesNotThrow(() => PaymentRequirementsSchema.parse(entry.accepts[0]));
  assert.ok(entry.extensions.bazaar.info);
});

test('catalogue: pay.routes() reports the compiled price of every route', async () => {
  const pay = makePaywall();
  pay('/v1/fx', { price: '0.02', serviceName: 'acme-fx', tags: ['fx'] });
  pay('/v1/ocr', { method: 'POST', amount: '500000' });

  assert.deepEqual(
    pay.routes().map((r) => [r.method, r.path, r.price, r.amount]),
    [
      ['GET', '/v1/fx', '0.02', '200000'],
      ['POST', '/v1/ocr', '0.05', '500000'],
    ],
  );
  assert.equal(pay.routes()[0].payTo, PAY_TO);
  assert.equal(pay.routes()[0].network, NETWORK);
});

/* ══════════════════════════════════════════════════════════════════════════
   Declaration-time validation — fail while the developer is watching
   ══════════════════════════════════════════════════════════════════════════ */

test('declaration: a route without a price is refused at declaration time', async () => {
  const pay = makePaywall();
  assert.throws(() => pay('/v1/fx', {}), /price` is required/);
  assert.throws(() => pay('/v1/fx', { price: '0.01', amount: '100000' }), /not both/);
  assert.throws(() => pay('/v1/fx', { amount: '0.5' }), /atomic units/);
});

test('declaration: a price with more decimals than the asset is refused, not silently rounded', async () => {
  // Rounding here would charge a price the developer never wrote down.
  const pay = makePaywall();
  assert.throws(() => pay('/v1/fx', { price: '0.00000001' }), /decimal places/);
  assert.throws(() => pay('/v1/fx', { price: 'free' }), /non-negative decimal/);
  // Trailing zeros beyond the precision are not a real loss of precision.
  assert.doesNotThrow(() => pay('/v1/fx', { price: '0.0200000000' }));
});

test('declaration: an unusable method, path or bodyType is refused at declaration time', async () => {
  const pay = makePaywall();
  assert.throws(() => pay({ price: '0.01', method: 'TRACE' }), /method/);
  assert.throws(() => pay('v1/fx', { price: '0.01' }), /must be the route path/);
  assert.throws(() => pay('/v1/fx', { price: '0.01', bodyType: 'json' }), /bodyType/);
  assert.throws(() => pay('/v1/fx', { price: '0.01', method: 'POST', bodyType: 'xml' }), /bodyType/);
});

test('config: missing facilitator, payTo or asset stops the process at construction', async () => {
  assert.throws(() => stellarsightPaywall(), /facilitator/);
  assert.throws(() => stellarsightPaywall({ payTo: PAY_TO, asset: ASSET }), /facilitator/);
  assert.throws(() => stellarsightPaywall({ facilitator: 'not-a-url', payTo: PAY_TO, asset: ASSET }), /absolute URL/);
  assert.throws(() => stellarsightPaywall({ facilitator: 'ftp://x.example', payTo: PAY_TO, asset: ASSET }), /http/);
  assert.throws(() => stellarsightPaywall({ facilitator: 'http://f.test', asset: ASSET }), /payTo/);
  assert.throws(() => stellarsightPaywall({ facilitator: 'http://f.test', payTo: PAY_TO }), /asset/);
  // Every message has to name the missing option AND say what belongs there.
  try {
    stellarsightPaywall({ facilitator: 'http://f.test', payTo: PAY_TO });
  } catch (e) {
    assert.match(e.message, /ASSET_SAC|SEP-41|SAC/);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Units and CORS helpers
   ══════════════════════════════════════════════════════════════════════════ */

test('units: human prices convert to atomic units exactly', async () => {
  assert.equal(toAtomicUnits('0.02', 7), '200000');
  assert.equal(toAtomicUnits('0.07', 7), '700000'); // 0.07 * 1e7 is 700000.0000000001 in float
  assert.equal(toAtomicUnits('1', 7), '10000000');
  assert.equal(toAtomicUnits('1.5', 7), '15000000');
  assert.equal(toAtomicUnits('0.0000001', 7), '1');
  assert.equal(toAtomicUnits('0', 7), '0');
  assert.equal(toAtomicUnits('12.34', 2), '1234');
  assert.equal(toAtomicUnits(0.02, 7), '200000');
  assert.throws(() => toAtomicUnits('-1', 7), /non-negative/);
  assert.throws(() => toAtomicUnits('1,50', 7), /non-negative/);
});

test('cors: the exposed-header list covers every x402 header a browser agent must read', async () => {
  // Without exposedHeaders a browser client can see the 402 but not the challenge inside it.
  const options = x402CorsOptions();
  for (const header of ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE', 'EXTENSION-RESPONSES']) {
    assert.ok(options.exposedHeaders.includes(header), `missing ${header}`);
  }
  for (const header of ['payment-signature', 'x-payment']) {
    assert.ok(options.allowedHeaders.includes(header), `missing ${header}`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   The fail-safe
   ──────────────────────────────────────────────────────────────────────────
   An async Express middleware that rejects is NOT a 500 everywhere. On
   express 4 — a declared peer ("express": ">=4.18.0 <6") — the rejection is
   unhandled, and under Node's default --unhandled-rejections=throw it takes
   the seller's whole process down. The paying agent gets nothing: no status,
   no reason, no way to know whether it was charged.

   That is the one rejection path this package must not have, so the middleware
   is a synchronous shell around the async handler and every escape funnels
   back into a reasoned 402.
   ══════════════════════════════════════════════════════════════════════════ */

test('failsafe: an unexpected internal throw becomes a reasoned 402, not a crash or a stack trace', async () => {
  // A custom `fetch` is a documented, public option, so a buggy one is a real
  // shape of failure — not a contrived one.
  const exploding = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      String(url).endsWith('/verify')
        ? JSON.stringify({ isValid: true })
        : JSON.stringify({ success: true, transaction: TX, payer: PAYER }),
    get headers() {
      return {
        get() {
          throw new Error('instrumented fetch blew up reading a header');
        },
      };
    },
  });

  const seller = await startSeller({ paywall: { facilitator: 'http://127.0.0.1:9', fetch: exploding } });
  const res = await paidFetch(seller, null);

  const decoded = await assertRejection(res, /could not be completed/);
  assert.match(decoded.error, /instrumented fetch blew up reading a header/);
  // The agent must be told the resource was not served, and warned before re-paying.
  assert.match(decoded.error, /resource was not served/i);
  assert.match(decoded.error, /before paying again/i);
});

test('failsafe: a 402 born from a failure after settlement carries no receipt headers', async () => {
  // Staging PAYMENT-RESPONSE and then failing must not leave a receipt on a 402:
  // that would tell the client it was served something it was not.
  const exploding = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      String(url).endsWith('/verify')
        ? JSON.stringify({ isValid: true })
        : JSON.stringify({ success: true, transaction: TX, payer: PAYER }),
    get headers() {
      return {
        get() {
          throw new Error('boom after settle');
        },
      };
    },
  });

  const seller = await startSeller({ paywall: { facilitator: 'http://127.0.0.1:9', fetch: exploding } });
  const res = await paidFetch(seller, null);

  assert.equal(res.status, 402);
  for (const header of ['payment-response', 'x-payment-response', 'extension-responses']) {
    assert.equal(res.headers.get(header), null, `a 402 must not carry ${header}`);
  }
});

test('failsafe: the handler never runs when the paywall fails unexpectedly', async () => {
  let served = 0;
  const exploding = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      String(url).endsWith('/verify')
        ? JSON.stringify({ isValid: true })
        : JSON.stringify({ success: true, transaction: TX, payer: PAYER }),
    get headers() {
      return {
        get() {
          throw new Error('boom');
        },
      };
    },
  });

  const seller = await startSeller({
    paywall: { facilitator: 'http://127.0.0.1:9', fetch: exploding },
    declare: (app, pay) => {
      app.get('/v1/fx', pay('/v1/fx', { price: '0.02' }), (_req, res) => {
        served += 1;
        res.json({ ok: true });
      });
    },
  });

  const res = await paidFetch(seller, null);
  assert.equal(res.status, 402);
  assert.equal(served, 0, 'a paywall failure must never fall through to the paid handler');
});

test('failsafe: a synchronous throw inside the paywall is caught too', async () => {
  // `learnPath` reads req.route/req.originalUrl before any await; a request object
  // that misbehaves there must not escape either.
  const seller = await startSeller({
    declare: (app, pay) => {
      const mw = pay({ price: '0.02' }); // no declared path -> learnPath runs
      app.get('/v1/fx', (req, res, next) => {
        Object.defineProperty(req, 'originalUrl', {
          get() {
            throw new Error('hostile request object');
          },
        });
        Object.defineProperty(req, 'route', { get() { return undefined; } });
        return mw(req, res, next);
      });
    },
  });

  const res = await fetch(`${seller.url}/v1/fx`);
  await assertRejection(res, /hostile request object/);
});

/* ══════════════════════════════════════════════════════════════════════════
   Trust, continued — shapes the mismatch check deliberately does not inspect
   ══════════════════════════════════════════════════════════════════════════ */

test('trust: an `accepted` sent as an ARRAY skips the echo check but never changes the price', async () => {
  // `accepted` is a single PaymentRequirements object in x402 v2. An array is not a
  // shape this package compares field by field — so the guarantee has to come from
  // somewhere else: the facilitator is still asked about OUR requirements.
  const facilitator = await startFacilitator();
  const seller = await startSeller({ paywall: { facilitator: facilitator.url } });

  const res = await paidFetch(seller, [
    { scheme: 'exact', network: NETWORK, asset: OTHER_ASSET, amount: '1', payTo: OTHER_PAY_TO },
  ]);

  assert.equal(res.status, 200, 'the stub facilitator accepts, so the request is served');
  assert.equal(facilitator.calls.verify.length, 1);
  const sent = facilitator.calls.verify[0].paymentRequirements;
  assert.equal(sent.amount, '200000', 'the facilitator was asked about the real price');
  assert.equal(sent.asset, ASSET, 'the facilitator was asked about the real asset');
  assert.equal(sent.payTo, PAY_TO, 'the facilitator was asked about the real payee');
  assert.equal(facilitator.calls.settle[0].paymentRequirements.amount, '200000');
});

test('discovery: a path parameter documented only as `input` is called out at declaration time', async () => {
  // `input` is published as queryParams. A route declared `/v1/weather/:city` with
  // `input: { city }` and no pathParams is listed in the bazaar as
  // `/v1/weather/:city?city=…` — discoverable and uncallable.
  const warnings = [];
  const pay = makePaywall({ logger: { warn: (m) => warnings.push(m), log() {}, error() {} } });

  pay('/v1/weather/:city', { price: '0.02', input: { city: 'sao-paulo' } });
  assert.equal(warnings.length, 1, 'the developer must be told');
  assert.match(warnings[0], /:city/);
  assert.match(warnings[0], /queryParams/);
  assert.match(warnings[0], /pathParams: \{ city: '…' \}/);

  // Declared properly: silent.
  warnings.length = 0;
  pay('/v1/weather/:city', { price: '0.02', pathParams: { city: 'sao-paulo' } });
  pay('/v1/fx', { price: '0.02', input: { pair: 'USD/BRL' } });
  assert.deepEqual(warnings, []);
});
