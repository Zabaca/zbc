/**
 * Browsing a repository: the rules both halves obey, and the two pages.
 *
 * The container answers `/_walgit/browse` (`src/http.ts`) because a tree is
 * read from git objects and only the Cache holds those — the Index carries the
 * full ref state and not one commit, so unlike the repository list this cannot
 * be answered at the edge off the log. What IS shared is everything around that
 * read: which ref a URL names, where a ref ends and a path begins, which branch
 * is the default, and what the answer looks like as a page.
 *
 * ── the ref rules live here, not in the URL ─────────────────────────────────
 *
 * A branch name may contain slashes, so `/<name>/tree/feature/x/src` says
 * nothing about where the ref ends. The Index is the only thing that knows, so
 * the split is LONGEST-PREFIX against the refs it holds (`splitRefPath`), and
 * the endpoint takes the remainder whole. A ref is an Index key or a full oid
 * and nothing else: not a `HEAD`, not a rev-parse expression, not `main^{}`.
 * That is a security property as much as a product one — whatever is accepted
 * here reaches `git ls-tree` as an operand.
 *
 * ── the default branch comes from the Index ─────────────────────────────────
 *
 * `main`, else `master`, else the first branch by name. Never the Cache's
 * `HEAD`: the Cache is disposable and a freshly Materialized one has whatever
 * `init` left behind, which is a different answer on a cold node than on a warm
 * one for the same repository (ADR-0007).
 *
 * ── a value, not a Response ─────────────────────────────────────────────────
 *
 * Like `shared/repo-list.ts`: this module states the status, the headers and the
 * body, the Worker owns the `Response`, and `shared/` imports no runtime
 * (ADR-0010). The one thing it cannot do for itself is reach the container, so
 * that arrives as `ask` — which is also what lets the e2e suite drive the very
 * same renderer against a real node.
 */

import type { Capabilities } from './capabilities'
import { escapeHtml, describeHours } from './landing'
import { REPOS_PATH, type BrowseKind, type BrowseRoute } from './protocol'
import type { EdgeResponse } from './repo-list'
import { WEB_STYLE, webCacheControl } from './web'

/** A full object id, as git writes one. The one ref spelling that is not a ref. */
export const OID = /^[0-9a-f]{40}$/

/** One entry in a tree, as one level of `ls-tree` reports it. */
export interface TreeEntry {
  name: string
  /**
   * What it is, in the four kinds a browser has to render differently. git's
   * own vocabulary is `blob`/`tree`/`commit` plus a mode, and a reader cannot
   * see a mode — so a symlink and a gitlink are kinds here rather than
   * footnotes on `blob` and `commit`.
   */
  kind: 'tree' | 'blob' | 'symlink' | 'submodule'
  oid: string
  /** Bytes, for a blob. `null` for everything git does not weigh. */
  size: number | null
  /** A symlink's target, and nothing else's. */
  target?: string
}

/** One ref, as the Index holds it. Full names only: `main` is not a ref. */
export interface BrowseRef {
  name: string
  oid: string
}

/** What `op=refs` answers: the repository, without touching the Cache. */
export interface BrowseRefsAnswer {
  repo: string
  /** The full ref name, or `null` for a repository holding no branch. */
  defaultBranch: string | null
  refs: BrowseRef[]
  /** ISO instant of the newest push entry, or `null` when there is none. */
  lastPush: string | null
}

/** What `op=tree` answers: the same, plus one level of one directory. */
export interface BrowseTreeAnswer extends BrowseRefsAnswer {
  /** The ref this tree was read at — a full ref name, or an oid. */
  ref: string
  /** The directory, with no leading or trailing slash. `''` is the root. */
  path: string
  entries: TreeEntry[]
  /** The README this directory holds, at the root only. */
  readme?: Readme
}

