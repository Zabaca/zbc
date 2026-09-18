/**
 * `/agentgit-og.png` — the picture the link becomes.
 *
 * The head used to argue for a `summary` card on the grounds that a preview
 * image "has to be a fetchable raster at a stable URL, which means an asset in
 * the Worker bundle and a route serving it, and neither exists yet". This is
 * the route, and `assets/agentgit-og.png` is the asset: a card rendered once,
 * from the mark that is already the favicon, and committed. It is NOT rendered
 * per request — a crawler fetching a picture must not wake the container any
 * more than a reader fetching the page does.
 *
 * Everything the document decides is here, and the bytes are not: the Worker
 * imports the PNG (only `worker/` may reach a bundler), and this module states
 * the path, the methods, the dimensions and the headers. That keeps `shared/`
 * runtime-neutral (docs/adr/0010) and keeps the head's advertised size and the
 * served picture's size one pair of numbers.
 *
 * No collision with a repository, the same argument `/robots.txt` and
 * `/llms.txt` make: smart-HTTP paths are `/<name>.git/…`, so a repository
 * literally called `agentgit-og.png` is reached at `/agentgit-og.png.git/…`
 * and is untouched by this route.
 */

/** The one path. Named for the site rather than `/og.png` so it reads as the
 *  card's picture in a log, a referrer and a README's `<img src>`. */
export const OG_IMAGE_PATH = '/agentgit-og.png'

/** The card size every platform specifies for the large-summary layout. The
 *  head advertises these two numbers and the committed PNG is rendered at
 *  them; a crawler that finds a different size crops it itself. */
export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

export const OG_IMAGE_CONTENT_TYPE = 'image/png'

/**
 * A day, where the page and the manual get a minute.
 *
 * The reason those two are short is that they render this deployment's limits
 * and capabilities, so a stale copy at the edge states a cap the push path no
 * longer has. The picture renders none of that — it is a mark and a wordmark —
 * so nothing in it can outlive a config change, and the crawlers fetching it
 * are exactly the traffic worth absorbing at the edge.
 */
export const OG_IMAGE_CACHE_CONTROL = 'public, max-age=86400'

/** Only GET or HEAD on the one path. Nothing else is this picture. */
export function wantsOgImage(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === OG_IMAGE_PATH
}
