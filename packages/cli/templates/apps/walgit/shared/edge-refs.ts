/**
 * The two git requests the edge answers without waking the container.
 *
 * Nearly all of a public deployment's git traffic is agents polling a ref: a
 * protocol-v2 `GET /<name>.git/info/refs?service=git-upload-pack` (no body in,
 * the capability advertisement out), then a `POST /<name>.git/git-upload-pack`
 * carrying `command=ls-refs` (about a hundred bytes in, one ref back). Every one
 * of those reached the one container and kept it awake, and a container that
 * never sleeps is paid for around the clock while a cold one costs the next
 * clone 12–22 s. Neither request needs a git object: the advertisement is a
 * fact about the container's git, and the refs are a fact about the Index.
 *
 * So the edge answers both, from two places, and the split is the design:
 *
 *   - **What git says about itself** — the advertisement's bytes and every
 *     header on both answers — comes from the container's OWN git, which
 *     publishes it to the object store when it boots (`UploadPackRecord`,
 *     written by `src/edge-refs.ts`). Nothing here is typed out from the spec:
 *     a hard-coded advertisement would go on claiming `fetch=shallow` or
 *     `ls-refs=unborn` after an image upgrade changed what the git behind it
 *     can do, and nothing would say so.
 *   - **What the refs are** — from `index.json`, the source of truth. A push is
 *     acknowledged only after the Index's compare-and-swap lands, so the Index
 *     is never behind anything a client could have been told; the container
 *     reconciles its Cache to exactly this map before it serves, and points
 *     `HEAD` at `defaultBranch` of it (`src/materialize.ts`'s `ensureHead`),
 *     which is the one function this file calls for the same answer.
 *
 * Every rule below has the same failure direction: any doubt is `null`, and the
 * request goes to the container exactly as it did before this file existed.
 * The edge never refuses anything here and never answers a shape it has not
 * been shown byte-for-byte equivalent on (`src/edge-refs.test.ts` holds the
 * output against real `git upload-pack`).
 *
 * Pure apart from `refsAtEdge`, whose only I/O is the two store reads it is
 * handed a store for — so the Worker, which bun cannot run, is a thin caller.
 */

import { defaultBranch } from './browse'
import { containerEnv, fingerprintEnv, type ContainerEnvName } from './container-env'
import { uploadPackKey } from './keys'
import { REPO_ID, SMART_HTTP } from './protocol'
import type { ObjectStore } from './store'
import { loadIndex, type WalIndex } from './wal-index'

/** What `info/refs?service=git-upload-pack` answers with. */
export const ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement'

/** What a `git-upload-pack` POST answers with. */
export const RESULT_TYPE = 'application/x-git-upload-pack-result'

/**
 * What a `git-upload-pack` POST must carry. `git http-backend` compares it
 * exactly and answers anything else 415, so the edge does too — by not
 * answering it.
 */
export const REQUEST_TYPE = 'application/x-git-upload-pack-request'

/**
 * The largest `ls-refs` body the edge will buffer to read.
 *
 * Measured requests are 102–175 bytes. A body has to be buffered to be read,
 * and a buffered body has to be re-sent to the container when it turns out to
 * be a `fetch` — so the cap is what keeps a negotiation, and never a pack,
 * from being held in the Worker's memory. A body that declares no length
 * (chunked) declares nothing to check against the cap, and is not read at all.
 */
export const LS_REFS_MAX_BYTES = 4096

// ── What the container's git says about itself ──────────────────────────────

/** One HTTP answer as `git http-backend` gave it, headers in its own order. */
export interface CapturedResponse {
  status: number
  /** Lower-cased names, as the container's runtime relays them. */
  headers: [string, string][]
  body: string
}

/**
 * What a container publishes about its own git, under `uploadPackKeyFor`.
 *
 * Both answers are captured from `git http-backend` itself, against a probe
 * repository provisioned the way every Cache is (`src/edge-refs.ts`), so the
 * headers are http-backend's and not a copy of them. The advertisement does
 * not depend on which repository answers it — it is the server's capabilities,
 * not its refs — which the golden tests check against a repository with refs.
 */
