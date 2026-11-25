// What the page says of the texts bridge: one function, so the menu's foot and Settings' card say the SAME sentence: live, catching up, the phone not answering (since when), signed out (with what to do), another
// browser holding the session, or amber when the bridge has not checked in for five minutes, saying since when. The inbox gives the state and the times; the words, and the time in the owner's own zone, are here.
// Pure, so a table can check every sentence.
import type { InboxTextsState } from '@space/workspace'
import { stamp } from './convo'
import { agoText } from './settings-parts'

export interface TextsFacts {
  state: InboxTextsState
  checkedInAt: number | null
  lastPushAt: number | null
  phoneSince?: number | null
}

/** The sentence for a state, and whether it needs a look (amber): only a sign-in Google ended and a bridge that has gone quiet. */
export function textsWords(t: TextsFacts, now: number, zone?: string): { text: string; amber: boolean } {
  switch (t.state) {
    case 'signed-out':
      return { text: 'Google ended the texts bridge’s sign-in. Only you can sign in again.', amber: true }
    case 'not-checked-in':
      return {
        text: t.checkedInAt === null ? 'The texts bridge has not checked in yet.' : `The texts bridge has not checked in since ${stamp(now, t.checkedInAt, zone)}.`,
        amber: true,
      }
    case 'phone-not-answering':
      return {
        text: t.phoneSince == null ? 'Your phone is not answering. Texts will catch up when it is back.' : `Your phone is not answering since ${stamp(now, t.phoneSince, zone)}. Texts will catch up when it is back.`,
        amber: false,
      }
    case 'session-taken':
      return { text: 'Another browser took the Messages for web session; the bridge is taking it back.', amber: false }
    case 'catching-up':
      return { text: 'Texts are catching up.', amber: false }
    case 'live':
      return { text: t.lastPushAt === null ? 'Texts are live, no texts yet.' : `Texts are live, last text ${agoText(now, t.lastPushAt)}.`, amber: false }
  }
}
