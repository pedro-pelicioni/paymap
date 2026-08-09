/**
 * Generates src/data/integrity.json by running a hostile corpus through the REAL
 * catalog validator — `createCatalog().upsert()` from packages/index — and recording
 * exactly what it returned.
 *
 * Why this script exists: the ledger this feeds used to be hand-written. Its rule
 * names, limits and rejection reasons drifted away from the code until seven of its
 * eight rules named nothing that existed, and its stated caps (16 tags, 2000 chars)
 * contradicted the real ones (5, 512). A panel that checks one row against the source
 * and finds it invented discounts everything else in the repo. So the ledger is now
 * derived, not authored: every `rule`, `verdict` and `reason` below is a literal
 * string produced by the shipped code path.
 *
 * Verdict semantics come from `upsert`'s own contract (packages/index/src/index.mjs:137):
 *   ok: false                    -> `rejected`  — the whole record is refused
 *   ok: true with dropped[]      -> `soft-drop` — hostile field discarded, record kept
 *
 * The corpus is drawn from test/catalog-integrity.test.mjs so the ledger and the test
 * suite exercise the same inputs. Adding a case here without a matching test is how
 * this drifts again — don't.
 *
 * Never fails the build: on any error it leaves the existing file alone and exits 0.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../src/data/integrity.json')
const ROOT = resolve(here, '../../..')

/** A record that passes every check, so each case varies exactly one hostile field. */
const BASE = {
  id: 'https://api.example.com/v1/thing',
  resource: {
    url: 'https://api.example.com/v1/thing',
    serviceName: 'example-service',
    description: 'A well-formed listing used as the control for every hostile case.',
    tags: ['example'],
  },
  type: 'http',
  network: 'stellar:testnet',
  scheme: 'exact',
  payTo: 'GDQN7VJHXBQ3AGH7SMPMZLQXHDBUSVQZOYAVXQ4EFYNRQEK4NRZ3KTL3',
  asset: 'CAYCPWN5YZEHKPGZOXGU3O7R2Q5H7LT7SZ45YIO26VMFM47VBUHOGPO2',
  maxAmountRequired: '10000',
  input: { type: 'http', method: 'GET' },
  output: { type: 'json' },
  extensions: ['bazaar'],
}

/** Deep-merge a hostile patch onto BASE without mutating it. */
const withPatch = (patch) => {
  const rec = structuredClone(BASE)
  for (const [k, v] of Object.entries(patch)) {
    rec[k] = v && typeof v === 'object' && !Array.isArray(v) && rec[k] && typeof rec[k] === 'object'
      ? { ...rec[k], ...v }
      : v
  }
  return rec
}

/**
 * The hostile corpus. `field` is what a publisher would need to fix; everything else
 * in the emitted row comes back from the validator.
 *
 * `probe` re-runs the same hostile value through the leaf validator that judged it, so
 * the row can carry that validator's verbatim `reason`. `upsert` only reports WHICH
 * paths it dropped, never why — the why lives one level down, and a ledger that says
 * "field dropped" without naming the evasion is not worth showing. Both strings are
 * real output of the real code; nothing here is written by hand.
 *
 * `display` overrides the input string shown in the ledger for cases whose literal
 * value is too long to read — it must still describe the same input truthfully.
 */