export interface UploadPackRecord {
  version: 1
  /** `git --version` in the image that wrote this, for whoever reads the bucket. */
  git: string
  /** `GET info/refs?service=git-upload-pack` with `Git-Protocol: version=2`. */
  advertisement: CapturedResponse
  /** `command=ls-refs` against the empty probe: only its status and headers are used. */
  lsRefs: CapturedResponse
}

/** A record the edge has checked and may serve from. */
export interface UploadPackFacts {
  advertisement: { headers: [string, string][]; body: string }
  resultHeaders: [string, string][]
  /** Advertised capability → its value, `null` for one advertised bare. */
  capabilities: Map<string, string | null>
}

/**
 * Where the container booted with THIS environment publishes its record, or
 * `null` when the edge must not trust one at all.
 *
 * Keyed by the same fingerprint the Worker replaces the container on
 * (`shared/container-env.ts`): the Worker computes it from the environment it
 * would boot a container with, the container from the environment it booted
 * with, and `reconcileEnv` makes those the same container. So a deploy that
 * changes anything forwarded — the image included, through `WALGIT_BUILD_ID` —
 * reads a key nobody has written yet, falls through, wakes the new container,
 * and that container publishes what ITS git says. A stale advertisement from
 * the previous image is never read, because it is filed under a fingerprint
 * this Worker no longer computes.
 *
 * `null` without `WALGIT_BUILD_ID`, deliberately: without it an image-only
 * deploy keeps the fingerprint (the Durable Object cannot see an image), and an
 * old git's advertisement would be served in front of a new one until the new
 * container happened to boot. With no way to tell images apart, the edge does
 * not answer — which is today's behaviour, not a refusal.
 */
export function uploadPackKeyFor(env: Partial<Record<ContainerEnvName, string>>): string | null {
  const forwarded = containerEnv(env)
  if (!forwarded.WALGIT_BUILD_ID) return null
  return uploadPackKey(fingerprintEnv(forwarded))
}

/** The bytes a container writes for `record`. */
export function serializeUploadPackRecord(record: UploadPackRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`)
}

/**
 * The record, checked — or `null` when the edge should not serve from it.
 *
 * Checked rather than trusted because it is the one input here that came from
 * a process rather than from a push: a probe that hit an error page, a git
 * that answered v0, or an advertisement with no `ls-refs` would otherwise be
 * served to every client as though it were the container's answer.
 */
export function parseUploadPackRecord(bytes: Uint8Array): UploadPackFacts | null {
  let record: UploadPackRecord
  try {
    record = JSON.parse(new TextDecoder().decode(bytes)) as UploadPackRecord
  } catch {
    return null
  }
  if (record?.version !== 1) return null
  const advertisement = captured(record.advertisement, ADVERTISEMENT_TYPE)
  const lsRefs = captured(record.lsRefs, RESULT_TYPE)
  if (!advertisement || !lsRefs) return null
  // The empty probe's `ls-refs` is a bare flush. Anything else means the POST
  // did not reach `ls-refs` at all, and its headers are not the ones to copy.
  if (lsRefs.body !== FLUSH) return null

  const pkts = readPkts(new TextEncoder().encode(advertisement.body))
  if (!pkts || pkts.length < 2) return null
  // `version 2` first and a flush last, with nothing after it: the shape git
  // gives a v2 client, and NOT the `# service=` preamble a v0 one is sent.
  const [first, ...rest] = pkts
  if (first?.kind !== 'data' || ascii(first.payload) !== 'version 2\n') return null
  if (rest.pop()?.kind !== 'flush') return null
  const capabilities = new Map<string, string | null>()
  for (const p of rest) {
    if (p.kind !== 'data') return null
    const line = ascii(p.payload)
    if (line === null || !line.endsWith('\n')) return null
    const text = line.slice(0, -1)
    const eq = text.indexOf('=')
    capabilities.set(eq === -1 ? text : text.slice(0, eq), eq === -1 ? null : text.slice(eq + 1))
  }
  // The command this file answers must be one the container's git has, and
  // the oids in the Index are SHA-1: a git advertising another object format
  // would be refusing every line rendered below.
  if (!capabilities.has('ls-refs')) return null
  const format = capabilities.get('object-format')
  if (format !== undefined && format !== 'sha1') return null

  return {
    advertisement: { headers: advertisement.headers, body: advertisement.body },
    resultHeaders: lsRefs.headers,
    capabilities,
  }
}

