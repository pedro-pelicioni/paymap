# Position on the Stellar `upto` scheme

**Status: draft, ready to post** on [`stellar/x402-stellar#72`](https://github.com/stellar/x402-stellar/issues/72)
("upto scheme design discussion", opened 2026-08-03).

Post it from Pedro's account and paste the comment link into the SCF submission. It is
kept in the repo so the position is versioned with the code that will implement it, and so
the submission links to something that exists whether or not the thread has moved.

---

## Why STELLARSIGHT has not shipped an `upto` contract yet

We build the facilitator-side Bazaar. `upto` matters to us because metered services —
token billing, bandwidth, compute — are exactly the listings a discovery layer is least
useful without: an agent can find them and then cannot pay for what it actually used.

We deliberately have not shipped a contract into this gap, and the reason is visible in
this thread rather than in our roadmap. At least four independent Stellar implementations
of "the `upto` scheme" now exist or are proposed, and they disagree on decisions that are
not stylistic — they change what a client must sign and what a settlement costs:

| Decision | Position A | Position B |
|---|---|---|
| Residual allowance after settling below the maximum | Refund/zero it atomically, contract leaves nothing behind | Let it expire on its own `live_until_ledger` |
| Zero-value settlement | Submit a real transaction so the auth nonce is consumed | Submit nothing, to avoid a fee for a no-op |
| What the payer signs | `require_auth_for_args((token, payTo, max))` with `actual` supplied at settle | Variants that bind or omit different subsets |
| Rent and TTL responsibility | Contract-side, monitored | Left to the operator |

Two of these produce **observably different on-chain behaviour for the same logical
payment**. A facilitator that assumes one and meets the other does not fail loudly; it
fails as a rejected settlement with a generic reason, which is the worst kind.

Shipping a fifth incompatible contract would add a data point, not a decision. What the
ecosystem is short of is not implementations — it is the normative text that makes them
interchangeable.

## What we think the spec has to pin down

Ordered by how much damage ambiguity does:

1. **The exact authorization tree the payer signs**, as a shape, not prose. A facilitator
   must be able to reject a settlement whose root entry carries `actual`, or whose nested
   `approve` targets a contract other than the one advertised in `/supported`, and it must
   reject it deterministically. Position A and B above disagree here today; a client cannot
   be written against "usually".

2. **Whether zero settlement is on-chain.** This is not a micro-optimisation. If zero
   settlement submits nothing, the authorization nonce survives and the facilitator now
   owns a replay window it did not choose. If it submits, someone pays a fee for a no-op.
   Both are defensible; only one can be the spec, and clients must know which.

3. **Residual-allowance semantics.** "Refund atomically" and "let it expire" give a payer
   materially different exposure between settlement and expiry. This belongs in the
   security considerations section, not in each implementation's README.

4. **The temporal coupling.** `allowance expiration >= contract deadline >= settlement
   time`, all derived from the operator's advertised `maxTimeoutSeconds`. Three clocks with
   an ordering that is currently implicit in every implementation we have read.

5. **A negative-test matrix in the spec itself.** Above-maximum, altered recipient, altered
   token, expired authorization, replay, unexpected sub-invocation, zero settlement. If the
   spec ships the matrix, conformance is checkable rather than asserted — which is what
   made the `exact` scheme's stock-client test worth running. We found a v1/v2 wire drift in
   our own seller precisely because that test existed for `exact`.

## What we are offering

We are funding this as a Tranche 2 deliverable of an SCF #45 RFP submission and would
rather spend it converging than competing:

- We will write `scheme_upto_stellar.md` **against whatever this thread converges on**,
  including the negative-test matrix above, and open it upstream rather than vendoring it.
- We will implement it in a facilitator that already passes stock-client conformance for
  `exact`, and publish settled testnet hashes for the partial, maximum and zero cases so
  the matrix has evidence attached.
- If another implementation lands first, we will conform to it and say so. A second
  interoperable facilitator is worth more to the ecosystem than a fourth incompatible
  contract.

Concretely, the smallest useful next step is a decision on items 1 and 2. Everything else
can follow from them.

## Our current bias, stated so it can be argued with

- **Zero settlement should submit**, because a facilitator should never be left holding a
  live authorization it cannot invalidate. The fee is small and the alternative moves a
  security property from the chain into off-chain bookkeeping.
- **The residual should be zeroed atomically**, for the same reason: shorter exposure
  window, and the payer's worst case is bounded by the transaction they signed rather than
  by an expiry they have to track.
- **The contract should be immutable and storage-less** — no admin, no upgrade path, no
  balance — so the audit surface is one function and replacement is a config change on the
  facilitator rather than a governance event.

Happy to be wrong on any of these; they are conclusions from reading the other designs in
this thread, not from operating one.
