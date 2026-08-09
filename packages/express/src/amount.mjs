/**
 * Price → atomic units.
 *
 * `PaymentRequirements.amount` is an INTEGER STRING of atomic token units. Classic
 * Stellar assets and their SACs use 7 decimals, so 0.02 SXT is "200000".
 *
 * This is done with string arithmetic on purpose. `Math.round(0.07 * 1e7)` is
 * 700000.0000000001 before rounding and the whole class of "the price is off by one
 * stroop" bugs starts there. Money never touches a float in this package.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Convert a human-readable price into an integer string of atomic units.
 *
 * @param {string|number|bigint} price - e.g. "0.02", 0.02, "1", 3n
 * @param {number} decimals            - token decimals (7 for Stellar classic assets / SACs)
 * @returns {string} integer string, no sign, no leading zeros (except "0")
 * @throws {TypeError} on anything that is not an exactly-representable non-negative decimal
 */
export function toAtomicUnits(price, decimals = 7) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new TypeError(`decimals must be an integer between 0 and 38, received ${format(decimals)}.`);
  }

  const raw = stringifyPrice(price);

  const match = DECIMAL.exec(raw);
  if (!match) {
    throw new TypeError(
      `price must be a non-negative decimal number such as "0.02" or "1.5", received ${format(price)}.`,
    );
  }

  const whole = match[1];
  const fraction = match[2] ?? "";

  if (fraction.length > decimals) {
    // Silently rounding here would mean charging a different price than the
    // developer wrote down. Refuse instead.
    const trimmed = fraction.replace(/0+$/, "");
    if (trimmed.length > decimals) {
      throw new TypeError(
        `price "${raw}" has ${trimmed.length} decimal places but this asset only has ${decimals}. ` +
          `Round it yourself rather than letting the paywall guess.`,
      );
    }
  }

  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return atomic;
}

/**
 * Parse an atomic-unit string coming off the wire.
 *
 * @param {unknown} value
 * @returns {bigint|null} the value, or null when it is not an integer string
 */
export function parseAtomicUnits(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

/** Render atomic units back as a human amount, for the `extra.humanAmount` hint. */
export function fromAtomicUnits(atomic, decimals = 7) {
  const text = String(atomic).padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals) || "0";
  if (decimals === 0) return whole;
  const fraction = text.slice(text.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function stringifyPrice(price) {
  if (typeof price === "bigint") return price.toString();
  if (typeof price === "number") {
    if (!Number.isFinite(price)) {
      throw new TypeError(`price must be a finite number, received ${format(price)}.`);
    }
    const text = String(price);
    if (text.includes("e") || text.includes("E")) {
      throw new TypeError(
        `price ${format(price)} stringifies to exponent notation (${text}). ` +
          `Pass it as a decimal string instead, e.g. "0.0000001".`,
      );
    }
    return text;
  }
  if (typeof price === "string") return price.trim();
  throw new TypeError(`price must be a string or number, received ${format(price)}.`);
}

function format(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  return String(value);
}
