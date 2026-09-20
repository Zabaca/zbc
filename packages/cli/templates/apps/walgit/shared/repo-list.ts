/**
 * `/repos` — what this deployment holds, answered at the edge.
 *
 * The whole point of the placement is the same one the landing page makes: the
 * container serves git, and somebody clicking around a browser should not wake
 * it, queue behind a clone, or count against the one instance serving pushes.
 * Everything this page shows is already in the log — `index.json` carries the
 * full ref state, the entry list and the Claim (`shared/wal-index.ts`) — so the
 * list is a fold over objects the edge can read for itself.
 *
 * ── it is a capability, so it is default off ────────────────────────────────
 *
 * `caps.web` (`shared/capabilities.ts`) is the one switch, read once like every
 * other Advertised capability, and the route does not exist without it. A list
 * of names is the one thing a credentialed deployment has not already been
 * asked to publish: the credential still gates this route, but *enumerating*
 * names is a surface an operator opts into rather than acquires on upgrade.
 *
 * ── a value, not a Response ─────────────────────────────────────────────────
 *
 * Like `shared/robots.ts` and `shared/favicon.ts`: this module states the
 * status, the headers and the body, and the Worker owns the `Response`. That is
 * what keeps `shared/`'s one rule (docs/adr/0010) — no runtime here — and what
 * lets the gate, the negotiation, the cache headers and every row be driven
 * from `src/repo-list.test.ts` with no Workers runtime and no socket.
 *
 * ── the gate is the one that already exists ─────────────────────────────────
 *
 * `authorizedBy` (`shared/credentials.ts`), the same function the event socket
 * is gated on and the same credential a clone presents. A second copy of the
 * check would be a second policy the first time either was edited. It is
 * answered BEFORE the store is touched, so a stranger cannot make a credentialed
 * deployment read its own bucket.
 *
 * ── no name the log holds is ever omitted ───────────────────────────────────
 *
 * An Index that cannot be read renders as the bare name with no facts, never as
 * a skipped row. A missing repository is the one failure a reader cannot detect
 * and the one that would send somebody looking for a name they can see is gone
 * — and the asymmetry `src/usage.ts` already names holds here: naming a
 * repository we know nothing about costs a line, hiding one costs trust.
 */

import type { Capabilities } from './capabilities'
import { authorizedBy } from './credentials'
import { indexKey, listRepoIds } from './keys'
import { escapeHtml } from './landing'
import { pooled } from './pooled'
import { shortBytes } from './policy'
import { BASIC_CHALLENGE, REPOS_PATH } from './protocol'
import type { ObjectStore } from './store'
import { WEB_STYLE, webCacheControl } from './web'
import type { WalIndex } from './wal-index'

/** Rows on one page. A hundred names is a screenful to scroll, not to load. */
export const REPO_LIST_PAGE_SIZE = 100

/**
 * How many names this view will read Indexes for in order to sort by recency.
 *
 * One delimited LIST names every repository cheaply (`listRepoIds`); reading
 * `index.json` for each of them does not scale the same way, and sorting by
 * last push requires all of them. So past this many names the view stops
 * claiming recency: the order stays the one the store gave (name order), only
 * the requested page's Indexes are read, and the page says so. A thousand is
 * also one R2 listing page, which is what makes the cheap path exactly one
 * round trip.
 */
export const REPO_LIST_MAX_FACTS = 1000

/** Indexes read at once. Enough to hide latency, few enough to not be a burst. */
export const REPO_LIST_CONCURRENCY = 16

/** What the Worker knows about the request, and nothing about its runtime. */
export interface RepoListRequest {
  method: string
  /** The `Accept` header, verbatim. HTML for a browser, anything else is JSON. */
  accept: string
  /** The `Authorization` header, or `null`. */
  authorization: string | null
  /** The query string, e.g. `?page=2`. Absent reads as the first page. */
  search?: string
}

export interface RepoListDeps {
  store: ObjectStore
  /** What this deployment offers — the gate reads `publicAccess` from it. */
  caps: Capabilities
  /** The configured credentials (`parseTokens`). */
  tokens: readonly string[]
}

/** A response as a value: the Worker turns this into a `Response`. */
export interface EdgeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** One repository, as the list shows it. `null` means the Index did not say. */
export interface RepoRow {
  name: string
  /** ISO instant of the newest push entry, or `null` when there is none. */
  lastPush: string | null
  refs: number | null
  /** Bytes a restore would download — entries above the compaction frontier. */
  liveBytes: number | null
  /** It holds a Signer List, so a stranger's push is refused (docs/adr/0012). */
  claimed: boolean
  /** It holds a Reader List, so a stranger's read is refused (docs/adr/0013). */
  private: boolean
  /** Scheduled for deletion and inside its grace period. */
  deletionPending: boolean
  /** Present only when the Index could not be read, which is what it means. */
  unreadable?: true
}

