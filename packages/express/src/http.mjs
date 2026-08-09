/**
 * One JSON POST helper, shared by the facilitator client and the bazaar announcer.
 *
 * It never throws. Every failure mode — DNS, connection refused, timeout, non-JSON body,
 * HTTP 5xx — comes back as `{ ok: false, error: <sentence> }`, because the caller's job is
 * to turn that into a 402 reason and a reason may never be null.
 */

import { reasonOf, snippet } from "./reason.mjs";

/**
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {unknown} body
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status: number|null, json: any, text: string|null, headers: Headers|null, error: string|null}>}
 */
export async function postJson(fetchImpl, url, body, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    const cause = reasonOf(e?.cause, "") || reasonOf(e, "the request failed");
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      ok: false,
      status: null,
      json: null,
      text: null,
      headers: null,
      error: timedOut
        ? `${url} did not answer within ${timeoutMs}ms.`
        : `could not reach ${url}: ${cause}`,
    };
  }

  const text = await response.text().catch(() => "");
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok && json === null) {
    return {
      ok: false,
      status: response.status,
      json: null,
      text,
      headers: response.headers,
      error: `${url} returned HTTP ${response.status} with a non-JSON body: ${snippet(text) || "<empty>"}`,
    };
  }

  if (response.ok && json === null) {
    return {
      ok: false,
      status: response.status,
      json: null,
      text,
      headers: response.headers,
      error: `${url} returned HTTP ${response.status} but the body was not JSON: ${snippet(text) || "<empty>"}`,
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    json,
    text,
    headers: response.headers,
    error: response.ok ? null : `${url} returned HTTP ${response.status}`,
  };
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}
