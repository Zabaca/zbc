// The booking page: `/book/<name>` is a link's page and `/book/manage/<secret>` a booking's own. Nothing else is served here (the Worker answers any other path under /book/ with a 404), so anything else is a notice and no more.
import { LinkPage, Notice } from './LinkPage'
import { ManagePage } from './ManagePage'

/**
 * The names no link can have (the open path's own folders): the same list as the calendar's (`BOOKING_RESERVED_SLUGS`, held equal to it by test/booking-page-time.test.ts), written here again because the page's bundle takes nothing of the workspace package but types.
 */
export const RESERVED = ['api', '_', 'manage', 'm'] as const

/** Which page a path is: a booking's own, a link's, or neither. */
export function routeOf(pathname: string): { kind: 'manage'; secret: string } | { kind: 'link'; slug: string } | { kind: 'none' } {
  const parts = pathname.split('/').filter((p) => p !== '')
  if (parts[0] !== 'book') return { kind: 'none' }
  try {
    if (parts.length === 3 && parts[1] === 'manage') return { kind: 'manage', secret: decodeURIComponent(parts[2] as string) }
    if (parts.length === 2 && !(RESERVED as readonly string[]).includes(parts[1] as string)) return { kind: 'link', slug: decodeURIComponent(parts[1] as string) }
  } catch {
    // An address that is not valid text is no page.
  }
  return { kind: 'none' }
}

export function App({ pathname }: { pathname: string }) {
  const route = routeOf(pathname)
  return (
    <main className="shell">
      {route.kind === 'manage' ? <ManagePage secret={route.secret} /> : route.kind === 'link' ? <LinkPage slug={route.slug} /> : <Notice title="There is nothing here" text="Check the address you were sent." />}
    </main>
  )
}
