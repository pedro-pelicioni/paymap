/**
 * Facilitator-wide configuration for a paywall instance.
 *
 * Everything here is validated ONCE, when `stellarsightPaywall()` is called — i.e. while the
 * developer is looking at their terminal — rather than on the first request from a paying
 * agent. A typo in `payTo` should stop the process at boot, not silently mint 402s that
 * point at an account nobody owns.
 */

export const DEFAULTS = Object.freeze({
  network: "stellar:testnet",
  scheme: "exact",
  decimals: 7, // classic Stellar assets and their SACs
  maxTimeoutSeconds: 120,
  feesSponsored: true,
  x402Version: 2,
  announce: true,
  announceDelayMs: 1200,
  announceIntervalMs: 30_000,
  facilitatorTimeoutMs: 15_000,
  indexTimeoutMs: 5_000,
  mimeType: "application/json",
});

/**
 * @param {object} options - see README
 * @returns {object} a frozen, validated config
 */
export function normalizeConfig(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("stellarsightPaywall(options): options must be an object.");
  }

  const facilitator = requireOrigin("facilitator", options.facilitator, {
    hint: "the URL of an x402 facilitator exposing POST /verify and POST /settle, e.g. http://localhost:4021",
  });

  const index = options.index == null ? null : requireOrigin("index", options.index, {
    hint: "the URL of a STELLARSIGHT bazaar index exposing POST /discovery/resources, e.g. http://localhost:4022",
  });

  const baseUrl = options.baseUrl == null ? null : requireOrigin("baseUrl", options.baseUrl, {
    hint: "the public origin this server is reachable at, e.g. https://api.acme.dev",
  });

  const payTo = requireString("payTo", options.payTo, {
    hint: "the Stellar account that receives the money, e.g. process.env.SELLER_PUBLIC",
  });

  const asset = requireString("asset", options.asset, {
    hint: "the SEP-41 / SAC contract id of the token you price in, e.g. process.env.ASSET_SAC",
  });

  const network = requireString("network", options.network ?? DEFAULTS.network, {
    hint: 'a CAIP-2 network id, e.g. "stellar:testnet" or "stellar:pubnet"',
  });

  const scheme = requireString("scheme", options.scheme ?? DEFAULTS.scheme, {
    hint: 'the x402 payment scheme, "exact" unless you know otherwise',
  });

  const decimals = requireInteger("decimals", options.decimals ?? DEFAULTS.decimals, 0, 38);
  const maxTimeoutSeconds = requireInteger(
    "maxTimeoutSeconds",
    options.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds,
    1,
    86_400,
  );

  const config = {
    facilitator,
    index,
    baseUrl,
    payTo,
    asset,
    assetCode: options.assetCode == null ? null : String(options.assetCode),
    network,
    scheme,
    decimals,
    maxTimeoutSeconds,
    feesSponsored: options.feesSponsored ?? DEFAULTS.feesSponsored,
    extra: options.extra && typeof options.extra === "object" ? { ...options.extra } : {},
    mimeType: options.mimeType ?? DEFAULTS.mimeType,
    x402Version: requireInteger("x402Version", options.x402Version ?? DEFAULTS.x402Version, 1, 99),

    announce: options.announce ?? DEFAULTS.announce,
    announceDelayMs: requireInteger(
      "announceDelayMs",
      options.announceDelayMs ?? DEFAULTS.announceDelayMs,
      0,
      3_600_000,
    ),
    announceIntervalMs: requireInteger(
      "announceIntervalMs",
      options.announceIntervalMs ?? DEFAULTS.announceIntervalMs,
      0,
      86_400_000,
    ),

    facilitatorTimeoutMs: requireInteger(
      "facilitatorTimeoutMs",
      options.facilitatorTimeoutMs ?? DEFAULTS.facilitatorTimeoutMs,
      1,
      600_000,
    ),
    indexTimeoutMs: requireInteger(
      "indexTimeoutMs",
      options.indexTimeoutMs ?? DEFAULTS.indexTimeoutMs,
      1,
      600_000,
    ),

    fetch: options.fetch ?? globalThis.fetch,
    logger: normalizeLogger(options.logger),
    onSettled: requireFunctionOrNull("onSettled", options.onSettled),
    onRejected: requireFunctionOrNull("onRejected", options.onRejected),
  };

  if (typeof config.fetch !== "function") {
    throw new TypeError(
      "stellarsightPaywall(options): no fetch implementation available. Run on Node 18+ or pass `fetch`.",
    );
  }

  // A configured index with no baseUrl cannot be announced to safely — see announce.mjs.
  if (config.index && !config.baseUrl && config.announce) {
    config.logger.warn(
      "[stellarsight] `index` is set but `baseUrl` is not, so nothing will be announced to the bazaar. " +
        "The only origin available at request time comes from the client-supplied Host header, and " +
        "publishing that would let any caller list your routes under a URL they control. " +
        "Set `baseUrl` to the public origin of this server.",
    );
  }

  return Object.freeze(config);
}

/** Header names a browser client needs exposed / allowed. Wire these into `cors()`. */
export const X402_EXPOSED_HEADERS = Object.freeze([
  "PAYMENT-REQUIRED",
  "PAYMENT-RESPONSE",
  "X-PAYMENT-RESPONSE",
  "EXTENSION-RESPONSES",
]);

export const X402_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept",
  "payment-signature",
  "x-payment",
]);

/**
 * Ready-made options for the `cors` package so browser agents can actually read the
 * x402 headers. Not wired in automatically — CORS policy is the host app's decision.
 */
export function x402CorsOptions(overrides = {}) {
  return {
    origin: true,
    exposedHeaders: [...X402_EXPOSED_HEADERS],
    allowedHeaders: [...X402_ALLOWED_HEADERS],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

function requireString(name, value, { hint }) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `stellarsightPaywall(options): \`${name}\` is required and must be a non-empty string — ${hint}. ` +
        `Received ${describe(value)}.`,
    );
  }
  return value.trim();
}

function requireOrigin(name, value, { hint }) {
  const text = requireString(name, value, { hint });
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(
      `stellarsightPaywall(options): \`${name}\` must be an absolute URL — ${hint}. Received ${describe(value)}.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `stellarsightPaywall(options): \`${name}\` must use http: or https:, received ${describe(value)}.`,
    );
  }
  return text.replace(/\/+$/, "");
}

function requireInteger(name, value, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TypeError(
      `stellarsightPaywall(options): \`${name}\` must be an integer between ${min} and ${max}, received ${describe(value)}.`,
    );
  }
  return n;
}

function requireFunctionOrNull(name, value) {
  if (value == null) return null;
  if (typeof value !== "function") {
    throw new TypeError(`stellarsightPaywall(options): \`${name}\` must be a function, received ${describe(value)}.`);
  }
  return value;
}

function normalizeLogger(logger) {
  if (logger === false || logger === null) return { log() {}, warn() {}, error() {} };
  const base = logger ?? console;
  return {
    log: typeof base.log === "function" ? base.log.bind(base) : () => {},
    warn: typeof base.warn === "function" ? base.warn.bind(base) : () => {},
    error: typeof base.error === "function" ? base.error.bind(base) : () => {},
  };
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `${typeof value} ${String(value)}`;
}
