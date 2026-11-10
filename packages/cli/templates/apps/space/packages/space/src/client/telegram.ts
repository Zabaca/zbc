// What the page says of the Telegram bridge: one function, so the menu's foot and Settings' card say the SAME sentence:
// "live, catching up, signed out (with what to do), or amber when the bridge has not checked in for five minutes, saying since when". The inbox gives the state and the times; the words,
// and the time in the owner's own zone, are here. Pure, so a table can check every sentence.
import type { InboxTelegramState } from '@space/workspace'
import { stamp } from './convo'
import { agoText } from './settings-parts'

export interface TelegramFacts {
  state: InboxTelegramState
  checkedInAt: number | null
  lastPushAt: number | null
}

/** The sentence for a state, and whether it needs a look (amber). */
export function telegramWords(t: TelegramFacts, now: number, zone?: string): { text: string; amber: boolean } {
  switch (t.state) {
    case 'signed-out':
      return { text: 'Telegram ended the saved login for the bridge. Only you can sign in again.', amber: true }
    case 'not-checked-in':
      return {
        text: t.checkedInAt === null ? 'The Telegram bridge has not checked in yet.' : `The Telegram bridge has not checked in since ${stamp(now, t.checkedInAt, zone)}.`,
        amber: true,
      }
    case 'catching-up':
      return { text: 'Telegram is catching up on messages.', amber: false }
    case 'live':
      return { text: t.lastPushAt === null ? 'Telegram is live, no messages yet.' : `Telegram is live, last message ${agoText(now, t.lastPushAt)}.`, amber: false }
  }
}