/** Only GET or HEAD on the one path. A POST to it is not this document. */
export function wantsRepoList(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === REPOS_PATH
}

/**
 * The list, as a status, headers and a body.
 *
 * `HEAD` is answered with the same headers as the `GET` it precedes — the
 * Worker drops the body, the way it does for every other edge route.
 */
export async function repoListResponse(
  request: RepoListRequest,
  deps: RepoListDeps,
): Promise<EdgeResponse> {
  const { caps, store, tokens } = deps

  // Before the store is touched. A refusal must not be the reason a bucket is
  // read, and must never be cached: the next request carries a credential.
  if (!caps.publicAccess && !authorizedBy(request.authorization, tokens)) {
    return {
      status: 401,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // The challenge git is refused with, so one credential answers the
        // clone and the browse (`shared/protocol.ts`).
        'www-authenticate': BASIC_CHALLENGE,
        'cache-control': 'no-store',
      },
      body: 'unauthorized\n',
    }
  }

  const page = requestedPage(request.search)
  const listing = await collectRepoList(store, page)

  // A minute, and only where a read takes no credential — the same reasoning
  // the landing page's header carries, plus the one this page adds: a shared
  // cache must not hold a document that exists because THIS request presented
  // a token. One function for both web-view pages (`shared/web.ts`).
  const cacheControl = webCacheControl(caps)

  const wantsHtml = request.accept.toLowerCase().includes('text/html')
  if (!wantsHtml) {
    return {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': cacheControl,
        'x-robots-tag': 'noindex',
      },
      body: `${JSON.stringify(listing, null, 2)}\n`,
    }
  }

  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
      // A list of names is not a page anyone should reach from a search
      // engine, and on a credentialed deployment it is not one a crawler can
      // read at all. Stated in the header as well as the document, because a
      // crawler that fetched it before reading the markup has already been
      // told.
      'x-robots-tag': 'noindex',
      // The filter below is the only script and there is no other resource:
      // nothing may load, nothing may connect, nothing may post.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "img-src data:; base-uri 'none'; form-action 'none'",
    },
    body: renderRepoList(listing),
  }
}

/** What one request asked for, and what the log answered. */
export interface RepoListing {
  repos: RepoRow[]
  /** 1-based, clamped into range. */
  page: number
  pages: number
  /** Every name the log holds, not just this page. */
  total: number
  /**
   * What the order means. `push` is last push descending; `name` is the store's
   * own order, which is what this view falls back to past
   * `REPO_LIST_MAX_FACTS` names.
   */
  sortedBy: 'push' | 'name'
}

/**
 * Read the log into one page of rows.
 *
 * Two paths, and the fork is the count of names rather than a configuration:
 * up to `REPO_LIST_MAX_FACTS` every Index is read, so the page can be sorted by
 * recency; past it only the page being rendered is read and the order stays the
 * store's.
 *
 * What is NOT bounded is the name listing itself: `listRepoIds` pages through
 * the store until it has every name, which on a bucket holding fifty thousand
 * repositories is fifty delimited LISTs rather than one. That is deliberate,
 * and it is the cheaper half by a wide margin — a listing page names a thousand
 * repositories, where the Index reads it feeds cost one GET each. Capping it
 * would mean either paginating no further than the cap (so a name the log holds
 * would have no page it appears on) or renumbering pages per request; the rule
 * this view is held to is that no name is ever omitted, so the listing runs to
 * the end.
 */