/**
 * How much of a file walgit will put on a page: 1 MiB.
 *
 * The cap is asked of `cat-file -s` BEFORE the content is read, so a file above
 * it never reaches the container's memory — this is a bound on work done in the
 * one process that is also serving pushes, not just on bytes shipped. Above it
 * the page offers the raw link and nothing else, and raw has no cap of its own:
 * a download is what a file too big to render is for.
 */
export const BLOB_MAX_BYTES = 1024 * 1024

/** What `op=blob` answers: the repository, and one file at one ref. */
export interface BrowseBlobAnswer extends BrowseRefsAnswer {
  ref: string
  /** The file, with no leading slash. Never `''` — a blob has a name. */
  path: string
  /** Bytes, as git weighs the object. Always known, even when the text is not. */
  size: number
  /**
   * The content, or `null` when there is deliberately none: a file over
   * `BLOB_MAX_BYTES` (never read) or one holding a NUL byte (read, and not
   * something a page can show). Both offer the raw link instead.
   */
  text: string | null
  binary: boolean
  oversize: boolean
}

/** A README under a tree, shown as text and never rendered as markup. */
export interface Readme {
  name: string
  text: string
}

/** One commit, as the history page shows one. */
export interface Commit {
  oid: string
  /** `Name <email>`, as git records it. */
  author: string
  /** ISO 8601, from git's `%aI`. */
  date: string
  subject: string
}

/** What `op=log` answers: one page of history, and where the next begins. */
export interface BrowseLogAnswer extends BrowseRefsAnswer {
  ref: string
  commits: Commit[]
  /**
   * The oid the next page starts at, or `null` at the end of the history.
   *
   * The LAST commit on this page rather than the one after it: the cursor is a
   * commit walgit has named, so a next page is built from what the reader was
   * shown rather than from an object nobody has seen.
   */
  next: string | null
}

/**
 * The README a directory listing holds, by the fixed preference order.
 *
 * `README`, then `README.md`, then `README.txt`, case-insensitively — the names
 * GitHub made a convention, and only those three. A repository holding two of
 * them gets the first by THIS order rather than by tree order, so the same
 * repository shows the same file wherever it is read.
 */
export function readmeEntry(entries: TreeEntry[]): TreeEntry | null {
  for (const wanted of ['readme', 'readme.md', 'readme.txt']) {
    const found = entries.find(
      (entry) => entry.kind === 'blob' && entry.name.toLowerCase() === wanted,
    )
    if (found) return found
  }
  return null
}

/**
 * The default branch, from the Index.
 *
 * `main`, else `master`, else the first branch by name — and only ever a
 * BRANCH: a repository holding nothing but tags and `refs/walgit/*` has no
 * default, which is `null` rather than a tag pretending to be one.
 */
export function defaultBranch(refs: Record<string, string>): string | null {
  // `sort` on the array `filter` just made, not `toSorted`: `shared/` is
  // compiled against the Workers runtime's lib as well as bun's, and that one
  // is below es2023.
  const branches = Object.keys(refs)
    .filter((name) => name.startsWith('refs/heads/'))
    .sort()
  if (branches.includes('refs/heads/main')) return 'refs/heads/main'
  if (branches.includes('refs/heads/master')) return 'refs/heads/master'
  return branches[0] ?? null
}

/**
 * The full ref name a reader's spelling means, or `null`.
 *
 * An Index key, with `refs/heads/` or `refs/tags/` allowed to be left off —
 * which is what makes `main` and `v1` work in a URL — or a full oid, which is
 * returned verbatim because there is no ref to name it by.
 */
export function resolveRef(refs: Record<string, string>, requested: string): string | null {
  if (requested === '') return null
  if (OID.test(requested)) return requested
  for (const candidate of [requested, `refs/heads/${requested}`, `refs/tags/${requested}`]) {
    if (refs[candidate] !== undefined) return candidate
  }
  return null
}

/** Where a ref ends and a path begins, in one run-together URL remainder. */
export interface RefPath {
  /** A full ref name, or an oid. */
  ref: string
  path: string
}

