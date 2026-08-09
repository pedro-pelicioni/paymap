/**
 * Bazaar announcer — discovery BEFORE the first payment.
 *
 * A paid endpoint that only becomes discoverable once somebody has already paid for it is
 * not discoverable at all: nobody can be first. So every route with a known path is POSTed
 * to the index's `/discovery/resources` shortly after boot, and re-announced on an interval
 * because the reference index is in-memory and forgets everything when it restarts.
 *
 * SECURITY: announcements are built from `config.baseUrl` ONLY, never from a request-derived
 * origin. The only origin available at request time comes from the client-controlled `Host`
 * header, and announcing that would let any caller list this server's routes in the public
 * catalog under a URL they own. No baseUrl means no announcements, and `announce()` says so.
 *
 * Both timers are `unref()`d: a paywall must never be the reason a process refuses to exit.
 */

import { postJson } from "./http.mjs";
import { announceRecordFor } from "./route.mjs";
import { reasonOf } from "./reason.mjs";

export function createAnnouncer(config, routes) {
  let bootTimer = null;
  let interval = null;
  let stopped = false;
  let inFlight = null;

  /** Arm the boot announcement and the repeat interval. Idempotent. */
  function schedule() {
    if (stopped || !config.index || !config.announce || !config.baseUrl) return;

    if (bootTimer === null) {
      bootTimer = setTimeout(() => {
        bootTimer = null;
        void run({ quiet: false });
      }, config.announceDelayMs);
      bootTimer.unref?.();
    }

    if (interval === null && config.announceIntervalMs > 0) {
      interval = setInterval(() => void run({ quiet: true }), config.announceIntervalMs);
      interval.unref?.();
    }
  }

  /**
   * Announce every announceable route once.
   * @returns {Promise<{announced: string[], skipped: {route: string, reason: string}[], failed: {route: string, reason: string}[]}>}
   */
  function run({ quiet = true } = {}) {
    if (inFlight) return inFlight;
    inFlight = execute({ quiet }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function execute({ quiet }) {
    const result = { announced: [], skipped: [], failed: [] };

    if (!config.index) {
      result.skipped.push({
        route: "*",
        reason: "No `index` URL is configured, so there is no bazaar to announce to.",
      });
      return result;
    }
    if (!config.baseUrl) {
      result.skipped.push({
        route: "*",
        reason:
          "`baseUrl` is not configured. Announcing a URL derived from the client-supplied Host header " +
          "would let any caller list these routes under an origin they control, so nothing is announced.",
      });
      return result;
    }

    const endpoint = `${config.index}/discovery/resources`;

    for (const route of routes) {
      const label = `${route.method} ${route.path ?? "<unknown path>"}`;
      if (!route.path) {
        result.skipped.push({
          route: label,
          reason:
            "This route's path is not known yet. Pass `path` to pay({ ... }) so it can be announced at boot " +
            "instead of waiting for the first request to reveal it.",
        });
        continue;
      }

      const record = announceRecordFor(route, config, config.baseUrl);
      const res = await postJson(config.fetch, endpoint, record, config.indexTimeoutMs);

      if (res.ok && res.json?.ok !== false) {
        result.announced.push(record.id);
        if (!quiet) {
          const dropped = res.json?.dropped?.length ? ` (index dropped: ${res.json.dropped.join(", ")})` : "";
          config.logger.log(`[starsight] announced ${label} -> ${config.index}${dropped}`);
        }
      } else {
        // The index's own `reason` is the most specific thing available — prefer it over
        // the transport-level "returned HTTP 400", and fall back to that when the body
        // explains nothing.
        const reason = reasonOf(
          res.json,
          res.error ?? `the bazaar at ${config.index} rejected the announcement without saying why`,
        );
        result.failed.push({ route: label, reason });
        if (!quiet) config.logger.warn(`[starsight] could not announce ${label}: ${reason}`);
      }
    }

    return result;
  }

  function stop() {
    stopped = true;
    if (bootTimer !== null) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  }

  return { schedule, run, stop };
}
