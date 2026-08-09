/**
 * A priced route: its declaration, and the x402 objects derived from it.
 *
 * The single most important property of this file is that `requirementsFor()` is the
 * ONLY source of price, asset and payTo. The client echoes a `PaymentRequirements`
 * object back inside `PAYMENT-SIGNATURE`; that echo is a hint about which offer it
 * took, never an input to what we charge. The facilitator is always handed the
 * requirements built here.
 */

import { declareDiscoveryExtension, isValidRouteTemplate } from "@x402/extensions";

import { fromAtomicUnits, toAtomicUnits } from "./amount.mjs";

const QUERY_METHODS = new Set(["GET", "HEAD", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Validate one `pay({...})` declaration and freeze everything derived from it.
 *
 * Throws — loudly, at declaration time — rather than degrading at request time.
 *
 * @param {object} declaration - the route options a developer wrote
 * @param {object} config      - the normalized paywall config
 * @returns {object} compiled route
 */
export function compileRoute(declaration, config) {
  if (declaration === null || typeof declaration !== "object") {
    throw new TypeError(
      "pay(route): route must be an object, e.g. pay({ price: '0.02', serviceName: 'acme-weather' }).",
    );
  }

  const method = normalizeMethod(declaration.method);
  const path = normalizePath(declaration.path);
  const amount = resolveAmount(declaration, config);
  const routeTemplate = resolveRouteTemplate(declaration, path);

  const payTo = optionalString(declaration.payTo) ?? config.payTo;
  const asset = optionalString(declaration.asset) ?? config.asset;
  const maxTimeoutSeconds = declaration.maxTimeoutSeconds ?? config.maxTimeoutSeconds;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1) {
    throw new TypeError(
      `pay(route): \`maxTimeoutSeconds\` must be a positive integer, received ${String(maxTimeoutSeconds)}.`,
    );
  }

  const tags = normalizeTags(declaration.tags, config.logger);
  const serviceName = normalizeServiceName(declaration.serviceName, config.logger);
  warnAboutUndocumentedPathParams(declaration, path, method, config.logger);

  const route = {
    method,
    path,
    pathIsDeclared: path !== null,
    routeTemplate,
    amount,
    humanAmount: fromAtomicUnits(amount, config.decimals),
    payTo,
    asset,
    maxTimeoutSeconds,
    serviceName,
    description: optionalString(declaration.description) ?? undefined,
    tags,
    mimeType: optionalString(declaration.mimeType) ?? config.mimeType,
    iconUrl: optionalString(declaration.iconUrl) ?? undefined,
    extra: declaration.extra && typeof declaration.extra === "object" ? { ...declaration.extra } : {},
    discovery: buildDiscovery(declaration, method),
  };

  return route;
}

/** Best-effort learning of the mount path from the first request that reaches us. */
export function learnPath(route, req) {
  if (route.path) return false;
  // `req.route.path` is the pattern the host app registered — it comes from the app's own
  // router, never from the client, so it is safe to publish. `req.originalUrl` is only a
  // fallback and yields a concrete path rather than a template.
  const mounted = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const pattern = req.route?.path;
  const learned =
    typeof pattern === "string" && pattern.startsWith("/")
      ? `${mounted}${pattern === "/" && mounted ? "" : pattern}`
      : String(req.originalUrl ?? req.url ?? "").split("?")[0];
  if (!learned || !learned.startsWith("/")) return false;
  route.path = learned;
  return true;
}

/**
 * Build the discovery extension with the stock `declareDiscoveryExtension`.
 *
 * `method` is normally injected by the resource-server extension. We run the 402 loop
 * ourselves, so we inject it here, exactly as apps/seller does.
 */
function buildDiscovery(declaration, method) {
  const cfg = {};
  if (declaration.input !== undefined) cfg.input = clone(declaration.input, "input");
  if (declaration.inputSchema !== undefined) cfg.inputSchema = clone(declaration.inputSchema, "inputSchema");
  if (declaration.pathParams !== undefined) cfg.pathParams = clone(declaration.pathParams, "pathParams");
  if (declaration.pathParamsSchema !== undefined) {
    cfg.pathParamsSchema = clone(declaration.pathParamsSchema, "pathParamsSchema");
  }
  if (declaration.output !== undefined) cfg.output = clone(declaration.output, "output");

  if (BODY_METHODS.has(method)) {
    const bodyType = declaration.bodyType ?? "json";
    if (!["json", "form-data", "text"].includes(bodyType)) {
      throw new TypeError(
        `pay(route): \`bodyType\` must be "json", "form-data" or "text" for ${method} routes, received ${JSON.stringify(bodyType)}.`,
      );
    }
    cfg.bodyType = bodyType;
    if (cfg.input === undefined) cfg.input = {};
  } else if (declaration.bodyType !== undefined) {
    throw new TypeError(
      `pay(route): \`bodyType\` is meaningless on a ${method} route — ${method} requests carry query and path params, not a body.`,
    );
  }

  let block;
  try {
    block = declareDiscoveryExtension(cfg);
  } catch (e) {
    throw new TypeError(
      `pay(route): @x402/extensions rejected this route's discovery metadata: ${e?.message ?? String(e)}`,
    );
  }
  if (!block?.bazaar?.info) {
    throw new TypeError(
      "pay(route): declareDiscoveryExtension did not return a bazaar block. Check your @x402/extensions version.",
    );
  }
  return block;
}

/**
 * A per-use deep clone with `method` and `routeTemplate` injected.
 * Never hand out the stored declaration — a consumer that mutates it would poison
 * every later 402.
 */
export function discoveryFor(route) {
  const block = structuredClone(route.discovery);
  if (block.bazaar?.info?.input) block.bazaar.info.input.method = route.method;
  if (route.routeTemplate) block.bazaar.routeTemplate = route.routeTemplate;
  return block;
}

/** x402 v2 `ResourceInfo`. */
export function resourceInfoFor(route, origin) {
  const info = {
    url: resourceUrl(route, origin),
    mimeType: route.mimeType,
  };
  if (route.description) info.description = route.description;
  if (route.serviceName) info.serviceName = route.serviceName;
  if (route.tags?.length) info.tags = route.tags;
  if (route.iconUrl) info.iconUrl = route.iconUrl;
  return info;
}

export function resourceUrl(route, origin) {
  return `${origin ?? ""}${route.path ?? ""}`;
}

/**
 * x402 v2 `PaymentRequirements` — THE authority on money for this route.
 *
 * Nothing a client sends reaches this function. It is re-derived on every request and
 * is what gets handed to `/verify` and `/settle`.
 */
export function requirementsFor(route, config) {
  const extra = {
    ...config.extra,
    ...route.extra,
    areFeesSponsored: config.feesSponsored,
  };
  if (config.assetCode) {
    extra.assetCode = config.assetCode;
    extra.humanAmount = `${route.humanAmount} ${config.assetCode}`;
  } else {
    extra.humanAmount = route.humanAmount;
  }
  return {
    scheme: config.scheme,
    network: config.network,
    asset: route.asset,
    amount: route.amount,
    payTo: route.payTo,
    maxTimeoutSeconds: route.maxTimeoutSeconds,
    extra,
  };
}

/** x402 v2 `PaymentRequired` — the whole 402 challenge for a route. */
export function paymentRequiredFor(route, config, origin, error) {
  return {
    x402Version: config.x402Version,
    error,
    resource: resourceInfoFor(route, origin),
    accepts: [requirementsFor(route, config)],
    extensions: discoveryFor(route),
  };
}

/** The bazaar-index record this route announces. Mirrors apps/seller's `preRegister`. */
export function announceRecordFor(route, config, origin) {
  const disc = discoveryFor(route);
  const url = resourceUrl(route, origin);
  return {
    id: url,
    resource: {
      url,
      serviceName: route.serviceName,
      tags: route.tags,
      description: route.description,
      iconUrl: route.iconUrl,
      mimeType: route.mimeType,
    },
    type: "http",
    network: config.network,
    scheme: config.scheme,
    payTo: route.payTo,
    asset: route.asset,
    maxAmountRequired: route.amount,
    input: disc.bazaar?.info?.input ?? { type: "http", method: route.method },
    output: disc.bazaar?.info?.output ?? { type: "json" },
    routeTemplate: route.routeTemplate,
    extensions: ["bazaar"],
    lastSeenAt: Date.now(),
    // The index merges settlements monotonically (Math.max), so re-announcing with 0
    // can never erase observed payment history.
    settlements: 0,
  };
}

/** The public, read-only view of a route returned by `pay.routes()`. */
export function publicViewOf(route, config) {
  return Object.freeze({
    method: route.method,
    path: route.path,
    routeTemplate: route.routeTemplate,
    price: route.humanAmount,
    amount: route.amount,
    asset: route.asset,
    payTo: route.payTo,
    network: config.network,
    scheme: config.scheme,
    serviceName: route.serviceName,
    description: route.description,
    tags: route.tags ? Object.freeze([...route.tags]) : undefined,
  });
}

// ---------------------------------------------------------------------------

function normalizeMethod(value) {
  const method = String(value ?? "GET").toUpperCase();
  if (!QUERY_METHODS.has(method) && !BODY_METHODS.has(method)) {
    throw new TypeError(
      `pay(route): \`method\` must be one of GET, HEAD, DELETE, POST, PUT, PATCH — received ${JSON.stringify(String(value))}.`,
    );
  }
  return method;
}

function normalizePath(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError(
      `pay(route): \`path\` must be the route path starting with "/" (e.g. "/v1/weather/:city"), received ${JSON.stringify(String(value))}.`,
    );
  }
  return value.replace(/\/+$/, "") || "/";
}

