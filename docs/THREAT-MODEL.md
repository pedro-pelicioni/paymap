# Threat model — v0.1

Scope: the STELLARSIGHT facilitator, the Bazaar catalog and the agent-facing surfaces, as
deployed on `stellar:testnet` today. Written before mainnet on purpose — a threat model
produced after launch documents decisions instead of informing them.

This is **v0.1**. It states what is defended today, with the test that proves it, and what
is not, without dressing the gaps up as future work that is somehow already handled. The
Tranche 2 deliverable turns this document into a running system: the same surfaces, with
alerts firing against live thresholds ([MONITORING.md](MONITORING.md)).

## Assets worth attacking

| Asset | Why an attacker wants it |
|---|---|
| `FEEPAYER` XLM balance | Every settlement's network fee is sponsored from it. Drain it and the facilitator stops settling for everyone. |
| Catalog integrity | The catalog is read by autonomous agents that then **send money**. A poisoned listing redirects payment or executes an unintended call. |
| The write path (`POST /discovery/resources`) | Unauthenticated writes to a public index are a spam and phishing surface. |
| Buyer authorization payloads | A signed Soroban auth entry in flight is a bearer instrument until it is consumed or expires. |
| Reviewer/agent trust in the numbers | Fabricated settlement counts or ranking manipulation are cheaper attacks than any of the above and buy the same outcome: traffic. |

## Trust boundaries

1. **Seller → facilitator.** Discovery metadata is attacker-controlled. Clients echo the
   `resource` block back inside the payment payload, so every field crossing this boundary
   is hostile input.
2. **Buyer → facilitator.** The payment payload is attacker-controlled; cryptographic
   validity is delegated to `@x402/stellar`, never reimplemented here.
3. **Facilitator → Stellar.** The only party that can move funds is the buyer, via their
   own signature. The facilitator is non-custodial: it sponsors fees and submits.
4. **Catalog → agent.** Everything the catalog returns will be read by an LLM-driven
   agent. Text in a listing is untrusted content, not instructions.

## Threats, controls, and the test that proves each

| # | Threat | Control today | Proof |
|---|---|---|---|
| T1 | **Path traversal in `routeTemplate`** — a listing escapes its own route (`/v1/%252e%252e/admin`) | Fixed-point percent-decoding (capped at 5 passes, fail-closed on malformed `%`), traversal check **after** decode | `test/catalog-integrity.test.mjs` — single, double and triple encoding |
| T2 | **SSRF via `iconUrl`** — the catalog is used to probe internal networks | Host deny-list covering IP literals in decimal/hex/octal, `[::1]`, `169.254.169.254`, `0.0.0.0`, userinfo tricks, and the `data:`/`file:`/`javascript:` schemes | 66 adversarial cases in the same suite |
| T3 | **Catalog flooding** — one seller drowns the index | Per-record caps (serviceName 32, 5 tags × 32, description 512), dedupe before cap, **soft-drop**: the hostile field is dropped and the legitimate record survives | integrity suite; the survival invariant is asserted explicitly |
| T4 | **Listing hijack** — a seller lists a resource they do not own, or under someone else's `payTo` | **PARTIAL.** Cataloging is bound to a settled payment, and the seller announce path checks baseUrl against Host. There is **no per-seller identity**: the hosted write path is one shared bearer token | Gap — Tranche 1 deliverable 1.2 (TOFU `payTo` binding + ownership re-verification) |
| T5 | **Prompt injection through listing text** — seller metadata instructs the reading agent | **PARTIAL.** Control characters and RTL overrides are stripped and lengths capped, which limits the payload. Nothing marks listing text as untrusted at the MCP boundary | Gap — noted for Tranche 2 alongside the hosted MCP endpoint |
| T6 | **Fee-payer drain** — an attacker forces sponsored fees until XLM runs out | Fee ceiling of 500,000 stroops per transaction, empirically calibrated (observed simulation ~57,000); settlement fails at `/verify` before money moves if simulation exceeds it | The ceiling and its derivation are in `apps/facilitator/src/server.mjs`; no alerting yet — Tranche 2 |
| T7 | **Replay of a signed authorization** | Soroban host nonce + `signatureExpirationLedger`. Enforced **on-chain**, not by us: there is deliberately no facilitator-side replay cache to be poisoned or bypassed | `apps/agent/src/replay-guard.test.mjs` (live-path test, skipped without a running facilitator) |
| T8 | **Sequence-number contention as denial of service** | **NOT DEFENDED.** One `FEEPAYER` means one sequence number. Measured: 4/4 payments succeed serially, 1/10 succeed at 10-way concurrency | [LOAD-BASELINE.md](LOAD-BASELINE.md) — Tranche 1 deliverable 1.1 (channel-account pool) |
| T9 | **Ranking manipulation** — a seller fakes settlements to climb the results | Quality prior capped at 0.25 against relevance's 1.00, so popularity can only break ties; seed records pinned to `settlements: 0` so demo breadth can never inflate a total | Asserted by test: a 900k-settlement record loses to a zero-settlement one when the query matches the latter. **Still gameable** by real cheap settlements — stated in [SEARCH-QUALITY.md](SEARCH-QUALITY.md) |
| T10 | **Durable-store compromise** — a record is written straight into Redis, bypassing validation | Only the **post-validation** record is persisted, by both writers (settle path and announce path). The store is never a validation bypass | `packages/index/src/store.mjs` accepts what the catalog stored, not the request body |
| T11 | **Store outage** | Read-only degradation: the catalog serves the seeded corpus and `/discovery/health` reports `mode`, `writable` and the store error rather than 500-ing | `test/store-transport.test.mjs`; degraded path exercised in `verify:api` |
| T12 | **Silent spec drift** — the wire format stops matching the spec and nobody notices | Stock-client conformance: unmodified `@x402/fetch` and `withBazaar()` drive the real endpoints; this caught a real v1/v2 drift in our own seller | `npm run verify:conformance` (settled hashes published; needs a funded payer, so it runs per release); `npm run verify:api` (46 checks) runs in CI on every push and on a nightly schedule |

## Non-custodial by construction

The facilitator holds no user funds and has no deposit or withdrawal path. Every
settlement is a direct SEP-41 transfer from the buyer's account to the seller's, authorized
by the buyer's own signature over the full invocation. A compromised facilitator can refuse
to serve, and can waste its own sponsored fees. It **cannot** redirect a payment, alter an
amount, or move funds it was not authorized to move.

## Residual risk, stated plainly

- **Bus factor 1.** One maintainer. Mitigated by Apache-2.0 licensing end to end, public CI
  anyone can run, and the Tranche 3 handoff deliverable (named maintainer, runbooks).
- **No external audit yet.** Scheduled through the SCF Audit Bank in Tranche 3; the audit
  fee is excluded from the budget per the rules.
- **Testnet only.** No real funds are at risk today. Mainnet is gated behind the audit
  remediation and the monitoring in [MONITORING.md](MONITORING.md) being live.
- **Single shared write token.** Adequate for a demo catalog, inadequate for a public index
  with third-party sellers. Tranche 1 replaces it with per-seller `payTo` binding.

## Review

Revisit at each tranche boundary, and whenever the x402 spec moves (it went 2.21 → 2.22
during development). Findings from the Tranche 3 security review land here with their
remediation, tracked as public issues.
