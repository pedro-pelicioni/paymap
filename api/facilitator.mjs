/**
 * The x402 facilitator, served on the public domain.
 *
 * This is the SAME Express app that `npm run dev:facilitator` binds to :4021 — imported,
 * not reimplemented, exactly like api/discovery/* imports packages/index. vercel.json
 * rewrites /supported, /verify, /settle, /health and /events here, so the two halves of
 * the RFP title answer on one origin.
 *
 * Serverless caveats, stated rather than hidden:
 *   - /settle submits to Stellar RPC and waits; maxDuration in vercel.json covers the
 *     observed settle time (~5-15s) with room.
 *   - /events is SSE from a function, so a stream ends when the function's clock does
 *     and the client reconnects. Fine for a feed; run the server directly for a tail
 *     that never blinks.
 *   - The in-process catalog here is per-instance and seeds at cold start. Discovery on
 *     this domain is served by api/discovery/* against the durable store, not by this.
 *
 * FEEPAYER_SECRET must be present in the deployment environment — the module derives
 * the fee-payer signer at load, which is also the honest failure mode: no signer, no
 * facilitator, said at boot instead of on the first settle.
 */
import { app } from "../apps/facilitator/src/server.mjs";

export default app;
