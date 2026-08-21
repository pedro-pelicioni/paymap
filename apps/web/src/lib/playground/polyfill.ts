/**
 * `@x402/core`'s base64 header codec calls the global `Buffer`, which browsers do not
 * have. Everything else in the x402 and Stellar packages is browser-clean (no `node:`
 * imports anywhere in their dist/esm), so this one shim is the whole difference between
 * the Node payment path and this one.
 *
 * Imported first inside the lazily-loaded playground chunk, so the landing page and the
 * console never pay for it.
 */

import { Buffer } from 'buffer'

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer }
g.Buffer ??= Buffer