export async function collectRepoList(store: ObjectStore, page: number): Promise<RepoListing> {
  // One delimited LIST where the store can roll up prefixes, and a derived
  // listing where it cannot (`shared/keys.ts`).
  const names = await listRepoIds(store)
  const pages = Math.max(1, Math.ceil(names.length / REPO_LIST_PAGE_SIZE))
  const current = Math.min(Math.max(page, 1), pages)

  if (names.length > REPO_LIST_MAX_FACTS) {
    const slice = names.slice((current - 1) * REPO_LIST_PAGE_SIZE, current * REPO_LIST_PAGE_SIZE)
    return {
      repos: await pooled(slice, REPO_LIST_CONCURRENCY, (name) => rowFor(store, name)),
      page: current,
      pages,
      total: names.length,
      sortedBy: 'name',
    }
  }

  const rows = await pooled(names, REPO_LIST_CONCURRENCY, (name) => rowFor(store, name))
  // Newest push first, and a name with no push entry — a ref-only push appends
  // none — sorts after every name that has one rather than to the top, which is
  // where an empty string would put it.
  rows.sort((a, b) => {
    if (a.lastPush === b.lastPush) return a.name < b.name ? -1 : 1
    if (a.lastPush === null) return 1
    if (b.lastPush === null) return -1
    return a.lastPush < b.lastPush ? 1 : -1
  })
  return {
    repos: rows.slice((current - 1) * REPO_LIST_PAGE_SIZE, current * REPO_LIST_PAGE_SIZE),
    page: current,
    pages,
    total: names.length,
    sortedBy: 'push',
  }
}

/**
 * One row, or the bare name.
 *
 * Every failure is the same row: absent, unparseable, the wrong version, or an
 * index declaring a different `repo_id` (which is a routing fault, and serving
 * its facts under this name would hide one). Nothing here throws — a single
 * unreadable object must not be able to take the page down.
 */
async function rowFor(store: ObjectStore, name: string): Promise<RepoRow> {
  try {
    const found = await store.get(indexKey(name))
    if (!found) return bare(name)
    const index = JSON.parse(new TextDecoder().decode(found.body)) as WalIndex
    if (index.version !== 1 || index.repo_id !== name) return bare(name)
    return foldIndex(name, index)
  } catch {
    return bare(name)
  }
}

const bare = (name: string): RepoRow => ({
  name,
  lastPush: null,
  refs: null,
  liveBytes: null,
  claimed: false,
  private: false,
  deletionPending: false,
  unreadable: true,
})

/**
 * The three numbers this page shows, folded out of one Index.
 *
 * `src/usage.ts`'s `usageOfIndex` folds the same object into fourteen fields
 * for the operator's report, and is deliberately not reused: it lives on the
 * container side (it is reached through the CLI), and `shared/` may not import
 * `src/`. What is duplicated is the two lines that define live bytes and last
 * push, held to exactly the three fields a row shows.
 */
function foldIndex(name: string, index: WalIndex): RepoRow {
  let liveBytes = 0
  for (const entry of index.entries) {
    // What a restore actually downloads. Entries at or below the frontier have
    // been superseded by a compaction and are storage waiting on `walgit gc`.
    if (entry.seq > index.compaction_frontier) liveBytes += entry.size
  }
  return {
    name,
    lastPush: lastPushOf(index),
    refs: Object.keys(index.refs ?? {}).length,
    liveBytes,
    // A Claim IS the Signer List, so its presence is what makes the name
    // refuse a stranger's push. A Reader List is a field inside it, and its
    // presence — `[]` included — is what makes the name Private.
    claimed: index.claim !== undefined,
    private: index.claim?.readers !== undefined,
    deletionPending: index.deletion !== undefined,
  }
}

/**
 * When this repository last took a push, or `null` when it has taken none.
 *
 * A COMPACTION entry is not a push: a repack is storage, not traffic, and
 * counting one would make a quiet repository look busy on the day it was
 * compacted — and, where a retention window is set, would silently extend its
 * life on the page that states it (`shared/browse.ts` renders the same fact as
 * "expires in N hours", and the sweeper measures the same one).
 *
 * Exported because the browse reads it too, and two folds of one field are how
 * a page and a sweeper come to disagree about when a repository dies.
 */
export function lastPushOf(index: WalIndex): string | null {
  let lastPush: string | null = null
  for (const entry of index.entries) {
    if (entry.kind !== 'push') continue
    if (lastPush === null || entry.ts > lastPush) lastPush = entry.ts
  }
  return lastPush
}

/** The page number the query string asked for. Anything else is the first. */
function requestedPage(search: string | undefined): number {
  const raw = new URLSearchParams(search ?? '').get('page')
  const page = Number(raw)
  return Number.isInteger(page) && page > 0 ? page : 1
}

// ── The page ────────────────────────────────────────────────────────────────

/**
 * A name arrives here as bytes from a bucket rather than as a path the
 * smart-HTTP grammar checked, so it is escaped rather than trusted — with the
 * landing page's own escaper (`shared/landing.ts`), because two of those is two
 * chances for one of them to miss a character. The page also carries a CSP that
 * would refuse a script even if this were wrong.
 *
 * Bytes are `shortBytes` (`shared/policy.ts`), derived from the one
 * `describeBytes` a refusal prints: a size in this table and the cap
 * `pre-receive` refuses on must not look like two different numbers.
 */

