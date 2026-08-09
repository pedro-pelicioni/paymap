# PAYMAP — agent surface

**Find what to pay for on Stellar.**

`apps/agent` is the agent-facing half of PAYMAP: an **MCP server** that drops the Stellar
Bazaar directly into an AI agent's runtime. The agent searches the bazaar in natural
language, reads a resource's exact call contract, and then *actually pays for it* — the full
`discover → 402 → sign → retry → settle` x402 loop happens inside a single tool call.

No API key. No vendor account. No human in the loop. Just a wallet.

This is RFP requirement **3.3**.

| File | What it is |
|---|---|
| `src/mcp-server.mjs` | MCP server over stdio (`@modelcontextprotocol/sdk` v1.30) exposing four tools |
| `src/pay.mjs` | Reusable x402 payment client — `payAndFetch(url, opts)` |
| `src/bazaar.mjs` | Fail-soft HTTP client for the discovery index (`/discovery/*`) |
| `src/cli.mjs` | Narrated terminal demo of the whole loop |
| `src/replay-guard.test.mjs` | `node:test` proof that replays and expired auth entries are refused with a reason |

Testnet only. No relayer, no third-party channel service — the payment is signed locally with
`@x402/stellar` and settled by the PAYMAP facilitator on `stellar:testnet`.

---

## Quick start

```bash
npm install
npm run setup                       # writes /.env with the funded testnet keys
npm run dev:all                     # facilitator :4021 · index :4022 · seller :4023

node apps/agent/src/cli.mjs "usd to brl exchange rate"
```

Everything here starts and degrades cleanly with the stack down. If the index or the seller is
not reachable you get a coded rejection with an explanation, never a stack trace.

---

## Wiring it into Claude

