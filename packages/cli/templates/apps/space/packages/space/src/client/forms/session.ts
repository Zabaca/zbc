// The Forms sign-in, and what to do when it ends under a screen.
//
// /forms is the Forms Access application's, a day long; the rest of the space is the space's, a month (ADR 0002). The tab opens with
// a full page load, which Access can send to its sign-in, so a day's session is renewed before the screens are drawn. A screen left
// open past the day, or one reached by the browser's Back from another tab, finds it ended on its first call. Access can send a whole
// PAGE to its sign-in and a fetch cannot follow that, so the page reloads itself: its address is under the Forms application, and
// Access signs the person in and brings them back to it.

/** The prefix the operator API's calls start with: the space hands `/forms/api/*` to forms (src/forms.ts). */
export const API_BASE = '/forms/api'

/** Where a client's logo is: the space forwards `/forms/logo/` to forms' public `/s/api/logo/`, so the image stays on the space's address. */
export const LOGO_BASE = '/forms/logo'

/** The slice of `Storage` used. */
export interface Keeps {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * One renewal per this long, as the first-visit recovery does (src/recover.ts): if reloading does not renew the session (a refusal that
 * does not go away, such as forms deployed with the wrong audience), the person is told, not looped, however slow the reload is on a phone.
 */
export const RENEW_ONCE_MS = 180_000
const RENEW_AT = 'space:forms-renew-at'

/**
 * Reload the page once, to renew the sign-in; false when it already tried a moment ago (then the caller says what happened and
 * offers a link, and nothing loops). With no storage to remember the try in, it does not reload at all: a loop is worse than a link.
 */
export function renewSignIn(storage: Keeps | null, now: number, reload: () => void): boolean {
  try {
    if (!storage) return false
    const at = Number(storage.getItem(RENEW_AT) ?? 0)
    if (now - at < RENEW_ONCE_MS) return false
    storage.setItem(RENEW_AT, String(now))
  } catch {
    return false
  }
  reload()
  return true
}

/** The browser's session storage, or null where it will not answer (a private window may refuse it). */
export function safeStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** The sign-in ended under a call: reload the page, at most once in a while. False when it has just tried, and the screen then says to reload by hand. */
export const reloadToSignIn = (): boolean => typeof window !== 'undefined' && renewSignIn(safeStorage(), Date.now(), () => window.location.reload())

/**
 * Whether the sign-in has ended, asked of `/me` with the redirect left unfollowed: Access's redirect to its sign-in is an
 * `opaqueredirect`, and the Worker's refusal is a 401. Anything else, or no answer at all, is not the sign-in ending.
 */
export async function signInEnded(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/me`, { redirect: 'manual', cache: 'no-store' })
    return res.type === 'opaqueredirect' || res.status === 401
  } catch {
    return false
  }
}
