// The old addresses of the Conversations tab, and where each lands now (Conversations was split into Inbox and Meet).
//
// `/conversations`, `/conversations/<key>` and `/conversations/draft/<id>` were linked from bookmarks, tapped notifications, Today's rows, outside tools' draft links, the drafting skill, meet's
// nudge emails and meet's old /start page. THIS REDIRECT IS KEPT PERMANENTLY, not for a migration cycle: the old addresses sit in mail already sent, in notifications and in bookmarks, and none
// of them will be made again. (A bare /conversations from an old nudge email, which was about direct messages, lands on /inbox: the bare list was the Inbox's, and nothing tells the two apart.) Every one is answered with a redirect to the same thing under its new tab, with its query kept, so none of them breaks. A person's key (an address, or
// `mail:<contact>`) and a draft are the Inbox's; a channel, a call, the Phone and a person only meet knows (`chat:<id>`) are Meet's. Pure, so a table can check it.

/** The tab a conversation key lives in now: the Phone, a call, a channel and a meet-only person are Meet's; everything else is a person's email. */
export const tabOfKey = (key: string): 'inbox' | 'meet' => (key === 'phone' || key.startsWith('call:') || key.startsWith('chat:') ? 'meet' : 'inbox')

const OLD = '/conversations'

/** Whether a path is the old tab's or under it (case is not significant to Access, so it is not here either). */
export const isLegacyPath = (pathname: string): boolean => {
  const p = pathname.toLowerCase()
  return p === OLD || p.startsWith(`${OLD}/`)
}

/**
 * Where an old path lands: the new path with the same query. The list was the Inbox's unless it asked for the Calls view, which is Meet's now (`?view=calls`, with the view
 * kept). Anything under it that is not a draft or one segment is the Inbox's list, so a malformed address never lands on a page that is not there.
 */
export function legacyTarget(pathname: string, search: string): string {
  const rest = pathname.slice(OLD.length).replace(/^\/+|\/+$/g, '')
  const segments = rest === '' ? [] : rest.split('/')
  if (segments.length === 0) return new URLSearchParams(search).get('view') === 'calls' ? `/meet${search}` : `/inbox${search}`
  if (segments.length === 2 && segments[0]?.toLowerCase() === 'draft') return `/inbox/draft/${segments[1]}${search}`
  if (segments.length === 1) {
    let key: string
    try {
      key = decodeURIComponent(segments[0] as string)
    } catch {
      return `/inbox${search}`
    }
    return `/${tabOfKey(key)}/${segments[0]}${search}`
  }
  return `/inbox${search}`
}