function captured(value: CapturedResponse | undefined, type: string): CapturedResponse | null {
  if (!value || value.status !== 200 || typeof value.body !== 'string') return null
  if (!Array.isArray(value.headers)) return null
  const pairs: [string, string][] = []
  for (const pair of value.headers) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      return null
    }
    pairs.push([pair[0].toLowerCase(), pair[1]])
  }
  if (pairs.find(([name]) => name === 'content-type')?.[1] !== type) return null
  return { status: 200, headers: pairs, body: value.body }
}

// ── pkt-lines ───────────────────────────────────────────────────────────────

type Pkt = { kind: 'data'; payload: Uint8Array } | { kind: 'flush' | 'delim' | 'response-end' }

/** The flush packet that ends every section. */
const FLUSH = '0000'

/**
 * Every pkt-line in `bytes`, or `null` when they do not frame exactly.
 *
 * Four hex length bytes counting themselves, then the payload; `0000`, `0001`
 * and `0002` are the three special packets. A length git would die on (`0003`,
 * a packet running past the end) and an empty data packet are both `null`:
 * the container's git would refuse those requests, and the edge answering one
 * would be the edge disagreeing with it.
 */
function readPkts(bytes: Uint8Array): Pkt[] | null {
  const out: Pkt[] = []
  let at = 0
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null
    const head = String.fromCharCode(...bytes.subarray(at, at + 4))
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null
    const length = parseInt(head, 16)
    at += 4
    if (length === 0) out.push({ kind: 'flush' })
    else if (length === 1) out.push({ kind: 'delim' })
    else if (length === 2) out.push({ kind: 'response-end' })
    else if (length <= 4 || at + length - 4 > bytes.length) return null
    else {
      out.push({ kind: 'data', payload: bytes.subarray(at, at + length - 4) })
      at += length - 4
    }
  }
  return out
}

/**
 * The payload as text, or `null` when it holds anything but printable ASCII and
 * newlines.
 *
 * Nothing in either request legitimately carries more, and git reads these
 * payloads as C strings: a NUL would end a `ref-prefix` early on its side and
 * not on this one.
 */
function ascii(payload: Uint8Array): string | null {
  for (const byte of payload) if ((byte < 0x20 || byte > 0x7e) && byte !== 0x0a) return null
  return String.fromCharCode(...payload)
}

/** One line, framed. Only ever handed ASCII, so a character is a byte. */
function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`
}

/** git strips exactly one trailing newline from a pkt-line it reads as text. */
function chomp(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line
}

// ── The request ─────────────────────────────────────────────────────────────

/** Which of the two requests this is, and the repository it names. */
export interface EdgeRefsRoute {
  kind: 'advertise' | 'ls-refs'
  repo: string
}

/**
 * Does this client speak protocol v2, as the container's git would read the
 * header?
 *
 * Not `includes('version=2')`. git splits `GIT_PROTOCOL` on `:`, takes the
 * highest of the `version=` items it recognises, and recognises exactly `0`,
 * `1` and `2` — so `version=20` and `version=02` are a v0 client to it, and a
 * v0 client is sent the `# service=` preamble this file never renders.
 */
export function speaksV2(header: string | null): boolean {
  if (header === null) return false
  let version = 0
  for (const item of header.split(':')) {
    const value = item.startsWith('version=') ? item.slice('version='.length) : null
    if (value === '0' || value === '1' || value === '2') version = Math.max(version, Number(value))
  }
  return version === 2
}

/**
 * The request, if it is one the edge may try to answer — decided from the
 * method, URL and headers alone, before a byte of the body is read.
 *
 * `null` is "forward it", for everything else: a push or its advertisement, a
 * v0/v1 client, a `HEAD` (no git client sends one), a POST whose body is
 * compressed (git gzips the large ones) or too large to inspect, or one with
 * no length to check.
 */