/**
 * Split `feature/x/src/lib` into the ref that resolves and the path that is
 * left, LONGEST prefix first.
 *
 * Longest rather than shortest because a repository may hold both `feature/x`
 * and `feature/x/deeper`, and the deeper one is the ref the URL names when it
 * is there. `null` when no prefix resolves, which is a 404 and never a guess.
 */
export function splitRefPath(refs: Record<string, string>, rest: string): RefPath | null {
  const segments = rest.split('/').filter((segment) => segment !== '')
  for (let take = segments.length; take > 0; take--) {
    const ref = resolveRef(refs, segments.slice(0, take).join('/'))
    if (ref !== null) return { ref, path: segments.slice(take).join('/') }
  }
  return null
}

/**
 * The path a reader asked for, cleaned — or `null` when it is one walgit will
 * not carry.
 *
 * `..` is refused rather than resolved: a path here is DATA about a git tree
 * and `..` means nothing inside one, so the only reason to send it is to find
 * out what this code does with it. A segment beginning `-` is refused for the
 * reason `src/git.ts` fences operands at all — git reads an argument starting
 * with `-` as an option wherever one is allowed, and defence in depth is what
 * keeps that a fact about two layers rather than one.
 */
export function cleanPath(raw: string): string | null {
  const segments = raw.split('/').filter((segment) => segment !== '')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return null
    if (segment.startsWith('-')) return null
  }
  return segments.join('/')
}

// ── The edge ────────────────────────────────────────────────────────────────

/** The container's answer to one browse query, as the edge sees it. */
export interface ContainerAnswer {
  status: number
  /** The body, verbatim: JSON when the container answered, text when it refused. */
  text: string
  /** `content-type`, so a refusal is passed through as what it is. */
  contentType: string
  /** The container stamped it (`SERVED_HEADER`) — not something in front of it. */
  served: boolean
  /** What kind of refusal the container named (`REJECT_HEADER`), or `''`. */
  reject: string
  /** The refusal's own headers that a client must see — the two challenges. */
  challenges: string[]
}

export interface BrowseDeps {
  /** Ask the container. The query is the whole `?…` string. */
  ask: (query: string) => Promise<ContainerAnswer>
  /** What this deployment offers — the cache rule and the window read from it. */
  caps: Capabilities
  /** The clock the retention line is measured on, injectable for a test. */
  now?: () => number
}

/**
 * What the Worker knows about the request, and nothing about its runtime.
 *
 * The verb is deliberately absent: `wantsBrowse` has already settled that this
 * is a GET or a HEAD, and the difference between them is dropping the body,
 * which is the Worker's job because a body is a runtime thing.
 */
export interface BrowseRequest {
  /** The `Accept` header, verbatim. HTML for a browser, anything else is JSON. */
  accept: string
  /**
   * The history cursor from the URL's query, or `null`.
   *
   * The one thing a browse URL carries outside its path. Passed through rather
   * than validated here: a cursor is a fact about git's history, so the
   * container is where it is judged (and refused).
   */
  before: string | null
}

/** A browse answered, plus what the container said about answering it. */
export interface BrowseEdgeResponse extends EdgeResponse {
  upstream: Pick<ContainerAnswer, 'status' | 'served' | 'reject'>
}

/**
 * One browse page, as a status, headers and a body.
 *
 * The container is asked exactly once — `op=tree` carries the ref list too, so
 * the page that shows both is one round trip rather than two — and a refusal is
 * passed through verbatim, challenges included, because a 401 a browser cannot
 * answer is a page nobody can open.
 */
