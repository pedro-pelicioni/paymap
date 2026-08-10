/**
 * packages/index/src/seed.mjs — STELLARSIGHT demo catalog.
 *
 * A realistic slice of x402-enabled services on Stellar. Two properties are deliberate:
 *
 *   1. METADATA COMPLETENESS IS VARIED ON PURPOSE. Some entries carry a description, a
 *      documented parameter schema, an output format, tags and an icon; others carry
 *      almost nothing. That spread is what makes the completeness signal in rank.mjs
 *      visible instead of constant — a well-documented service should out-rank a bare
 *      one at comparable relevance, and you can see exactly that in `_explain`.
 *
 *   2. MCP TOOLS SHARE A URL. Three entries below are served by the same MCP endpoint
 *      and differ only in `input.toolName`.
 *      [spec: "For MCP tools, the unique resource identifier is the tuple
 *       (resource.url, input.toolName). Since MCP multiplexes multiple tools over a
 *       single server endpoint, resource.url alone may not be unique."]
 *      If the index keyed on `resource.url` alone, two of the three would vanish.
 *
 * No side effects on import: seeding and fixture writing are explicit calls.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog } from './index.mjs';

const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (n) => now - n * DAY;

// Distinct payee accounts so the `payTo` filter is actually exercised.
const PAY_A = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PAY_B = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const PAY_C = 'GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3';
const PAY_D = 'GCFXHS4GXL6BVUCXBWXGTITROWLVYXQKQLF4YH5O5JT3YZXCYPAFBJZB';
const ASSET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const ICON = (name) => `https://cdn.stellarsight.build/icons/${name}.svg`;

/** Draft 2020-12 schema helper. Descriptions here feed the ranker's `params` field. */
const schema = (properties, required = []) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
});

const base = {
  network: 'stellar:testnet',
  scheme: 'exact',
  asset: ASSET,
  extensions: ['bazaar'],
};

/**
 * The demo catalog. Completeness tiers are annotated so the spread is auditable:
 *   [FULL]    description + documented params + output format/example + tags + icon
 *   [PARTIAL] some of the above missing
 *   [BARE]    little more than a URL and a method — the cold-start worst case
 */
