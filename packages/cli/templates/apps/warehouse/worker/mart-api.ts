// The edge mart-read route (ADR-0004, CONTEXT.md "Data Warehouse"): serves a mart by name,
// reading its parquet IN THE WORKER via hyparquet — no container wake for reads. Ported from
// cedarpad's ADR-0017 mart-api.ts, but simpler: this app has no guest/canvas concept, so
// there's no `decideMartAccess` to layer on top — every caller past the bearer-token gate
// (checked one layer up, in worker/index.ts, not here) may read any mart.

// Imported from the browser entry, NOT `hyparquet/src/node.js` — the node entry pulls in
// `node:fs`, which is exactly the node-builtin touch the edge Worker must avoid (this
// package's compatibility_flags includes nodejs_compat, but there's no reason to rely on it
// here).
import { parquetReadObjects } from 'hyparquet/src/index.js'

import {
  coerceMartRow,
  MartName,
  MartSidecarSchema,
  type MartRow,
  type MartSidecar,
} from '../shared/mart-contract'
import { martKey, martSidecarKey } from '../shared/r2-keys'

/** Minimal structural shape of a Cloudflare R2 binding's `get` — narrower than the full
 * R2Bucket SDK type, only the one read this route needs. Structurally compatible with the
 * real binding, and lets tests pass a plain in-memory object. */
export interface MartBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
}

/** Wrap whole-file bytes as the AsyncBuffer hyparquet wants. Marts are small — no range
 * logic needed. */
function toAsyncBuffer(bytes: Uint8Array): {
  byteLength: number
  slice(start: number, end?: number): Promise<ArrayBuffer>
} {
  return {
    byteLength: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end).buffer),
  }
}

/** Read one mart's rows + sidecar from R2, coerced JSON-safe (mart-contract.ts's
 * `coerceMartRow`: INT64 arrives as BigInt, TIMESTAMP as Date — neither survives
 * JSON.stringify raw). `null` when either the parquet or its sidecar is missing — a mart
 * isn't a mart without its declared schema, so a partial write reads as absent. */
export async function readMart(
  bucket: MartBucket,
  name: string,
): Promise<{ sidecar: MartSidecar; rows: MartRow[] } | null> {
  const [parquetObj, sidecarObj] = await Promise.all([
    bucket.get(martKey(name)),
    bucket.get(martSidecarKey(name)),
  ])
  if (parquetObj === null || sidecarObj === null) return null

  const sidecarJson = JSON.parse(new TextDecoder().decode(await sidecarObj.arrayBuffer()))
  const sidecar = MartSidecarSchema.parse(sidecarJson)

  // A sidecar stored under `marts/foo.schema.json` that calls itself "bar" would be served
  // as foo, handing the caller a contract for a different mart. Cheap invariant, and the
  // only thing tying the storage key to the document's own claim about itself.
  if (sidecar.name !== name) {
    throw new Error(`mart "${name}" has a sidecar declaring a different name ("${sidecar.name}")`)
  }

  const parquetBytes = new Uint8Array(await parquetObj.arrayBuffer())
  const raw = await parquetReadObjects({ file: toAsyncBuffer(parquetBytes) })
  const rows = raw.map((row: Record<string, unknown>) => coerceMartRow(row))

  // The sidecar's rowCount is the writer's claim; rows.length is the data. They disagree
  // exactly when a publish was interrupted between the two uploads (see
  // container/materialize.ts's retire-then-write ordering) or when something wrote R2 out
  // of band. Treating that as unreadable is what keeps "the sidecar describes THIS parquet"
  // true for a reader, rather than merely intended by the writer.
  if (sidecar.rowCount !== rows.length) {
    throw new Error(
      `mart "${name}" sidecar declares ${sidecar.rowCount} rows but its parquet holds ${rows.length}`,
    )
  }

  return { sidecar, rows }
}

const NOT_FOUND = () =>
  Response.json({ error: 'not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })

/** The full route: reject a malformed name (`MartName`, mart-contract.ts) with 404 BEFORE
 * ever building a storage key — an unvalidated name must never reach
 * `martKey`/`martSidecarKey`, and a malformed name must be indistinguishable from a
 * real-but-missing one (no enumeration oracle). Every caller reaching this function has
 * already cleared the bearer-token gate one layer up and may read any mart.
 *
 * Every failure mode inside `readMart` — a truncated sidecar (JSON.parse), a sidecar that
 * no longer satisfies the contract (MartSidecarSchema.parse), a torn parquet
 * (parquetReadObjects), an unsupported column type (coerceMartRow), or either of the two
 * consistency checks above — is caught here. Uncaught, they escape to workerd's default
 * handler as a bare non-JSON 500, breaking this API's own content-type contract for every
 * client and logging nothing that names the mart. A mart that cannot be read as promised is
 * reported as absent, consistent with "a mart is not a mart without its declared schema",
 * and the reason is logged for the operator rather than returned to the caller. */
export async function handleMartRead(bucket: MartBucket, name: string): Promise<Response> {
  if (!MartName.safeParse(name).success) return NOT_FOUND()
  try {
    const mart = await readMart(bucket, name)
    if (mart === null) return NOT_FOUND()
    return Response.json(mart, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    console.error(`mart read failed for "${name}": ${String(err)}`)
    return NOT_FOUND()
  }
}