export function edgeRefsRoute(request: Request): EdgeRefsRoute | null {
  const url = new URL(request.url)
  const route = SMART_HTTP.exec(url.pathname)
  if (!route) return null
  // The container strips one `.git` and the URL grammar another, so
  // `/alpha.git.git` is the repository `alpha` there. Left to it rather than
  // re-derived here, exactly as `absentAtEdge` does in the Worker.
  const repo = route[1]!
  if (repo.endsWith('.git') || !REPO_ID.test(repo)) return null
  if (!speaksV2(request.headers.get('git-protocol'))) return null

  if (route[2] === 'info/refs') {
    if (request.method !== 'GET') return null
    const service = url.searchParams.getAll('service')
    if (service.length !== 1 || service[0] !== 'git-upload-pack') return null
    return { kind: 'advertise', repo }
  }

  if (route[2] !== 'git-upload-pack' || request.method !== 'POST') return null
  if (request.headers.get('content-type') !== REQUEST_TYPE) return null
  // Any encoding at all, including one http-backend would pass through: the
  // only bytes the edge reads are the ones it was not asked to decode.
  if ((request.headers.get('content-encoding') ?? '') !== '') return null
  const declared = request.headers.get('content-length') ?? ''
  if (!/^\d+$/.test(declared)) return null
  const length = Number(declared)
  if (length === 0 || length > LS_REFS_MAX_BYTES) return null
  return { kind: 'ls-refs', repo }
}

/** What one `ls-refs` asked for. */
export interface LsRefsRequest {
  symrefs: boolean
  peel: boolean
  unborn: boolean
  /** `ref-prefix` arguments; empty means every ref. */
  prefixes: string[]
}

/** The first packet of an `ls-refs` request, as git's client writes it. */
const LS_REFS_COMMAND = 'command=ls-refs'

/**
 * Is this body an `ls-refs` at all? Cheap, and asked before anything is read
 * from the store, so a `fetch` — the clone itself — costs the edge no read.
 */
export function isLsRefs(body: Uint8Array): boolean {
  const pkts = readPkts(body)
  const first = pkts?.[0]
  return first?.kind === 'data' && chomp(ascii(first.payload) ?? '') === LS_REFS_COMMAND
}

/**
 * One `ls-refs` request, read the way the container's git reads it — or `null`
 * for anything it would read differently, refuse, or that this file does not
 * render.
 *
 * The shape is fixed: the command, the capabilities the client sends with it,
 * a delimiter, the arguments, a flush, and nothing after. A capability is
 * accepted only if the container's git ADVERTISED it, because that git dies on
 * one it did not (`unknown capability`), and only the three that change nothing
 * about the answer: `agent`, `session-id`, and `object-format` naming the
 * format advertised. A `server-option` falls through. So does any argument
 * besides the four `ls-refs` defines.
 */
export function parseLsRefsRequest(
  body: Uint8Array,
  capabilities: Map<string, string | null>,
): LsRefsRequest | null {
  const pkts = readPkts(body)
  // The command, the delimiter and the flush at the least; and the flush last,
  // with nothing after it, because a stateless request is exactly one command.
  if (!pkts || pkts.length < 3 || pkts.pop()?.kind !== 'flush') return null
  const delim = pkts.findIndex((p) => p.kind === 'delim')
  if (delim === -1) return null
  // Every other packet is a line of text with at most its trailing newline.
  const text = (p: Pkt): string | null => {
    if (p.kind !== 'data') return null
    const line = ascii(p.payload)
    if (line === null) return null
    const chomped = chomp(line)
    return chomped.includes('\n') ? null : chomped
  }
  const head = pkts.slice(0, delim).map(text)
  const args = pkts.slice(delim + 1).map(text)
  if (head.includes(null) || args.includes(null)) return null
  if (head[0] !== LS_REFS_COMMAND) return null

  for (const line of head.slice(1) as string[]) {
    const eq = line.indexOf('=')
    const key = eq === -1 ? line : line.slice(0, eq)
    if (!capabilities.has(key)) return null
    if (key === 'agent' || key === 'session-id') continue
    if (key === 'object-format' && line.slice(eq + 1) === capabilities.get(key)) continue
    return null
  }

  const request: LsRefsRequest = { symrefs: false, peel: false, unborn: false, prefixes: [] }
  for (const line of args as string[]) {
    if (line === 'symrefs') request.symrefs = true
    else if (line === 'peel') request.peel = true
    else if (line === 'unborn') request.unborn = true
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length))
    else return null
  }
  return request
}