export async function browseResponse(
  route: BrowseRoute,
  request: BrowseRequest,
  deps: BrowseDeps,
): Promise<BrowseEdgeResponse> {
  // One `op` per page kind, and the remainder passed whole — only the Index
  // knows where the ref ends. `raw` never arrives here: it is bytes rather than
  // a page, so the Worker streams it from the container instead (`worker/`).
  const op = route.kind === 'commits' ? 'log' : route.kind
  const query =
    `?repo=${encodeURIComponent(route.repo)}&op=${op}` +
    (route.rest === '' ? '' : `&ref=${encodeURIComponent(route.rest)}`) +
    (request.before === null ? '' : `&before=${encodeURIComponent(request.before)}`)
  const answer = await deps.ask(query)
  const upstream = { status: answer.status, served: answer.served, reject: answer.reject }

  const wantsHtml = request.accept.toLowerCase().includes('text/html')

  if (answer.status >= 400) {
    // Verbatim, and that includes the two `WWW-Authenticate` lines a Private
    // repository is refused with: the browse gate IS the clone gate
    // (ADR-0013), and rewriting the refusal here would be a second one.
    const headers: Record<string, string> = {
      'content-type': answer.contentType || 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    }
    if (answer.challenges.length > 0) headers['www-authenticate'] = answer.challenges.join(', ')
    return { status: answer.status, headers, body: answer.text, upstream }
  }

  if (!wantsHtml) {
    return {
      status: answer.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': webCacheControl(deps.caps),
        'x-robots-tag': 'noindex',
      },
      body: answer.text,
      upstream,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(answer.text)
  } catch {
    // The container answered 200 with something this page cannot render. A 502
    // rather than a broken page, and counted as the edge refusal it is.
    return {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      body: 'walgit: the browse answer could not be read\n',
      upstream,
    }
  }

  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': webCacheControl(deps.caps),
      // A repository page is not one anyone should reach from a search engine,
      // and on a credentialed deployment it is not one a crawler can read at
      // all. Stated in the header as well as the document, exactly as the list
      // states it, because a crawler that fetched it before reading the markup
      // has already been told.
      'x-robots-tag': 'noindex',
      // There is no script on this page and no resource to load: nothing may
      // load, nothing may connect, nothing may post.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
        "base-uri 'none'; form-action 'none'",
    },
    body:
      route.kind === 'blob'
        ? renderBlob(parsed as BrowseBlobAnswer, deps.caps, deps.now?.())
        : route.kind === 'commits'
          ? renderLog(parsed as BrowseLogAnswer, deps.caps, deps.now?.())
          : renderBrowse(parsed as BrowseTreeAnswer, deps.caps, deps.now?.()),
    upstream,
  }
}

// ── The page ────────────────────────────────────────────────────────────────

/**
 * What is left of the window, in the landing page's own words.
 *
 * `describeHours` and the same arithmetic the sweeper runs on the same fact —
 * hours since the last push — so a page cannot promise a repository a lifetime
 * the sweeper does not honour. Rounded UP, because "expires in 0 hours" on a
 * repository that has 50 minutes left reads as gone.
 */
export function expiresIn(lastPush: string | null, caps: Capabilities, now: number): string | null {
  if (caps.retentionHours === null || lastPush === null) return null
  const at = Date.parse(lastPush)
  if (!Number.isFinite(at)) return null
  const left = Math.ceil((at + caps.retentionHours * 3_600_000 - now) / 3_600_000)
  return left <= 0 ? 'expires at any moment' : `expires in ${describeHours(left)}`
}