export const SEED_RECORDS = [
  /* ── FX and market data ───────────────────────────────────────────────── */
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.fxrates.example/v1/fx/usd-brl',
      serviceName: 'USD/BRL FX Rate',
      description:
        'Real-time USD to BRL exchange rate with mid, bid and ask prices, sourced from an aggregate of Brazilian interbank venues and refreshed every 5 seconds.',
      tags: ['fx', 'forex', 'brl', 'rates', 'market-data'],
      iconUrl: ICON('fx'),
    },
    type: 'http',
    payTo: PAY_A,
    maxAmountRequired: '2500',
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { amount: '100', side: 'mid' },
      schema: schema({
        amount: { type: 'string', description: 'Notional amount in USD to convert, decimal string.' },
        side: { type: 'string', description: 'Which side of the book to quote: mid, bid or ask.' },
      }),
    },
    output: { type: 'json', format: 'quote', example: { pair: 'USDBRL', mid: '5.4312', asOf: '2026-08-06T12:00:00Z' } },
    lastSeenAt: daysAgo(0.1),
    settlements: 4820,
  },
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.fxrates.example/v1/fx/usdc-brl',
      serviceName: 'USDC/BRL Stablecoin Rate',
      description:
        'USDC to BRL conversion rate for on-chain settlement, cross-checked against a Reflector oracle feed and the offshore USD/BRL curve.',
      tags: ['fx', 'stablecoin', 'usdc', 'brl', 'oracle'],
      iconUrl: ICON('usdc'),
    },
    type: 'http',
    payTo: PAY_A,
    maxAmountRequired: '2500',
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { amount: '1000' },
      schema: schema({
        amount: { type: 'string', description: 'Notional amount in USDC to convert.' },
      }),
    },
    output: { type: 'json', format: 'quote', example: { pair: 'USDCBRL', mid: '5.4410' } },
    lastSeenAt: daysAgo(0.3),
    settlements: 2140,
  },
  {
    // [PARTIAL] documented params and output, but no icon
    ...base,
    resource: {
      url: 'https://api.fxrates.example/v1/fx/history',
      serviceName: 'FX Historical Time Series',
      description: 'Daily closing exchange rates for major pairs going back to 2015, returned as a compact time series.',
      tags: ['fx', 'timeseries', 'history'],
    },
    type: 'http',
    payTo: PAY_A,
    maxAmountRequired: '6000',
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { pair: 'USDBRL', from: '2026-01-01', to: '2026-08-01' },
      schema: schema({
        pair: { type: 'string', description: 'Currency pair in ISO 4217 concatenated form, e.g. USDBRL.' },
        from: { type: 'string', description: 'Inclusive start date, ISO 8601.' },
        to: { type: 'string', description: 'Inclusive end date, ISO 8601.' },
      }),
    },
    output: { type: 'json', format: 'timeseries' },
    lastSeenAt: daysAgo(3),
    settlements: 610,
  },

  /* ── Oracles ──────────────────────────────────────────────────────────── */
  {
    // [PARTIAL] no icon, params undocumented
    ...base,
    resource: {
      url: 'https://oracle.reflector.example/v1/price/xlm',
      serviceName: 'Reflector XLM Price Feed',
      description: 'Signed XLM spot price from the Reflector oracle network, suitable for on-chain consumption by Soroban contracts.',
      tags: ['oracle', 'price-feed', 'stellar', 'xlm'],
    },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '1200',
    input: { type: 'http', method: 'GET', queryParams: { quote: 'USD' } },
    output: { type: 'json', format: 'signed-price' },
    lastSeenAt: daysAgo(0.5),
    settlements: 3310,
  },
  {
    // [PARTIAL]
    ...base,
    resource: {
      url: 'https://oracle.reflector.example/v1/price/multi',
      serviceName: 'Reflector Multi-Asset Oracle',
      description: 'Batch price lookup across every asset tracked by the Reflector oracle, with per-asset staleness metadata.',
      tags: ['oracle', 'price-feed', 'stellar'],
      iconUrl: ICON('oracle'),
    },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '4000',
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: { assets: ['XLM', 'USDC', 'BTC'] },
    },
    output: { type: 'json' },
    lastSeenAt: daysAgo(1.2),
    settlements: 890,
  },

  /* ── Brazilian data services ──────────────────────────────────────────── */
  {
    // [FULL] dynamic route -> routeTemplate + pathParams
    ...base,
    resource: {
      url: 'https://api.addresses.example/v1/postal-code/01310930',
      serviceName: 'Brazilian Postal Code Lookup',
      description:
        'Resolve a Brazilian postal code (CEP) to a full street address including street, neighbourhood, city, state and IBGE municipality code.',
      tags: ['postal-code', 'address', 'lookup', 'brazil', 'geo'],
      iconUrl: ICON('address'),
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '800',
    routeTemplate: '/v1/postal-code/:cep',
    input: {
      type: 'http',
      method: 'GET',
      pathParams: { cep: '01310930' },
      schema: schema({
        cep: { type: 'string', description: 'Eight-digit Brazilian postal code, digits only, no hyphen.' },
      }, ['cep']),
    },
    output: {
      type: 'json',
      format: 'address',
      example: { street: 'Avenida Paulista', city: 'Sao Paulo', state: 'SP', ibge: '3550308' },
    },
    lastSeenAt: daysAgo(0.2),
    settlements: 7450,
  },
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.documents.example/v1/invoice-ocr',
      serviceName: 'Invoice OCR',
      description:
        'Optical character recognition tuned for the Brazilian nota fiscal layout. Extracts issuer, recipient, line items, tax breakdown and the 44-digit access key from a scanned invoice.',
      tags: ['ocr', 'invoice', 'documents', 'tax', 'extraction'],
      iconUrl: ICON('ocr'),
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '15000',
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: { imageUrl: 'https://files.example/invoice.pdf', language: 'pt' },
      schema: schema({
        imageUrl: { type: 'string', description: 'Publicly reachable URL of the invoice image or PDF to process.' },
        language: { type: 'string', description: 'Document language hint used to select the OCR model.' },
      }, ['imageUrl']),
    },
    output: {
      type: 'json',
      format: 'invoice',
      example: { accessKey: '35260812345678000190550010000000011000000017', total: '1284.90' },
    },
    lastSeenAt: daysAgo(0.8),
    settlements: 1980,
  },
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.payments.example/v1/pix/validate',
      serviceName: 'PIX Identifier Validation',
      description:
        'Validate a PIX key and resolve it to the masked account holder name and institution, so an agent can confirm a payee before initiating a transfer.',
      tags: ['pix', 'payments', 'validation', 'identity', 'brazil'],
      iconUrl: ICON('pix'),
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '1500',
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: { key: 'agent@example.com', keyType: 'email' },
      schema: schema({
        key: { type: 'string', description: 'The PIX key to validate: email, phone, tax id or random key.' },
        keyType: { type: 'string', description: 'Declared key type, used to pick the validation rules.' },
      }, ['key']),
    },
    output: { type: 'json', format: 'payee', example: { holder: 'M**** S****', bank: 'Banco Example' } },
    lastSeenAt: daysAgo(0.4),
    settlements: 5230,
  },
  {
    // [PARTIAL] no per-param descriptions
    ...base,
    resource: {
      url: 'https://api.payments.example/v1/pix/qrcode',
      serviceName: 'PIX QR Code Generator',
      description: 'Generate a static or dynamic PIX payment QR code payload conforming to the BR Code standard.',
      tags: ['pix', 'payments', 'qrcode'],
      iconUrl: ICON('qrcode'),
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '900',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { key: 'agent@example.com', amount: '49.90' } },
    output: { type: 'json', format: 'brcode' },
    lastSeenAt: daysAgo(2.5),
    settlements: 1120,
  },
  {
    // [FULL] dynamic route
    ...base,
    resource: {
      url: 'https://api.registry.example/v1/company/12345678000190',
      serviceName: 'Company Registry Lookup',
      description:
        'Look up a Brazilian company by its CNPJ tax identifier and return the registered name, trade name, address, activity codes and registration status.',
      tags: ['registry', 'company', 'lookup', 'brazil', 'compliance'],
      iconUrl: ICON('company'),
    },
    type: 'http',
    payTo: PAY_D,
    maxAmountRequired: '3000',
    routeTemplate: '/v1/company/:taxId',
    input: {
      type: 'http',
      method: 'GET',
      pathParams: { taxId: '12345678000190' },
      schema: schema({
        taxId: { type: 'string', description: 'Fourteen-digit CNPJ company tax identifier, digits only.' },
      }, ['taxId']),
    },
    output: { type: 'json', format: 'company', example: { name: 'Example Trading Ltd', status: 'ACTIVE' } },
    lastSeenAt: daysAgo(1.5),
    settlements: 2670,
  },
  {
    // [BARE] cold-start worst case: no description, no tags, no icon, undocumented params
    ...base,
    resource: { url: 'https://api.registry.example/v1/taxid/check' },
    type: 'http',
    payTo: PAY_D,
    maxAmountRequired: '200',
    input: { type: 'http', method: 'GET', queryParams: { value: '12345678909' } },
    output: { type: 'json' },
    lastSeenAt: daysAgo(21),
    settlements: 14,
  },
  {
    // [PARTIAL]
    ...base,
    resource: {
      url: 'https://api.centralbank.example/v1/indicators',
      serviceName: 'Central Bank Indicators',
      description: 'Official Brazilian macroeconomic series: the SELIC policy rate, the IPCA inflation index and the CDI overnight rate.',
      tags: ['macro', 'economics', 'rates', 'brazil'],
    },
    type: 'http',
    payTo: PAY_D,
    maxAmountRequired: '1000',
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { series: 'selic', window: '90d' },
      schema: schema({
        series: { type: 'string', description: 'Which indicator series to return: selic, ipca or cdi.' },
        window: { type: 'string', description: 'Lookback window expressed in days.' },
      }),
    },
    output: { type: 'json', format: 'timeseries' },
    lastSeenAt: daysAgo(4),
    settlements: 430,
  },
  {
    // [PARTIAL] no icon, no output format
    ...base,
    resource: {
      url: 'https://api.payments.example/v1/boleto/parse',
      serviceName: 'Boleto Barcode Parser',
      description: 'Decode a Brazilian boleto barcode or typeable line into issuer, due date, amount and validation digits.',
      tags: ['payments', 'barcode', 'parsing'],
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '600',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { line: '34191790010104351004791020150008291070026000' } },
    output: { type: 'json' },
    lastSeenAt: daysAgo(9),
    settlements: 205,
  },
  {
    // [BARE]
    ...base,
    resource: { url: 'https://api.logistics.example/v1/freight/quote' },
    type: 'http',
    payTo: PAY_D,
    maxAmountRequired: '1800',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { origin: '01310930', destination: '20040020', weightKg: '2.5' } },
    output: { type: 'json' },
    lastSeenAt: daysAgo(35),
    settlements: 3,
  },
  {
    // [PARTIAL]
    ...base,
    resource: {
      url: 'https://api.addresses.example/v1/geocode',
      serviceName: 'Address Geocoding',
      description: 'Convert a free-form Brazilian street address into latitude and longitude with a confidence score.',
      tags: ['geo', 'geocoding', 'address', 'lookup'],
      iconUrl: ICON('geo'),
    },
    type: 'http',
    payTo: PAY_C,
    maxAmountRequired: '1100',
    input: { type: 'http', method: 'GET', queryParams: { q: 'Avenida Paulista 1578, Sao Paulo' } },
    output: { type: 'json', format: 'geopoint' },
    lastSeenAt: daysAgo(6),
    settlements: 760,
  },

  /* ── General-purpose AI and utility services ──────────────────────────── */
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.weather.example/v1/forecast',
      serviceName: 'Weather Forecast',
      description:
        'Seven-day weather forecast for any Brazilian municipality, including temperature range, precipitation probability and a severe-weather alert flag.',
      tags: ['weather', 'forecast', 'climate', 'brazil'],
      iconUrl: ICON('weather'),
    },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '700',
    input: {
      type: 'http',
      method: 'GET',
      queryParams: { city: 'Sao Paulo', days: '7' },
      schema: schema({
        city: { type: 'string', description: 'Municipality name or IBGE code to forecast for.' },
        days: { type: 'string', description: 'Number of forecast days to return, 1 to 7.' },
      }, ['city']),
    },
    output: { type: 'json', format: 'forecast', example: { day: '2026-08-07', tempMinC: 14, tempMaxC: 23 } },
    lastSeenAt: daysAgo(0.6),
    settlements: 3890,
  },
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://api.translate.example/v1/translate',
      serviceName: 'Neural Translation',
      description:
        'Neural machine translation across major languages, tuned for financial and legal register with terminology consistency across a document.',
      tags: ['translation', 'nlp', 'language', 'ai'],
      iconUrl: ICON('translate'),
    },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '5000',
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: { text: 'A liquidation was confirmed.', source: 'auto', target: 'en' },
      schema: schema({
        text: { type: 'string', description: 'The source text to translate, up to 8000 characters.' },
        source: { type: 'string', description: 'Source language code; omit to auto-detect.' },
        target: { type: 'string', description: 'Target language code to translate into.' },
      }, ['text', 'target']),
    },
    output: { type: 'json', format: 'translation', example: { text: 'The settlement was confirmed.' } },
    lastSeenAt: daysAgo(0.9),
    settlements: 2450,
  },
  {
    // [BARE]
    ...base,
    resource: { url: 'https://api.nlp.example/v1/sentiment' },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '400',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { text: 'sample' } },
    output: { type: 'json' },
    lastSeenAt: daysAgo(48),
    settlements: 7,
  },
  {
    // [PARTIAL]
    ...base,
    resource: {
      url: 'https://api.nlp.example/v1/speech-to-text',
      serviceName: 'Speech To Text',
      description: 'Transcribe audio to text with word-level timestamps and speaker diarization.',
      tags: ['speech', 'audio', 'transcription', 'ai'],
    },
    type: 'http',
    payTo: PAY_B,
    maxAmountRequired: '9000',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { audioUrl: 'https://files.example/call.wav' } },
    output: { type: 'json', format: 'transcript' },
    lastSeenAt: daysAgo(7),
    settlements: 540,
  },
  {
    // [PARTIAL]
    ...base,
    resource: {
      url: 'https://api.antifraud.example/v1/risk-score',
      serviceName: 'Device Risk Score',
      description: 'Return a 0-100 fraud risk score for a device fingerprint and transaction context, with the top contributing risk factors.',
      tags: ['fraud', 'risk', 'security', 'payments'],
      iconUrl: ICON('risk'),
    },
    type: 'http',
    payTo: PAY_D,
    maxAmountRequired: '2200',
    input: { type: 'http', method: 'POST', bodyType: 'json', body: { fingerprint: 'a1b2c3', amount: '250.00' } },
    output: { type: 'json', format: 'risk' },
    lastSeenAt: daysAgo(2),
    settlements: 1340,
  },

  /* ── Stellar chain data ───────────────────────────────────────────────── */
  {
    // [PARTIAL] dynamic route
    ...base,
    resource: {
      url: 'https://api.chaindata.example/v1/account/GABC/balances',
      serviceName: 'Stellar Account Balances',
      description: 'Current balances for a Stellar account across every trustline, with SAC contract identifiers resolved.',
      tags: ['stellar', 'account', 'balance', 'blockchain'],
    },
    type: 'http',
    payTo: PAY_A,
    maxAmountRequired: '500',
    routeTemplate: '/v1/account/:accountId/balances',
    input: {
      type: 'http',
      method: 'GET',
      pathParams: { accountId: 'GABC' },
      schema: schema({
        accountId: { type: 'string', description: 'Stellar public key of the account to inspect.' },
      }, ['accountId']),
    },
    output: { type: 'json', format: 'balances' },
    lastSeenAt: daysAgo(0.7),
    settlements: 3120,
  },
  {
    // [BARE]
    ...base,
    resource: { url: 'https://api.chaindata.example/v1/contract/events' },
    type: 'http',
    payTo: PAY_A,
    maxAmountRequired: '2000',
    input: { type: 'http', method: 'GET', queryParams: { contractId: 'CABC', topic: 'transfer' } },
    output: { type: 'json' },
    lastSeenAt: daysAgo(15),
    settlements: 61,
  },

  /* ── MCP tools ────────────────────────────────────────────────────────── */
  /* The next THREE entries share one `resource.url`. They are distinct catalog
     records only because identity is the (resource.url, input.toolName) tuple. */
  {
    // [FULL]
    ...base,
    resource: {
      url: 'https://mcp.stellartools.example/mcp',
      serviceName: 'Stellar Tools MCP',
      description:
        'Submit a signed Stellar transaction envelope to the network and wait for its inclusion result. Exposed as an MCP tool for autonomous agents.',
      tags: ['mcp', 'stellar', 'transactions', 'tools'],
      iconUrl: ICON('mcp'),
    },
    type: 'mcp',
    payTo: PAY_A,
    maxAmountRequired: '3500',
    input: {
      type: 'mcp',
      toolName: 'submit_transaction',
      transport: 'streamable-http',
      description: 'Submit a signed transaction envelope to the Stellar network.',
      inputSchema: schema({
        envelopeXdr: { type: 'string', description: 'Base64-encoded signed transaction envelope XDR.' },
        waitForResult: { type: 'boolean', description: 'Block until the transaction is included in a ledger.' },
      }, ['envelopeXdr']),
      example: { envelopeXdr: 'AAAAAgAAAA...', waitForResult: true },
    },
    output: { type: 'json', format: 'transaction-result', example: { hash: 'abc123', successful: true } },
    lastSeenAt: daysAgo(0.15),
    settlements: 4410,
  },
  {
    // [FULL] same URL, different tool
    ...base,
    resource: {
      url: 'https://mcp.stellartools.example/mcp',
      serviceName: 'Stellar Tools MCP',
      description:
        'Simulate a Soroban contract invocation without submitting it, returning the predicted return value, footprint and resource fee.',
      tags: ['mcp', 'stellar', 'soroban', 'simulation', 'tools'],
      iconUrl: ICON('mcp'),
    },
    type: 'mcp',
    payTo: PAY_A,
    maxAmountRequired: '1800',
    input: {
      type: 'mcp',
      toolName: 'simulate_contract',
      transport: 'streamable-http',
      description: 'Simulate a Soroban contract call and return the predicted result.',
      inputSchema: schema({
        contractId: { type: 'string', description: 'Contract identifier starting with C.' },
        method: { type: 'string', description: 'Contract method name to invoke.' },
        args: { type: 'array', description: 'Positional arguments passed to the contract method.' },
      }, ['contractId', 'method']),
    },
    output: { type: 'json', format: 'simulation', example: { cost: { cpuInsns: '918273' } } },
    lastSeenAt: daysAgo(0.25),
    settlements: 2890,
  },
  {
    // [PARTIAL] same URL again, third tool, thinner metadata
    ...base,
    resource: {
      url: 'https://mcp.stellartools.example/mcp',
      serviceName: 'Stellar Tools MCP',
      description: 'Read a raw ledger entry by its key.',
      tags: ['mcp', 'stellar', 'ledger'],
    },
    type: 'mcp',
    payTo: PAY_A,
    maxAmountRequired: '400',
    input: {
      type: 'mcp',
      toolName: 'fetch_ledger_entry',
      transport: 'streamable-http',
      inputSchema: schema({ keyXdr: { type: 'string' } }, ['keyXdr']),
    },
    output: { type: 'json' },
    lastSeenAt: daysAgo(5),
    settlements: 320,
  },
  {
    // [FULL] a different MCP server
    ...base,
    resource: {
      url: 'https://mcp.stellarsight.example/mcp',
      serviceName: 'STELLARSIGHT Catalog MCP',
      description:
        'Search the STELLARSIGHT bazaar catalog for paid x402 resources on Stellar by natural-language description, returning ranked results with pricing.',
      tags: ['mcp', 'discovery', 'search', 'x402', 'tools'],
      iconUrl: ICON('stellarsight'),
    },
    type: 'mcp',
    payTo: PAY_B,
    maxAmountRequired: '100',
    input: {
      type: 'mcp',
      toolName: 'search_catalog',
      transport: 'streamable-http',
      description: 'Find paid APIs and MCP tools matching a natural-language need.',
      inputSchema: schema({
        query: { type: 'string', description: 'Natural-language description of the capability you need.' },
        maxPrice: { type: 'string', description: 'Optional ceiling on maxAmountRequired, in stroops.' },
      }, ['query']),
      example: { query: 'convert dollars to reais' },
    },
    output: { type: 'json', format: 'search-results', example: { items: [], total: 0 } },
    lastSeenAt: daysAgo(0.05),
    settlements: 980,
  },
  {
    // [BARE] MCP with almost no metadata — proves bare MCP tools still key correctly
    ...base,
    resource: { url: 'https://mcp.legacy.example/mcp' },
    type: 'mcp',
    payTo: PAY_D,
    maxAmountRequired: '750',
    input: { type: 'mcp', toolName: 'legacy_lookup', inputSchema: schema({ id: { type: 'string' } }) },
    output: { type: 'json' },
    lastSeenAt: daysAgo(63),
    settlements: 1,
  },
];

