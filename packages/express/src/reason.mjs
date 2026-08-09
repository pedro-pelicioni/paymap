/**
 * Reason strings.
 *
 * PROJECT-WIDE RULE: every rejection carries a non-null, human-readable reason.
 * A `402` whose `error` is `null`, `""` or `undefined` is a bug — the agent on the
 * other end has no way to decide whether to retry, top up, or give up.
 *
 * Everything that can produce a rejection in this package funnels through
 * `reasonOf`, so there is exactly one place where "no reason" can be introduced,
 * and that place substitutes a sentence instead.
 */

/** Used only when a component rejected and genuinely told us nothing. */
export const NO_REASON_GIVEN =
  "The payment was rejected but the rejecting component did not say why.";

/**
 * Coerce anything into a non-empty, human-readable reason string.
 *
 * @param {unknown} value    - a string, an Error, or whatever a remote service returned
 * @param {string}  fallback - sentence to use when `value` carries no usable text
 * @returns {string} a non-empty string, always
 */
export function reasonOf(value, fallback = NO_REASON_GIVEN) {
  const text = extract(value);
  if (text) return text;
  const fb = extract(fallback);
  return fb || NO_REASON_GIVEN;
}

function extract(value) {
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return String(value.message ?? "").trim();
  if (value && typeof value === "object") {
    for (const key of ["invalidReason", "errorReason", "reason", "error", "message"]) {
      const inner = value[key];
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Truncate untrusted remote text before it becomes part of a reason we emit. */
export function snippet(value, max = 200) {
  const text = typeof value === "string" ? value : safeStringify(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