/** A directory's parent path, or `null` at the root. */
function parentOf(path: string): string | null {
  if (path === '') return null
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * `/<name>/tree/<ref>/<path>`, encoded for a URL and then escaped for an
 * attribute.
 *
 * BOTH, and in that order. Escaping alone is the bug this had: a branch or a
 * file may legally contain `#`, `?` or `%`, and each of those ends or rewrites
 * a URL rather than a markup attribute — a link to a file called `a#b` would
 * quietly resolve to a different path. Each SEGMENT is encoded separately so
 * the slashes that make the path a path survive, which is also why a ref and a
 * path arrive here already split.
 */
function browseHref(repo: string, kind: BrowseKind, ref: string, path: string): string {
  const parts = [repo, kind, ...ref.split('/'), ...path.split('/').filter((p) => p !== '')]
  return escapeHtml(`/${parts.map((part) => encodeURIComponent(part)).join('/')}`)
}

/** `/<name>/tree/<ref>/<path>` — the shape every directory link takes. */
function treeHref(repo: string, ref: string, path: string): string {
  return browseHref(repo, 'tree', ref, path)
}

/** `/<name>`, encoded and escaped for the same reason `treeHref` is. */
function repoHref(repo: string): string {
  return escapeHtml(`/${encodeURIComponent(repo)}`)
}

/** How a ref is SHOWN: `refs/heads/` dropped, everything else kept whole. */
export function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

function entryRow(repo: string, ref: string, path: string, entry: TreeEntry): string {
  const name = escapeHtml(entry.name)
  const here = path === '' ? entry.name : `${path}/${entry.name}`
  // A directory and a file each link to their own page; a symlink and a
  // submodule do not, because neither names something this repository holds at
  // that path — a link to one would be a 404 found by clicking.
  const shown =
    entry.kind === 'tree'
      ? `<a href="${treeHref(repo, ref, here)}">${name}/</a>`
      : entry.kind === 'blob'
        ? `<a href="${browseHref(repo, 'blob', ref, here)}">${name}</a>`
        : name
  const note =
    entry.kind === 'symlink'
      ? `<span class="tag">→ ${escapeHtml(entry.target ?? '')}</span>`
      : entry.kind === 'submodule'
        ? `<span class="tag">submodule @ ${escapeHtml(entry.oid.slice(0, 8))}</span>`
        : ''
  return `      <tr>
        <td class="n">${shown} ${note}</td>
        <td class="f">${entry.size === null ? '' : entry.size}</td>
      </tr>`
}

/** What every page's chrome needs: the repository, the ref and the ref list. */
type PageCommon = Pick<BrowseRefsAnswer, 'repo' | 'refs' | 'lastPush'> & { ref?: string }

function refList(answer: PageCommon): string {
  if (answer.refs.length === 0) return ''
  const links = answer.refs.map((ref) => {
    const current = ref.name === answer.ref ? ' class="here"' : ''
    return `<a href="${treeHref(answer.repo, shortRef(ref.name), '')}"${current}>${escapeHtml(
      shortRef(ref.name),
    )}</a>`
  })
  return `    <nav class="refs">${links.join(' ')}</nav>\n`
}

function breadcrumb(answer: PageCommon & { path?: string }): string {
  const ref = shortRef(answer.ref ?? '')
  const crumbs = [
    `<a href="${repoHref(answer.repo)}">${escapeHtml(answer.repo)}</a>`,
    `<span class="at">at ${escapeHtml(ref)}</span>`,
  ]
  let walked = ''
  const segments = (answer.path ?? '').split('/').filter((s) => s !== '')
  for (const segment of segments) {
    walked = walked === '' ? segment : `${walked}/${segment}`
    crumbs.push(`<a href="${treeHref(answer.repo, ref, walked)}">${escapeHtml(segment)}</a>`)
  }
  return crumbs.join(' <span class="sep">/</span> ')
}

/**
 * The retention line every page carries, in the landing page's own words.
 */
function fineprint(answer: PageCommon, caps: Capabilities, now: number): string {
  const expiry = expiresIn(answer.lastPush, caps, now)
  return [
    answer.lastPush === null ? '' : `last push ${escapeHtml(answer.lastPush.slice(0, 10))}`,
    expiry === null ? '' : escapeHtml(expiry),
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/**
 * The document every browse page is, around whatever that page shows.
 *
 * No framework, no build step, no script and no request beyond the document
 * itself — one inline stylesheet, which is all the CSP permits. Four pages
 * share it because they are one product a reader clicks through, and four
 * copies of a `<head>` is four places a token rename has to land.
 */
function shell(title: string, heading: string, body: string, footer: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
${WEB_STYLE}
  .refs { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1rem; }
  .refs .here { text-decoration: underline; }
  .sep, .at { color: var(--muted); }
  .tag { border: 0; padding: 0; }
  .file, .readme { overflow-x: auto; }
  .file td.ln { text-align: right; color: var(--muted); user-select: none; width: 1%;
    white-space: nowrap; }
  .file td { border: 0; padding: 0 .5rem; }
  .file pre, .readme pre { margin: 0; white-space: pre; font: inherit; }
  .readme { border: 1px solid color-mix(in srgb, var(--muted) 30%, transparent);
    border-radius: 3px; padding: .75rem; margin-top: 1.5rem; }
  .readme h2 { font-size: .85rem; font-weight: 600; color: var(--muted); margin: 0 0 .5rem; }
  .log td.w { white-space: nowrap; color: var(--muted); }
</style>
</head>
<body>
<main>
    <h1>${heading}</h1>
${body}    <p class="note">${footer}</p>
</main>
</body>
</html>
`
}

/** Where every page points back to: the deployment, and what walgit is. */
function footerLinks(fine: string, extra = ''): string {
  return `${fine}${fine === '' ? '' : ' · '}${extra}<a href="${REPOS_PATH}">all repositories</a> · <a href="/">what this is</a>`
}

/**
 * The tree page, as a string.
 *
 * The repository page and a directory page are the same document: a directory
 * is the root one with a path, and giving them two renderers would be two
 * places a ref link has to be spelled.
 */
export function renderBrowse(
  answer: BrowseTreeAnswer,
  caps: Capabilities,
  now = Date.now(),
): string {
  const parent = parentOf(answer.path)
  const rows =
    answer.entries.length === 0
      ? '    <p class="note">Nothing here.</p>\n'
      : `    <table>
      <thead><tr><th>name</th><th class="f">size</th></tr></thead>
      <tbody>
${answer.entries.map((entry) => entryRow(answer.repo, shortRef(answer.ref), answer.path, entry)).join('\n')}
      </tbody>
    </table>
`
  const up =
    parent === null
      ? ''
      : `    <p class="note"><a href="${treeHref(
          answer.repo,
          shortRef(answer.ref),
          parent,
        )}">..</a></p>\n`

  const empty =
    answer.refs.length === 0
      ? '    <p class="note">No refs yet. The first push creates one.</p>\n'
      : ''

  // The README, as TEXT. There is no markdown renderer here and no sanitiser
  // walgit owns, and the one thing a repository page must never do is turn
  // bytes somebody pushed into markup on walgit's own origin.
  const readme =
    answer.readme === undefined
      ? ''
      : `    <section class="readme"><h2>${escapeHtml(
          answer.readme.name,
        )}</h2><pre>${escapeHtml(answer.readme.text)}</pre></section>\n`

  // History is reachable from the tree rather than only from a URL someone
  // knows to type — but only where there IS a ref to walk.
  const history =
    answer.ref === ''
      ? ''
      : `<a href="${browseHref(answer.repo, 'commits', shortRef(answer.ref), '')}">history</a> · `

  return shell(
    answer.repo,
    breadcrumb(answer),
    `${refList(answer)}${empty}${up}${rows}${readme}`,
    footerLinks(fineprint(answer, caps, now), history),
  )
}

/**
 * The file page: the bytes, escaped, one numbered row per line.
 *
 * A table rather than a `<pre>` with numbers in it, because a line number a
 * reader can select is a line number they paste into a message by accident.
 * Three files never show content: one over `BLOB_MAX_BYTES` (never read), one
 * holding a NUL byte, and — implicitly — one the container refused. Each offers
 * the raw link instead, which is the same read without a page around it.
 */
export function renderBlob(answer: BrowseBlobAnswer, caps: Capabilities, now = Date.now()): string {
  const ref = shortRef(answer.ref)
  const raw = browseHref(answer.repo, 'raw', ref, answer.path)
  const rawLink = `<a href="${raw}">raw</a>`

  let body: string
  if (answer.oversize) {
    body = `    <p class="note">${answer.size} bytes — too large to show. ${rawLink}</p>\n`
  } else if (answer.binary) {
    body = `    <p class="note">${answer.size} bytes of binary. ${rawLink}</p>\n`
  } else {
    // A trailing newline ends the last line rather than starting an empty one,
    // which is what every editor shows and what `wc -l` counts.
    const text = answer.text ?? ''
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
    const rows = lines
      .map(
        (line, i) =>
          `        <tr><td class="ln">${i + 1}</td><td><pre>${escapeHtml(line)}</pre></td></tr>`,
      )
      .join('\n')
    body = `    <table class="file">
      <tbody>
${rows}
      </tbody>
    </table>
`
  }

  const fine = fineprint(answer, caps, now)
  const shown = answer.oversize || answer.binary ? '' : `${answer.size} bytes · ${rawLink} · `
  return shell(`${answer.path} · ${answer.repo}`, fileCrumb(answer), body, footerLinks(fine, shown))
}

/**
 * A file's breadcrumb: the repository, the ref, each directory above it as a
 * link, and the file itself as plain text — it is the page you are on.
 */
function fileCrumb(answer: BrowseBlobAnswer): string {
  const ref = shortRef(answer.ref)
  const segments = answer.path.split('/').filter((segment) => segment !== '')
  const file = segments.pop() ?? ''
  const crumbs = [
    `<a href="${repoHref(answer.repo)}">${escapeHtml(answer.repo)}</a>`,
    `<span class="at">at ${escapeHtml(ref)}</span>`,
  ]
  let walked = ''
  for (const segment of segments) {
    walked = walked === '' ? segment : `${walked}/${segment}`
    crumbs.push(`<a href="${treeHref(answer.repo, ref, walked)}">${escapeHtml(segment)}</a>`)
  }
  crumbs.push(escapeHtml(file))
  return crumbs.join(' <span class="sep">/</span> ')
}

/**
 * The history page: one page of commits, and a link to the next.
 *
 * The date is shown as the day rather than the instant: a history is read for
 * its order, and a full ISO timestamp per row is noise in a column a reader
 * scans. The full value stays in the answer for anyone reading the JSON.
 */
export function renderLog(answer: BrowseLogAnswer, caps: Capabilities, now = Date.now()): string {
  const ref = shortRef(answer.ref)
  const rows = answer.commits
    .map(
      (commit) => `      <tr>
        <td class="w">${escapeHtml(commit.oid.slice(0, 8))}</td>
        <td>${escapeHtml(commit.subject)}</td>
        <td class="w">${escapeHtml(commit.author)}</td>
        <td class="w">${escapeHtml(commit.date.slice(0, 10))}</td>
      </tr>`,
    )
    .join('\n')
  const table =
    answer.commits.length === 0
      ? '    <p class="note">No history here yet.</p>\n'
      : `    <table class="log">
      <thead><tr><th>commit</th><th>subject</th><th>author</th><th>date</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
`
  // The next page, as a link the reader can follow — the cursor is the last
  // commit THIS page showed, and the container drops it from the next one.
  const next =
    answer.next === null
      ? ''
      : `    <p class="note"><a href="${browseHref(
          answer.repo,
          'commits',
          ref,
          '',
        )}?before=${escapeHtml(encodeURIComponent(answer.next))}">older</a></p>\n`

  const heading = [
    `<a href="${repoHref(answer.repo)}">${escapeHtml(answer.repo)}</a>`,
    `<span class="at">history of ${escapeHtml(ref === '' ? 'nothing' : ref)}</span>`,
  ].join(' <span class="sep">/</span> ')

  return shell(
    `history · ${answer.repo}`,
    heading,
    `${refList(answer)}${table}${next}`,
    footerLinks(fineprint(answer, caps, now)),
  )
}