// ── The answers ─────────────────────────────────────────────────────────────

/** A response the edge may send, before it is a `Response`. */
export interface EdgeAnswer {
  status: number
  headers: [string, string][]
  body: string
}

/** A full ref name the edge can render as git would, sort as git would, and frame as one byte per character. */
const RENDERABLE_REF = /^refs\/[\x21-\x7e]+$/
const SHA1 = /^[0-9a-f]{40}$/

/**
 * Would the container serve this Index's refs through `git http-backend`?
 *
 * Three ways it would not, and each is the container's own decision to make:
 *
 *   - **No Index** — a name nobody has pushed to. The container's empty-read
 *     path answers it (`src/empty-read.ts`), with an advertisement of its own.
 *   - **No refs** — the same path, for a repository that exists and holds none.
 *   - **A Reader List** — the Private gate (`src/http.ts`'s `refuseRead`) asks
 *     for a signature before it serves anything. ANY `readers` field, even `[]`
 *     and even on a deployment whose container would not gate it: whether to
 *     challenge is the container's question, and an edge that answered a name
 *     the container would have challenged has published the name's refs.
 */
function servedByBackend(index: WalIndex | null): index is WalIndex {
  if (!index) return false
  if (Object.keys(index.refs).length === 0) return false
  if (index.claim?.readers !== undefined) return false
  return true
}

/** The advertisement, verbatim — or `null` when the container would answer otherwise. */
export function answerAdvertisement(
  facts: UploadPackFacts,
  index: WalIndex | null,
): EdgeAnswer | null {
  if (!servedByBackend(index)) return null
  return { status: 200, headers: facts.advertisement.headers, body: facts.advertisement.body }
}

/**
 * The `ls-refs` lines for these refs, as git renders them — or `null` for any
 * set of refs this cannot render exactly.
 *
 * `HEAD` first, then every ref in byte order, filtered by `ref-prefix` (a ref
 * is listed when its name starts with any one of them; `HEAD` is tested as the
 * string `HEAD`). Each line is `<oid> <name>`, with ` symref-target:<ref>` on
 * `HEAD` when `symrefs` was asked — the refs themselves are never symbolic, as
 * the Cache writes them all into `packed-refs` (`src/reconcile.ts`).
 *
 * Three refusals, each because the right answer needs something the Index does
 * not hold:
 *
 *   - **No branch.** `HEAD` is then unborn, and what git says about an unborn
 *     `HEAD` depends on which branch `git init` left it on.
 *   - **`peel` with a listed ref outside `refs/heads/`.** Peeling needs to know
 *     whether a ref names a tag object, and the Index holds oids, not types.
 *     A branch is safe — git refuses to point `refs/heads/` at anything but a
 *     commit — and `HEAD` points at a branch. The polling `ls-remote` asks for
 *     `peel` on every request, so this is narrow on purpose: a repository with
 *     tags falls through, one with only branches does not.
 *   - **A ref name or oid outside what is rendered here** — anything not
 *     printable ASCII, which is where JavaScript's sort and git's byte order
 *     could part, and where one character stops being one framed byte.
 */
export function renderLsRefs(refs: Record<string, string>, request: LsRefsRequest): string | null {
  const head = defaultBranch(refs)
  if (head === null) return null
  const names = Object.keys(refs)
  for (const name of names) {
    if (!RENDERABLE_REF.test(name) || !SHA1.test(refs[name]!)) return null
  }
  const listed = (name: string) =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix))

  // `sort` on the fresh array rather than `toSorted`, for the Workers lib (see
  // `defaultBranch`). Every name is ASCII here, so UTF-16 order is byte order.
  const shown = names.filter(listed).sort()
  if (request.peel && shown.some((name) => !name.startsWith('refs/heads/'))) return null

  const lines: string[] = []
  if (listed('HEAD')) {
    lines.push(`${refs[head]} HEAD${request.symrefs ? ` symref-target:${head}` : ''}\n`)
  }
  for (const name of shown) lines.push(`${refs[name]} ${name}\n`)
  return `${lines.map(pkt).join('')}${FLUSH}`
}

