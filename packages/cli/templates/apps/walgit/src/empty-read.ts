/**
 * What walgit answers a READ of a repository that has no refs.
 *
 * A name comes into existence by being pushed to, so "no refs" is the ordinary
 * state of every free name and of every repository between `git init` and the
 * first push. git's own `upload-pack` does not serve that state well:
 *
 *   $ git -c push.negotiate=true push ../empty.git HEAD:refs/heads/main
 *   fatal: expected 'acknowledgments', received 'packfile'
 *   warning: push negotiation failed; proceeding anyway with push
 *    * [new branch]      HEAD -> main
 *
 * The push lands — that line is the third one — but an agent reading the output
 * treats `fatal:` as a refusal and retries or bails. It is not walgit's bug:
 * the same two lines come out of a plain `git init --bare` over the FILE
 * transport. Push negotiation sends a protocol-v2 `fetch` with `wait-for-done`;
 * round one carries the client's `have`s and is answered `acknowledgments` /
 * `NAK`; the client then sends a second round with no `have` and no `want`
 * left, and `upload-pack` — having nothing to acknowledge — skips the
 * acknowledgments section and opens `packfile`, which is the one thing the
 * client is not prepared to read there.
 *
 * So walgit answers a ref-less read itself. There is nothing to serve from such
 * a repository, which is what makes this safe: every response here is the
 * complete and correct answer for a repository holding no objects and no refs,
 * and the moment a repository holds one ref this module is not consulted again.
 *
 * Every literal below was captured from `git upload-pack` against a real empty
 * bare repository (git 2.43.0) rather than derived from the spec twice.
 */

/** One pkt-line: four hex length bytes, counting themselves, then the payload. */
function pkt(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`
}

/** The flush packet that ends every section. */
const FLUSH = '0000'

/**
 * `acknowledgments` / `NAK` / flush — the round that git dies without.
 *
 * `NAK` and not an ACK because a repository with no refs has nothing in common
 * with anybody: it is the true answer, not a placating one.
 */
const ACKNOWLEDGMENTS = `${pkt('acknowledgments\n')}${pkt('NAK\n')}${FLUSH}`

/**
 * What `ls-refs` reports: no refs, and — when the client asked for it — the
 * unborn HEAD.
 *
 * `refs/heads/main` is not a guess: it is the `--initial-branch` every bare
 * repository here is created with (`cache.ts`), so a clone of a free name
 * checks out the branch a first push would create rather than `master`.
 */
function lsRefs(request: string): string {
  if (!request.includes('unborn')) return FLUSH
  return `${pkt('unborn HEAD symref-target:refs/heads/main\n')}${FLUSH}`
}

/**
 * The v2 capability advertisement.
 *
 * Deliberately a SUBSET of git's: only what this module goes on to implement.
 * Advertising `shallow` or `filter` here would promise a negotiation that ends
 * in a packfile nobody can produce.
 */
const V2_ADVERTISEMENT = [
  pkt('version 2\n'),
  pkt('agent=walgit\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=wait-for-done\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
].join('')

/**
 * The v0 advertisement: the service header, then the zero-oid capabilities
 * line git uses to advertise capabilities when it has no ref to hang them on.
 */
const V0_ADVERTISEMENT = [
  pkt('# service=git-upload-pack\n'),
  FLUSH,
  pkt(
    `${'0'.repeat(40)} capabilities^{}\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed object-format=sha1 agent=walgit\n`,
  ),
  FLUSH,
].join('')

const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result'

function gitResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'content-type': contentType,
      // The same no-store posture git's own CGI takes on these two endpoints: a
      // cached "this name is empty" is a wrong answer the instant it is pushed to.
      'cache-control': 'no-cache, max-age=0, must-revalidate',
      pragma: 'no-cache',
    },
  })
}

/** Does this request speak protocol v2? */
function wantsV2(request: Request): boolean {
  return (request.headers.get('git-protocol') ?? '').includes('version=2')
}

/**
 * The answer for one ref-less read, or `null` when this module has none — in
 * which case the caller serves the request the ordinary way, creating the
 * repository as it always has. `null` is therefore never a refusal, only a
 * hand-back, and every unrecognised shape takes it.
 */
export async function emptyReadResponse(
  request: Request,
  url: URL,
  endpoint: string,
): Promise<Response | null> {
  if (endpoint === 'info/refs') {
    if (request.method !== 'GET') return null
    if (url.searchParams.get('service') !== 'git-upload-pack') return null
    return gitResponse(
      wantsV2(request) ? V2_ADVERTISEMENT : V0_ADVERTISEMENT,
      'application/x-git-upload-pack-advertisement',
    )
  }

  if (endpoint !== 'git-upload-pack' || request.method !== 'POST') return null
  if (!wantsV2(request)) return null

  // Read from a CLONE so that handing back `null` leaves the original request's
  // body intact for `git http-backend`. Only ever a negotiation request for a
  // repository with no refs, so there is no large body to buffer here.
  let body: string
  try {
    body = await request.clone().text()
  } catch {
    return null
  }

  if (body.includes('command=ls-refs')) return gitResponse(lsRefs(body), UPLOAD_PACK_RESULT)
  if (!body.includes('command=fetch')) return null
  // A `want` cannot be honest against a repository with no objects, so a
  // request carrying one is not a shape this module may answer.
  if (/\bwant [0-9a-f]{40}/.test(body)) return null
  return gitResponse(ACKNOWLEDGMENTS, UPLOAD_PACK_RESULT)
}
