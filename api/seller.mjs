/**
 * The example paid API, served on the public domain.
 *
 * Same import-not-reimplement relationship as api/facilitator.mjs: this is the app
 * `npm run dev:seller` binds to :4023, with vercel.json routing /v1/* and
 * /.well-known/x402 here. With SELLER_URL, INDEX_URL and FACILITATOR_URL pointing at the
 * public origin, its routes announce themselves into the durable catalog as reachable
 * URLs — which is what finally moves `liveRecords` off zero: records a visitor can
 * actually pay, not `.example` placeholders.
 *
 * The announce is awaited inside the first request rather than fired at module load. A
 * serverless runtime may suspend an instance the moment a response is sent, and a
 * fire-and-forget POST caught mid-flight would be an announce that sometimes happened.
 * Once per instance is enough: the hosted index writes through to Redis, so a single
 * completed announce outlives every instance that follows.
 */
import { app, preRegister } from "../apps/seller/src/server.mjs";

let announced;

export default async function handler(req, res) {
  announced ??= preRegister({ quiet: true }).catch(() => {
    announced = undefined; // a failed announce retries on the next request
  });
  await announced;
  return app(req, res);
}