### Claude Desktop — `claude_desktop_config.json`

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "paymap": {
      "command": "node",
      "args": ["/absolute/path/to/repo/apps/agent/src/mcp-server.mjs"],
      "env": {
        "STELLAR_NETWORK": "stellar:testnet",
        "STELLAR_RPC_URL": "https://soroban-testnet.stellar.org",
        "INDEX_URL": "http://localhost:4022",
        "FACILITATOR_URL": "http://localhost:4021",
        "PAYER_SECRET": "S...."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add paymap -- node /absolute/path/to/repo/apps/agent/src/mcp-server.mjs
```

or in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "paymap": {
      "command": "node",
      "args": ["apps/agent/src/mcp-server.mjs"]
    }
  }
}
```

`PAYER_SECRET` and friends are read from the repo-root `/.env` when they are not in `env`, so
the plain form above works once `scripts/setup-testnet.mjs` has run. Diagnostics go to
**stderr** only — stdout is the JSON-RPC transport.

---

## Tools

All four tools return **both** a JSON text block (for the model) and `structuredContent` (for
the host). Every result is `{ ok: true, ... }` or `{ ok: false, code, reason }`. `reason` is
**never null** on a rejection.

### `paymap_search`

Ranked natural-language search over the bazaar. Each candidate carries the index's `_explain`
breakdown, so the ranking is auditable rather than a black box.

```jsonc
// input
{
  "query":    "string, required — what the agent needs",
  "limit":    "integer 1-50, optional (default 5)",
  "network":  "string, optional — CAIP-2 filter, e.g. stellar:testnet",
  "maxPrice": "string, optional — budget ceiling in atomic units"
}

// output
{
  "ok": true,
  "query": "usd to brl exchange rate",
  "items": [{
    "id": "http://localhost:4023/v1/fx/usd-brl",
    "url": "...", "serviceName": "paymap-fx", "description": "...", "tags": ["fx"],
    "type": "http", "network": "stellar:testnet", "scheme": "exact",
    "payTo": "G...", "asset": "C...", "maxAmountRequired": "100000",
    "settlements": 1,
    "score": 0.4982,
    "_explain": { "bm25": 3.51, "terms": [...], "matchedFields": [...], "quality": {...} }
  }],
  "partialResults": false,
  "pagination": { "limit": 5, "cursor": null },
  "source": "http://localhost:4022"
}
```

### `paymap_browse`

Unranked catalogue listing. Use it to see what exists, or to enumerate one seller's endpoints.

```jsonc
// input
{ "type": "http | mcp, optional", "payTo": "G..., optional",
  "network": "string, optional", "limit": "1-100, default 20", "offset": "integer, default 0" }

// output
{ "ok": true, "items": [ /* same summary shape as search, without score */ ],
  "total": 4, "limit": 20, "offset": 0, "source": "http://localhost:4022" }
```

### `paymap_describe`

Full discovery metadata for one resource, flattened into a call-construction brief: every
parameter with its type, whether it is required, and its description — so the agent can build a
valid call with no external documentation.

```jsonc
// input
{ "id": "string, required — resource id from search/browse (url, or url#toolName for MCP)" }

// output
{
  "ok": true,
  "id": "http://localhost:4023/v1/fx/usd-brl",
  "resource": { "url": "...", "serviceName": "...", "description": "...", "tags": [...] },
  "type": "http", "network": "stellar:testnet", "scheme": "exact",
  "payTo": "G...", "asset": "C...", "maxAmountRequired": "100000",
  "routeTemplate": "/v1/fx/{pair}",
  "input":  { "type": "http", "method": "GET", "queryParams": {...} },
  "output": { "type": "json", "example": {...} },
  "parameters": [
    { "name": "pair", "in": "query", "type": "string", "required": true,
      "description": "Currency pair", "enum": null, "example": "USD/BRL" }
  ],
  "howToCall": { "tool": "paymap_pay", "url": "...", "method": "GET", "params": {...},
                 "methodHint": "Pass params as the query string (paymap_pay defaults to GET).",
                 "note": "..." },
  "source": "http://localhost:4022"
}
```

### `paymap_pay`

The whole x402 loop in one call: request → 402 challenge → sign the Soroban auth entry with the
operator's `PAYER_SECRET` → retry with the payment header → return the unlocked body plus the
settled transaction hash and its explorer link.

Spends real testnet funds. Set `maxPrice` to cap it.

```jsonc
// input
{
  "url":       "string, required — absolute URL of the paid resource",
  "params":    "object, optional — query string for GET, JSON body for POST/PUT/PATCH",
  "method":    "GET | POST | PUT | PATCH | DELETE, optional (default GET)",
  "maxPrice":  "string, optional — spend ceiling in atomic units",
  "timeoutMs": "integer 1000-120000, optional (default 30000)"
}

// output
{
  "ok": true,
  "paid": true,
  "status": 200,
  "body": { "pair": "USD/BRL", "bid": 5.4312, "ask": 5.4389, "mid": 5.435 },
  "txHash": "9f2c…",
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/9f2c…",
  "payer": "G...", "network": "stellar:testnet",
  "amount": "100000", "asset": "C...", "payTo": "G...",
  "timings": { "challengeMs": 12, "signMs": 640, "settleMs": 2180, "totalMs": 2832 }
}
```

A free resource is not an error: it returns `{ ok: true, paid: false, body }`.
`timings` is always present, including on rejections — the UI reads it.

---

## Error codes

Every rejection is `{ ok: false, code, reason }` with a **non-null, human-readable `reason`**.
Nothing throws out of a tool handler.

| Code | Meaning | Typical fix |
|---|---|---|
| `PAYMAP_CONFIG_MISSING` | `PAYER_SECRET` absent or not a valid `S...` seed | run `scripts/setup-testnet.mjs`, or set it in the MCP `env` block |
| `PAYMAP_BAD_REQUEST` | malformed argument (empty url/query/id, non-integer `maxPrice`) | fix the argument named in the reason |
| `PAYMAP_INDEX_UNREACHABLE` | the discovery index did not answer | start the stack (`npm run dev:all`) or set `INDEX_URL` |
| `PAYMAP_INDEX_ERROR` | index answered non-2xx or non-JSON | check the index logs; the HTTP status is in the reason |
| `PAYMAP_NO_RESULTS` | nothing matched the query or the filters | broaden the query, or raise `maxPrice` |
| `PAYMAP_NOT_FOUND` | no resource with that id is registered | get a valid id from `paymap_search` / `paymap_browse` |
| `PAYMAP_RESOURCE_UNREACHABLE` | the seller endpoint refused the connection | the seller is down, or the URL is wrong |
| `PAYMAP_402_MALFORMED` | 402 with no decodable `PAYMENT-REQUIRED` header and no `accepts` body | the seller is not speaking x402 v2 |
| `PAYMAP_UNSUPPORTED_NETWORK` | resource wants a network/scheme this agent is not configured for | testnet only; check `STELLAR_NETWORK` |
| `PAYMAP_PRICE_EXCEEDS_BUDGET` | quoted price is above the caller's `maxPrice` | raise `maxPrice`, or pick a cheaper resource |
| `PAYMAP_SIGN_FAILED` | the Soroban auth entry could not be built or signed | check RPC reachability and the payer account |
| `PAYMAP_INSUFFICIENT_BALANCE` | payer lacks the asset, or has no trustline | fund the payer / add the trustline |
| `PAYMAP_REPLAY_REJECTED` | the payment authorization had already been consumed | sign a fresh payment; never reuse a header |
| `PAYMAP_AUTH_EXPIRED` | the auth entry's ledger bounds had passed | retry — signing is cheap |
| `PAYMAP_SETTLE_FAILED` | facilitator returned `success: false` for another reason | the facilitator's `errorReason` is quoted in the reason |
| `PAYMAP_UPSTREAM_ERROR` | unexpected non-402 HTTP error, or an internal throw | read the reason; the HTTP status is included |
| `PAYMAP_TIMEOUT` | the resource or index exceeded the timeout | raise `timeoutMs` |

The enum is exported as `ERROR_CODES` from `src/pay.mjs`, and facilitator failure strings are
mapped onto it deterministically by `classifySettleFailure()`.

---

## The terminal demo

```bash
node apps/agent/src/cli.mjs "usd to brl exchange rate"
node apps/agent/src/cli.mjs "an agent that reads invoices" --dry-run
node apps/agent/src/cli.mjs "usd to brl exchange rate" --max-price 200000 --limit 3
```

Four movements, narrated live:

```
01  QUERY             the natural-language ask, and the wallet behind it
02  SIGHTS TAKEN      ranked candidates with score meters and _explain breakdowns
03  BEARING FIXED     the chosen resource, its price, its payee
04  PAYMENT SETTLED   402 challenge · auth-entry signing · settled tx · explorer link
    UNLOCKED PAYLOAD  the data the agent just bought
```

| Flag | Effect |
|---|---|
| `--dry-run`, `-n` | discovery and ranking only; never signs, never spends |
| `--max-price N` | refuse to pay above `N` atomic units |
| `--limit N` | number of candidates to sight (default 5) |

---

## Using the payment client directly

```js
import { payAndFetch, ERROR_CODES } from './apps/agent/src/pay.mjs';

const res = await payAndFetch('http://localhost:4023/v1/fx/usd-brl', {
  params: { pair: 'USD/BRL' },
  maxPrice: '200000',
  onEvent: (e) => console.log(e.stage)   // request · challenge · signed · settled
});

if (!res.ok) console.error(res.code, res.reason);
else console.log(res.body, res.txHash, res.explorerUrl, res.timings);
```

`payAndFetch` never throws for a protocol or network failure — it resolves to a coded result.

---

## Tests

```bash
node --test apps/agent/src/replay-guard.test.mjs
```

Proves that a replayed `PAYMENT-SIGNATURE` header and an expired authorization entry are both
refused, each with a non-null `reason` and the right code, and that no rejection path in the
client can produce a null reason. The first three tests are hermetic (local stub seller,
throwaway keypair, no network). The fourth exercises the live facilitator and **skips cleanly**
when it is not running.

---

## Environment

Read from the repo-root `/.env`, overridable by `process.env` or the MCP `env` block.

| Variable | Default | Used for |
|---|---|---|
| `STELLAR_NETWORK` | `stellar:testnet` | CAIP-2 network id passed to `createEd25519Signer` |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC for simulation/signing |
| `INDEX_URL` | `http://localhost:4022` | discovery index |
| `FACILITATOR_URL` | `http://localhost:4021` | facilitator (`/supported`, `/verify`, `/settle`) |
| `SELLER_URL` | `http://localhost:4023` | demo seller |
| `PAYER_SECRET` | — | the agent's wallet; **required for `paymap_pay`** |
| `PAYER_PUBLIC` | — | display only |
| `ASSET_CODE` | `SXT` | display only |

## Protocol notes

Verified against the installed `@x402/core@2.21` build, not assumed:

- 402 challenge arrives in the **`PAYMENT-REQUIRED`** response header (base64 JSON). PAYMAP
  also accepts the same object in the JSON body, which is what several v2 servers emit.
- The signed payload goes out as **`PAYMENT-SIGNATURE`** (x402 v2); PAYMAP mirrors it onto
  **`X-PAYMENT`** so v1-shaped sellers work unchanged.
- Settlement comes back in **`PAYMENT-RESPONSE`** / `X-PAYMENT-RESPONSE` as
  `{ success, errorReason, transaction, network, payer }`.
- Bazaar extension status rides on **`EXTENSION-RESPONSES`** (base64 JSON) and is surfaced as
  `extensions.bazaar` on the result.
