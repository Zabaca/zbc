// Cloudflare has no namespace: an account is one flat bag of resources, and the
// only real namespace primitive (dispatch namespaces) is Workers-for-Platforms
// only. So c9s infers grouping instead.
//
// Workers are the anchor, because a Worker is what a project actually *is* here;
// buckets, databases and containers are named after the Worker they serve
// (`tour-guide` → `tour-guide-cache`, `zbc-inbox` → `zbc-inbox-raw`).

/** `cf:service=foo` if Cloudflare set it. Only Workers carry tags. */
export function taggedService(tags: string[] | null | undefined): string | undefined {
  return tags?.find((t) => t.startsWith('cf:service='))?.slice('cf:service='.length)
}

/**
 * Longest anchor that prefixes `name` at a dash boundary, else the first segment.
 * The boundary check is what stops `campkit` from being claimed by a `camp` anchor.
 */
export function projectOf(name: string, anchors: string[]): string {
  let best = ''
  for (const a of anchors) {
    if (a.length <= best.length) continue
    if (name === a || name.startsWith(`${a}-`)) best = a
  }
  return best || (name.split('-')[0] ?? name)
}