function resolveAmount(declaration, config) {
  const hasPrice = declaration.price !== undefined && declaration.price !== null;
  const hasAmount = declaration.amount !== undefined && declaration.amount !== null;

  if (hasPrice && hasAmount) {
    throw new TypeError(
      "pay(route): give either `price` (human units, e.g. '0.02') or `amount` (atomic units, e.g. '200000'), not both.",
    );
  }
  if (!hasPrice && !hasAmount) {
    throw new TypeError(
      "pay(route): `price` is required — the human-readable amount this endpoint costs, e.g. price: '0.02'.",
    );
  }

  if (hasAmount) {
    const text = String(declaration.amount).trim();
    if (!/^\d+$/.test(text)) {
      throw new TypeError(
        `pay(route): \`amount\` must be an integer string of atomic units, received ${JSON.stringify(String(declaration.amount))}. ` +
          "Use `price` if you meant human units.",
      );
    }
    return text.replace(/^0+(?=\d)/, "");
  }

  try {
    return toAtomicUnits(declaration.price, config.decimals);
  } catch (e) {
    throw new TypeError(`pay(route): ${e.message}`);
  }
}

function resolveRouteTemplate(declaration, path) {
  // An explicit routeTemplate wins; otherwise a parameterised path IS the template.
  const explicit = declaration.routeTemplate;
  const candidate =
    explicit != null ? String(explicit) : path && path.includes(":") ? path : null;
  if (candidate == null) return undefined;

  if (!isValidRouteTemplate(candidate)) {
    throw new TypeError(
      `pay(route): routeTemplate ${JSON.stringify(candidate)} was rejected by @x402/extensions. ` +
        'It must start with "/", use only [a-zA-Z0-9_/:.\\-~%], and contain neither ".." nor "://".',
    );
  }
  return candidate;
}