/**
 * Stamp the provenance of a demo record before it enters a live catalog.
 *
 * A seeded record is catalog BREADTH: it makes discovery and ranking demonstrable on a
 * cold index, but no payment was ever settled against it. Two adjustments keep that
 * honest next to the seller's real, payable resources:
 *
 *   - `seeded: true` — an explicit flag any consumer can label or filter on.
 *   - `settlements: 0` — the per-record counts above are illustrative, not observed.
 *     Left as authored they would inflate any "settlements observed" total that sums
 *     across the catalog into a number that never happened.
 *
 * `lastSeenAt` is kept exactly as authored: it is what gives the catalog its realistic
 * freshness spread (and drives the recency signal in rank.mjs), and unlike a settlement
 * count it is not a claim about money.
 */
export function asSeedRecord(rec) {
  return { ...rec, settlements: 0, seeded: true };
}

/**
 * seedCatalog(catalog) -> { inserted, rejected, dropped }
 * Every record goes through the same `upsert` validation path as live traffic.
 */
export function seedCatalog(catalog) {
  let inserted = 0;
  const rejected = [];
  const dropped = [];
  for (const rec of SEED_RECORDS) {
    const r = catalog.upsert(asSeedRecord(rec));
    if (r.ok) inserted++;
    else rejected.push({ url: rec?.resource?.url, reason: r.reason });
    if (r.dropped?.length) dropped.push({ url: rec?.resource?.url, dropped: r.dropped });
  }
  return { inserted, rejected, dropped, size: catalog.size() };
}