/** An instant, as a date. The page is a directory, not a clock. */
function shortDate(iso: string): string {
  const at = Date.parse(iso)
  // An unparseable timestamp is shown verbatim rather than as `Invalid Date`:
  // it came out of the log, and inventing a reading of it would be worse than
  // printing what is there.
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : iso
}

function row(repo: RepoRow): string {
  const tags = [
    repo.private ? '<span class="tag">Private</span>' : '',
    // Both, where both hold: a Reader List lives INSIDE the Claim
    // (`shared/wal-index.ts`), so a Private name is a claimed name, and a row
    // that showed only the second fact would be dropping the first.
    repo.claimed ? '<span class="tag">claimed</span>' : '',
    repo.deletionPending ? '<span class="tag leaving">being removed</span>' : '',
  ]
    .filter((tag) => tag !== '')
    .join(' ')
  const name = escapeHtml(repo.name)
  return `      <tr${repo.deletionPending ? ' class="leaving"' : ''} data-name="${name}">
        <td class="n"><a href="/${name}">${name}</a> ${tags}</td>
        <td class="f">${repo.lastPush === null ? '—' : shortDate(repo.lastPush)}</td>
        <td class="f">${repo.refs === null ? '—' : repo.refs}</td>
        <td class="f">${repo.liveBytes === null ? '—' : shortBytes(repo.liveBytes)}</td>
      </tr>`
}

function pager(listing: RepoListing): string {
  if (listing.pages < 2) return ''
  const links = [
    listing.page > 1 ? `<a href="${REPOS_PATH}?page=${listing.page - 1}">← newer</a>` : '',
    `<span>page ${listing.page} of ${listing.pages}</span>`,
    listing.page < listing.pages
      ? `<a href="${REPOS_PATH}?page=${listing.page + 1}">older →</a>`
      : '',
  ].filter((link) => link !== '')
  return `    <nav class="pager">${links.join(' ')}</nav>\n`
}

/**
 * The page, as a string.
 *
 * No framework, no build step and no request beyond the document itself: one
 * inline stylesheet, and one inline script whose entire job is to hide rows
 * that do not match what was typed. The table is complete and sorted before
 * any script runs, so a reader with no JavaScript loses the filter and nothing
 * else.
 */
export function renderRepoList(listing: RepoListing): string {
  const notice =
    listing.sortedBy === 'name'
      ? `    <p class="note">${listing.total} repositories — more than this view reads state for, so they are in name order rather than by last push.</p>\n`
      : ''

  const table =
    listing.repos.length === 0
      ? '    <p class="note">No repositories yet. The first push creates one.</p>\n'
      : `    <table>
      <thead><tr><th>name</th><th class="f">last push</th><th class="f">refs</th><th class="f">size</th></tr></thead>
      <tbody id="rows">
${listing.repos.map(row).join('\n')}
      </tbody>
    </table>
`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>repositories</title>
<style>
${WEB_STYLE}
  input { width: 100%; box-sizing: border-box; padding: .5rem .6rem; margin-bottom: 1rem;
    color: inherit; background: transparent; border: 1px solid var(--muted); border-radius: 4px; font: inherit; }
  tr.leaving { opacity: .5; }
  .tag.leaving { color: var(--accent); border-color: var(--accent); }
  .pager { margin-top: 1rem; display: flex; gap: 1rem; color: var(--muted); }
</style>
</head>
<body>
<main>
    <h1>repositories <span class="note">(${listing.total})</span></h1>
    <input id="filter" type="search" placeholder="filter by name" autocomplete="off" aria-label="filter by name">
${notice}${table}${pager(listing)}    <p class="note"><a href="/">what this is</a> · <a href="/llms.txt">the manual</a></p>
</main>
<script>
  // The filter, and nothing else. The rows are already in the document, so a
  // reader with no JavaScript keeps the whole list — only this convenience is
  // lost. It filters the page it has: paging is a link, not a fetch.
  (function () {
    var input = document.getElementById("filter");
    var rows = document.getElementById("rows");
    if (!input || !rows) return;
    input.addEventListener("input", function () {
      var needle = input.value.trim().toLowerCase();
      Array.prototype.forEach.call(rows.rows, function (tr) {
        var name = (tr.getAttribute("data-name") || "").toLowerCase();
        tr.hidden = needle !== "" && name.indexOf(needle) === -1;
      });
    });
  })();
</script>
</body>
</html>
`
}