/**
 * `input` becomes `queryParams` in the bazaar record — that is what
 * `declareDiscoveryExtension` does with it. So documenting `/v1/weather/:city` with
 * `input: { city }` and nothing else publishes a service an agent will call as
 * `/v1/weather/:city?city=…`, with the placeholder still in the URL. The route is
 * discoverable and uncallable, which is worse than not being listed.
 *
 * The declaration is still accepted — only the developer knows what their path means —
 * but they are told, at boot, exactly which key to add.
 */
function warnAboutUndocumentedPathParams(declaration, path, method, logger) {
  if (!path) return;
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  if (names.length === 0) return;

  const documented = new Set([
    ...keysOf(declaration.pathParams),
    ...keysOf(declaration.pathParamsSchema?.properties),
  ]);
  const missing = names.filter((name) => !documented.has(name));
  if (missing.length === 0) return;

  const example = missing.map((n) => `${n}: '…'`).join(", ");
  logger.warn(
    `[starsight] ${method} ${path} takes ${missing.length === 1 ? "a path parameter" : "path parameters"} ` +
      `(${missing.map((n) => `:${n}`).join(", ")}) that this route does not document. ` +
      `\`input\` is published as queryParams, so an agent reading the bazaar would call ` +
      `${path}?${missing.map((n) => `${n}=…`).join("&")} with the placeholder still in the URL. ` +
      `Add pathParams: { ${example} } (and pathParamsSchema for descriptions) to pay({ ... }).`,
  );
}

function keysOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function normalizeTags(value, logger) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`pay(route): \`tags\` must be an array of strings, received ${typeof value}.`);
  }
  const tags = value.map((t) => String(t));
  if (tags.length > 5) {
    logger.warn(
      `[starsight] this route declares ${tags.length} tags; the bazaar keeps at most 5, so ${tags.slice(5).join(", ")} will be dropped by the index.`,
    );
  }
  return tags;
}

function normalizeServiceName(value, logger) {
  const name = optionalString(value);
  if (name && name.length > 32) {
    logger.warn(
      `[starsight] serviceName ${JSON.stringify(name)} is ${name.length} characters; the bazaar drops names longer than 32, so this route will be listed without one.`,
    );
  }
  return name ?? undefined;
}

function optionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function clone(value, field) {
  try {
    return structuredClone(value);
  } catch (e) {
    throw new TypeError(
      `pay(route): \`${field}\` must be JSON-like data (no functions, classes or cycles): ${e?.message ?? String(e)}`,
    );
  }
}
