// Which switch a path of the space belongs to, and so whether the install has it.
//
// Every feature is a switch any install may turn on (packages/workspace/docs/adr/0004). The parts read their own switch (meet refuses a call and has no phone, the inbox has no Gmail
// connection or assistant, the calendar's tab is not there); this is the Worker's front of the same rule: a path whose switch is off is answered as a path that is not there, before the part is asked, so no part is reached for a
// feature the install does not have. A path that no switch owns (a tab's page, mail, chat, Forms, Knowledge, Clients) is never refused here.
import { GMAIL_RETURN_PATH, GMAIL_START_PATH, type Install, type Switch } from '@space/workspace'
import { meetName } from './calls'
import { isPhonePath } from './phone'

/** The names under `/api/meet/` that are about calls: making one, reading the past ones and one's saved chat, and the meter. (`cards` is a conversation's, drawn whatever a call is, and stays.) */
const CALL_NAMES = ['huddle', 'call', 'meeting', 'calls', 'delete-chat', 'usage']
/** The names under `/api/meet/` that are the phone's. */
const PHONE_NAMES = ['phone', 'phone-read']

/** The switch a request's path belongs to, or null where none does. */
export function switchOf(pathname: string): Switch | null {
  if (pathname === '/api/calendar' || pathname.startsWith('/api/calendar/')) return 'gmail'
  if (pathname === GMAIL_START_PATH || pathname === GMAIL_RETURN_PATH) return 'gmail'
  if (isPhonePath(pathname)) return 'phone'
  const name = meetName(pathname)
  if (name !== null) {
    if (PHONE_NAMES.includes(name)) return 'phone'
    if (CALL_NAMES.includes(name)) return 'calls'
  }
  return null
}

/** Whether the install has the part this path belongs to (a path no switch owns is always had). */
export const hasPartOf = (pathname: string, install: Install): boolean => {
  const sw = switchOf(pathname)
  return sw === null || install.has(sw)
}