/** The `ls-refs` answer for this Index — or `null` when the container would answer otherwise. */
export function answerLsRefs(
  facts: UploadPackFacts,
  index: WalIndex | null,
  request: LsRefsRequest,
): EdgeAnswer | null {
  if (!servedByBackend(index)) return null
  const body = renderLsRefs(index.refs, request)
  if (body === null) return null
  return { status: 200, headers: facts.resultHeaders, body }
}

// ── The one function with I/O ───────────────────────────────────────────────

/** What `refsAtEdge` decided. */
export type EdgeRefsOutcome =
  /** Answered: send this, and the container was never asked. */
  | { response: Response; route: EdgeRefsRoute; bytes: number }
  /**
   * Not answered: forward THIS request. It is the original unless its body was
   * read to be inspected, in which case it is a new request carrying exactly
   * the bytes that arrived — a body stream is read once, and the container
   * must still receive what the client sent.
   */
  | { response: null; request: Request }

export interface EdgeRefsDeps {
  /** `caps.publicAccess`. A token-gated container answers 401 first, and the edge must not get ahead of it. */
  publicAccess: boolean
  store: ObjectStore | null
  /** `uploadPackKeyFor(env)`. */
  recordKey: string | null
}

/**
 * Answer one of the two polling requests at the edge, or hand it back.
 *
 * The order is the cost model: every check that needs no I/O runs first, a
 * body is read only for a POST small enough to hold, and the store is asked
 * only once the body has said `ls-refs` — so a `fetch`, which is the clone
 * itself, is forwarded having cost the edge nothing but a copy of a few hundred
 * bytes. The record and the Index are then read together, and any failure to
 * read either is a fall-through rather than an error: the container is always
 * there to answer.
 */
export async function refsAtEdge(request: Request, deps: EdgeRefsDeps): Promise<EdgeRefsOutcome> {
  const pass = (forward: Request = request): EdgeRefsOutcome => ({
    response: null,
    request: forward,
  })
  if (!deps.publicAccess || !deps.store || !deps.recordKey) return pass()
  const route = edgeRefsRoute(request)
  if (!route) return pass()

  let body: Uint8Array | null = null
  let forward = request
  if (route.kind === 'ls-refs') {
    try {
      body = new Uint8Array(await request.arrayBuffer())
    } catch {
      // The client went away mid-body. There is nothing left to forward — the
      // stream is spent — and nobody left to answer, so say so plainly rather
      // than throw out of the Worker with no telemetry row.
      return {
        response: new Response('walgit: request body unreadable\n', { status: 400 }),
        route,
        bytes: 0,
      }
    }
    // Rebuilt from parts rather than `new Request(request, { body })`: the
    // original's body is spent, and whether a runtime accepts a spent request
    // as the template is not a thing to find out in production.
    forward = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body.slice().buffer as ArrayBuffer,
    })
    const declared = Number(request.headers.get('content-length'))
    if (body.byteLength !== declared || !isLsRefs(body)) return pass(forward)
  }

  let facts: UploadPackFacts | null
  let index: WalIndex | null
  try {
    const [record, loaded] = await Promise.all([
      deps.store.get(deps.recordKey),
      loadIndex(deps.store, route.repo),
    ])
    facts = record ? parseUploadPackRecord(record.body) : null
    // `loadIndex` answers an absent Index with an empty one; the etag is what
    // tells the two apart, and they are different answers here.
    index = loaded.etag === null ? null : loaded.index
  } catch {
    return pass(forward)
  }
  if (!facts) return pass(forward)

  let answer: EdgeAnswer | null
  if (route.kind === 'advertise') {
    answer = answerAdvertisement(facts, index)
  } else {
    const asked = parseLsRefsRequest(body!, facts.capabilities)
    answer = asked ? answerLsRefs(facts, index, asked) : null
  }
  if (!answer) return pass(forward)

  const bytes = new TextEncoder().encode(answer.body)
  return {
    response: new Response(bytes, { status: answer.status, headers: answer.headers }),
    route,
    bytes: bytes.byteLength,
  }
}
