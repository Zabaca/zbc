// The unread count in the browser tab's title: "(3) Meet | Northfield Works", as /start's tab said "(3) meet". It counts the chat messages from other people that the person has not read, in
// every direct message, channel and the Phone conversation, wherever in the space they are; email's unread stays in the Unread view's own count. The Worker adds it up from meet's overview
// (`/api/meet/unread`), so the page asks for one number.
//
// It is read when the page opens, when the page is shown again, when chat moves (the live connection), when something here changed (a message read or sent) and every ten minutes while it is visible as the net.
import { useEffect, useRef, useState } from 'react'
import { useLive } from './liveHub'
import { CHANGED_EVENT } from './nav'
import { REFRESH_EVENT, SAFETY_NET_MS } from './notify'
import { getView } from './views'

/** The title with the count in front of it when there is one; 99 and over is "99+". */
export const titleWith = (title: string, unread: number): string => (unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${title}` : title)

/** The unread chat messages, kept as fresh as the menu is. A read that fails leaves the last count (a title does not flicker to nothing because one read missed). */
export function useChatUnread(): number {
  const [unread, setUnread] = useState(0)
  // The count is read again when chat moves; `read` is the effect's, so it is held here for the live connection to call.
  const again = useRef<() => void>(() => {})
  useLive(['chat'], () => again.current())
  useEffect(() => {
    let live = true
    let ctl: AbortController | null = null
    const read = () => {
      if (document.visibilityState !== 'visible') return
      ctl?.abort()
      ctl = new AbortController()
      void getView<{ unread: number }>('meet/unread', {}, ctl.signal).then((got) => {
        if (live && got.kind === 'value' && Number.isSafeInteger(got.value.unread)) setUnread(got.value.unread)
      })
    }
    again.current = read
    read()
    const timer = setInterval(read, SAFETY_NET_MS)
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    window.addEventListener(CHANGED_EVENT, read)
    window.addEventListener(REFRESH_EVENT, read)
    return () => {
      live = false
      ctl?.abort()
      clearInterval(timer)
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
      window.removeEventListener(CHANGED_EVENT, read)
      window.removeEventListener(REFRESH_EVENT, read)
    }
  }, [])
  return unread
}