/** Build the canonical, post-validation record set (what the API would actually serve). */
export function buildSeededRecords() {
  const catalog = createCatalog();
  seedCatalog(catalog);
  return catalog.all();
}

/**
 * Write the web fallback fixture. CONTRACT.md requires apps/web to render fully from a
 * baked-in fixture when the index is unreachable, so the fixture must be the REAL
 * post-validation output of this catalog rather than a hand-maintained copy that drifts.
 *
 * MERGE, DO NOT CLOBBER. apps/web owns this file's envelope: besides `items` it carries
 * `integrity` (the rejection log the console renders), `asset`, `assetCode`,
 * `facilitator` and `network`. Blindly writing a bare array here would strip all of
 * that and break the fallback render. So we preserve every key the file already has,
 * union the records by `id` with the existing ones winning on conflict, and only then
 * write. On a fresh checkout with no fixture we emit the same envelope from scratch.
 */
export function writeFixture(outPath) {
  const target =
    outPath ?? fileURLToPath(new URL('../../../apps/web/src/data/fixture.json', import.meta.url));

  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    existing = Array.isArray(parsed) ? { items: parsed } : (parsed ?? {});
  } catch {
    existing = {};
  }

  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  const byId = new Map();
  for (const rec of buildSeededRecords()) byId.set(rec.id, rec);
  // Records already curated by apps/web win — this exporter adds breadth, it does not
  // overwrite another owner's content.
  for (const rec of existingItems) if (rec && rec.id) byId.set(rec.id, rec);
  const items = [...byId.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

  const payload = {
    ...existing,
    generatedAt: Date.now(),
    network: existing.network ?? 'stellar:testnet',
    items,
    total: items.length,
  };

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: target, count: items.length, added: items.length - existingItems.length };
}

// CLI: `node packages/index/src/seed.mjs` regenerates the fixture. Import is side-effect free.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const r = writeFixture();
  console.log(`[stellarsight] wrote ${r.count} records to ${r.path}`);
}

export default { SEED_RECORDS, asSeedRecord, seedCatalog, buildSeededRecords, writeFixture };