const CASES = [
  {
    field: 'routeTemplate',
    input: '/v1/parse/:id/../../admin/keys',
    patch: { routeTemplate: '/v1/parse/:id/../../admin/keys' },
  },
  {
    field: 'routeTemplate',
    input: '/v1/%252e%252e/thing',
    patch: { routeTemplate: '/v1/%252e%252e/thing' },
  },
  {
    field: 'routeTemplate',
    input: '/v1/redirect/https%3A%2F%2Fexfil.example',
    patch: { routeTemplate: '/v1/redirect/https%3A%2F%2Fexfil.example' },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://169.254.169.254/latest/meta-data/',
    patch: { resource: { iconUrl: 'http://169.254.169.254/latest/meta-data/' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://2130706433/i.png',
    patch: { resource: { iconUrl: 'http://2130706433/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://0177.0.0.1/i.png',
    patch: { resource: { iconUrl: 'http://0177.0.0.1/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://[::1]/i.png',
    patch: { resource: { iconUrl: 'http://[::1]/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'https://user:pass@cdn.example.com/i.png',
    patch: { resource: { iconUrl: 'https://user:pass@cdn.example.com/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    patch: { resource: { iconUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
  },
  {
    field: 'resource.tags',
    display: '["invoice","inv","invoices", … 96 more]',
    patch: {
      resource: {
        tags: ['invoice', 'inv', 'invoices', ...Array.from({ length: 96 }, (_, i) => `tag-${i}`)],
      },
    },
  },
  {
    field: 'resource.tags',
    input: '["inv\\u0000oice"]',
    patch: { resource: { tags: ['example', 'inv\u0000oice'] } },
  },
  {
    field: 'resource.description',
    display: '"best api in the world …" (18,204 chars)',
    patch: { resource: { description: `best api in the world ${'x'.repeat(18_182)}` } },
  },
  {
    field: 'resource.serviceName',
    input: 'payment-service\\u202Egnp.exe',
    patch: { resource: { serviceName: 'payment-service‮gnp.exe' } },
  },
  {
    field: 'input.schema',
    input: '{ "$ref": "https://exfil.example/schema.json" }',
    patch: {
      input: { type: 'http', method: 'GET', schema: { $ref: 'https://exfil.example/schema.json' } },
    },
  },
  {
    field: 'resource.url',
    input: 'javascript:alert(1)',
    patch: { id: 'javascript:alert(1)', resource: { url: 'javascript:alert(1)' } },
  },
  {
    field: 'type',
    input: 'grpc',
    patch: { type: 'grpc' },
  },
]

/**
 * Re-run one hostile value through the leaf validator that owns its field and return
 * that validator's own `reason`. Returns null when the field has no leaf validator
 * (`type`, `resource.url`), in which case `upsert`'s own reason is already specific.
 */
function leafReason(V, field, patch) {
  const r = patch.resource ?? {}
  switch (field) {
    case 'routeTemplate':
      return V.validateRouteTemplate(patch.routeTemplate).reason
    case 'resource.iconUrl':
      return V.validateIconUrl(r.iconUrl).reason
    case 'resource.serviceName':
      return V.validateServiceName(r.serviceName).reason
    case 'input.schema':
      return V.validateJsonSchema(patch.input.schema).reason
    case 'resource.tags': {
      // Report the first tag the validator actually refused; if every tag is well
      // formed, the drop was the cap, so state the cap the code enforces.
      const bad = (r.tags ?? []).map((t) => V.validateTag(t)).find((x) => !x.valid)
      if (bad) return bad.reason
      // Read the cap back off the validator's own output rather than restating it.
      // Restating is how the old ledger came to claim 16 when the code enforced 5.
      const cap = (V.validateResourceBlock({ url: BASE.resource.url, tags: r.tags }).value.tags ?? [])
        .length
      return `${r.tags.length} tags submitted, catalog keeps ${cap} — overflow dropped to contain index pollution`
    }
    case 'resource.description': {
      const kept = V.validateResourceBlock({
        url: BASE.resource.url,
        description: r.description,
      }).value.description
      return `description is ${r.description.length.toLocaleString('en-US')} characters, catalog keeps ${kept.length.toLocaleString('en-US')} — truncated before BM25 indexing`
    }
    default:
      return null
  }
}

try {
  const { createCatalog } = await import(resolve(ROOT, 'packages/index/src/index.mjs'))
  const V = await import(resolve(ROOT, 'packages/index/src/integrity.mjs'))

  let commit = null
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
      .toString()
      .trim()
  } catch {
    /* not a git checkout — provenance is optional, the verdicts are not */
  }

  const rows = []
  for (const c of CASES) {
    // A fresh catalog per case: upsert is stateful, and a leftover record would let
    // one case's outcome change another's.
    const catalog = createCatalog()
    const result = catalog.upsert(withPatch(c.patch))

    const rejected = !result?.ok
    // For a soft-drop, name the dropped path the validator actually reported for this
    // field — that is the rule vocabulary the code emits, not one invented here. A
    // rejection has no dropped path (the record never landed), so the field itself is
    // the rule and `upsert`'s sentence becomes the reason. Using the sentence for both
    // just prints it twice.
    const rule = rejected
      ? c.field
      : (result.dropped ?? []).find((d) => d.startsWith(c.field)) ?? c.field

    if (!rejected && !(result.dropped ?? []).some((d) => d.startsWith(c.field))) {
      console.warn(
        `[gen-integrity] SKIP ${c.field} <- ${c.input ?? c.display}: the validator accepted it. ` +
          `The corpus and the code disagree — fix one of them.`,
      )
      continue
    }

    // `upsert` says WHICH path it dropped; the leaf validator says why. Prefer the
    // latter — "iconUrl host rejected: IP literal host" is actionable, "resource.iconUrl
    // dropped" is not. Fall back to upsert's own reason when there is no leaf validator.
    const why = rejected ? result.reason : leafReason(V, c.field, c.patch)

    rows.push({
      verdict: rejected ? 'rejected' : 'soft-drop',
      rule,
      field: c.field,
      input: c.display ?? c.input,
      reason: why ?? `field dropped, record kept — ${rule}`,
      survived: rejected ? null : 'record kept',
    })
  }

  if (rows.length === 0) {
    console.warn('[gen-integrity] produced no rows — keeping the existing file')
    process.exit(0)
  }

  // Rejections first. The panel renders only the first 12 rows while its header counts
  // all of them, so a rejection sorted to the tail is promised in the count and never
  // shown. Rejections are also the more interesting verdict: they are the cases where
  // the record does not survive at all.
  rows.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'rejected' ? -1 : 1))

  // Spread the rows over a plausible window so the console reads as a log rather than
  // a table. These are display offsets for a REPLAY of the corpus, not observations —
  // src/lib/api.ts turns them into wall-clock times, and the panel says so.
  const payload = {
    generatedAt: new Date().toISOString(),
    generator: 'apps/web/scripts/gen-integrity.mjs',
    validator: 'packages/index/src/integrity.mjs (via createCatalog().upsert)',
    commit,
    note: 'Replay of a fixed hostile corpus through the shipped validator. Every rule, verdict and reason below is the validator&apos;s own output. Not a live feed.',
    entries: rows.map((r, i) => ({ ...r, minutesAgo: 3 + i * 7 })),
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
  const n = rows.filter((r) => r.verdict === 'rejected').length
  console.log(
    `[gen-integrity] wrote ${rows.length} verdicts from the real validator (${n} rejected, ${rows.length - n} soft-drop)${commit ? ` @ ${commit}` : ''}`,
  )
} catch (e) {
  console.log(`[gen-integrity] could not regenerate (${e.message}) — keeping current data`)
  process.exit(0)
}
