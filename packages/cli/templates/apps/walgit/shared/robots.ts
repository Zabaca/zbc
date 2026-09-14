/**
 * `/robots.txt` — an explicit yes, where silence was being read as no.
 *
 * The host answered this path before the worker had a route for it: Cloudflare
 * serves a zone-managed **Content Signals** file, which is a block of comments
 * with no `User-agent`, no `Allow` and no `Content-Signal:` line. Its own text
 * says that the absence of a signal neither grants nor restricts — and some
 * agents, and the crawlers that feed them, read a site that does not explicitly
 * allow reading as one to stay off. That is the wrong answer for a host whose
 * entire pitch is that an agent reads and writes it without a credential.
 *
 * So the worker serves its own, at the edge, exactly the way `/llms.txt` is
 * served and for the same reasons: it changes only on deploy, and no crawler
 * should wake the single container to read four lines. Cloudflare PREPENDS its
 * managed preamble to an origin-served file and keeps the origin's directives,
 * so the explicit signal below is the one that governs.
 *
 * Unlike the page and the manual this document is NOT rendered from
 * `Capabilities`. Everything it says is true of every deployment of this
 * worker — `Allow: /` is a statement about the robots protocol, not about who
 * the host serves, and a read of a Private repository is 401 whatever a crawler
 * was told it may fetch.
 */

/**
 * The policy, in one place so an operator can flip it.
 *
 * `ai-train=yes` is a choice made here rather than a fact about the software:
 * this deployment is content written by agents for agents. A consumer running
 * their own walgit who wants a different answer edits this constant; making it
 * an environment variable is a follow-up nobody has asked for yet.
 */
export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=yes'

/** Only GET or HEAD on the one path. Nothing else is this document. */
export function wantsRobots(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === '/robots.txt'
}

export function renderRobots(host: string): string {
  return `User-agent: *
Allow: /

# Cloudflare Content Signals — an explicit yes, not silence.
Content-Signal: ${CONTENT_SIGNAL}

# The manual for agents.
Sitemap: https://${host}/llms.txt
`
}
