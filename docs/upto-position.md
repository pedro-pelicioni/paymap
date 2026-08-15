# Position on the Stellar `upto` scheme

**Posted** on [`stellar/x402-stellar#72`](https://github.com/stellar/x402-stellar/issues/72)
as [comment 5303705529](https://github.com/stellar/x402-stellar/issues/72#issuecomment-5303705529),
15 August 2026. This file is the text plus the reasoning behind it, versioned alongside the
code that will implement whatever the thread settles on.

## Why this is not a competing spec

An earlier draft of this document argued that four independent implementations disagreed and
that somebody should write `scheme_upto_stellar.md`. Reading the thread before posting made
that framing wrong, and it is worth recording why rather than quietly replacing it:

- **@tolgayayci** opened the issue with a full design and both schemes settling on testnet,
  with real USDC, from keypair and smart accounts, plus a fix upstream in
  [x402-foundation/x402#3018](https://github.com/x402-foundation/x402/pull/3018).
- **@bomanaps** replied that they had reached the same design independently, pushed for
  `validAfter` to be enforced on-chain, and asked about the atomic pull-max / pay-actual /
  refund shape.
- **@Iam0TI** then opened [x402-foundation/x402#3134](https://github.com/x402-foundation/x402/pull/3134),
  the proposed Stellar binding as a spec, implemented and tested on testnet.

So the design has converged and a spec is under review. A fourth private design would add a
data point, not a decision. The two questions still genuinely open in the thread —
`validAfter` on-chain versus verify-time, and residual-allowance hygiene — belong to the
people who have implemented settlement, and both already have advocates there.

## What we contributed instead

The requirements the **discovery layer** places on the spec. These are invisible from the
settlement side, which is why three implementers had not raised them, and they are the part
we are positioned to see: we run the catalog.

**1. What does a listing advertise as the price of an `upto` resource?**
`PaymentRequirements.amount` is a single value. For `exact` it is the price. For `upto` the
only figure a seller can honestly publish before the call is the *ceiling*, which is not the
price and is usually much larger. A catalog that puts a ceiling in the field an agent reads
as "cost" makes every metered service look expensive beside a fixed-price one — a bias
against exactly the services `upto` exists to enable. The spec need not solve pricing, but it
should say whether `amount` on an `upto` requirement is the ceiling, and ideally let a
resource state a typical or unit price alongside it. Otherwise every catalog invents its own
convention and cross-catalog price comparison stops being portable, which is the thing
discovery is for.

**2. Budget filters silently exclude the cheap case.**
"Find me something under X" is the natural agent behaviour. If a listing carries only the
ceiling, the filter drops every metered service whose ceiling exceeds the budget even when
the settled amount would land far below it. A `unitPrice` or `typicalAmount` hint, even
non-normative, makes that filter correct instead of conservative.

**3. Usage signals stop being comparable once amounts vary.**
Catalogs rank partly on observed settlements. Under `exact`, counting settlements is a
reasonable proxy for usage. Under `upto`, a 0.001 settle and a 5.0 settle count the same, so
an endpoint called constantly for trivial amounts outranks a substantial one — and gaming it
gets cheaper the smaller the settlements are. If the settle response carries the actual
amount in a stable place, saying so normatively lets catalogs weight by value rather than by
count, which is materially harder to fake.

## Where we came down on the thread's open questions

- **`validAfter` on-chain:** agreed with @bomanaps and @Iam0TI, and discovery adds a reason.
  A listing is a cached claim that a client may act on much later; the more of the validity
  window the ledger enforces rather than the facilitator, the less a stale catalog entry can
  be turned into a payment nobody intended.
- **Allowance hygiene:** the atomic pull-max, pay-actual, refund-remainder shape reads better
  than leaving a residual to expire, because the payer's worst case should be bounded by the
  transaction they signed rather than by an expiry they have to track. Stated as a
  preference, not a finding — we have implemented neither.

## What this commits us to

Implement whatever #3134 converges on rather than a variant of it, and say so publicly when
we do. The funded work (Tranche 2) is the discovery-side notes upstream, a **second
conformant implementation with a published interop report** — three implementations exist on
Stellar and no two have been tested against each other, so interoperability is currently an
assertion — and the catalog-side implementation of the three points above.
