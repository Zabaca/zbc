import { LIST_POSITION } from '@space/workspace'
import { QUEUE_PAGE } from '../types'

/**
 * Where a list is cut, and how a longer read of it is asked for. Pure, so a table pins it.
 *
 * ── A POSITION, NOT AN OFFSET ────────────────────────────────────────────
 * Every list the space shows is newest first by one key: the conversation's last activity (the Sent list's key is the owner's newest sent message) and the row's own
 * number, which breaks a tie the way the SQL does (`ORDER BY last_activity_at DESC, rowid DESC`). A position is that pair. A reader that wants more than the newest screen
 * hands back the position of the oldest conversation it has (`floor`) and gets everything at or after it, so mail that arrives meanwhile (newer than every position) and mail that is
 * closed or read meanwhile move no row and repeat none: an offset would. The position is text, `<key>|<number>`, because the contract hands it back untouched and reads nothing in it.
 */

/** A conversation's place in a list's order: the key it is sorted by (an ISO time, which sorts as text) and the number that breaks a tie. */
export interface Place {
  at: string
  seq: number
}

/** The text a place is handed over as. */
export const placeText = (p: Place): string => `${p.at}|${p.seq}`

/** The place a position names, or null when the text is none. */
export function readPlace(raw: string): Place | null {
  if (!LIST_POSITION.test(raw)) return null
  const bar = raw.indexOf('|')
  return { at: raw.slice(0, bar), seq: Number(raw.slice(bar + 1)) }
}

/** Whether `a` is further down the list (older) than `b`: the list is newest first, so older means a smaller key, or the same key and a smaller number. */
export const isBelow = (a: Place, b: Place): boolean => a.at < b.at || (a.at === b.at && a.seq < b.seq)

/** What a read of a list asks for beyond its newest screen. */
export interface Reach {
  /** The position the reader has read down to; absent for the first screen. */
  through?: Place
  /** One more screen below it. */
  older?: boolean
}

/**
 * The part of a newest-first list a read answers, and whether the list goes on below it.
 *
 * With no position it is the newest screen (`screen`, the store's QUEUE_PAGE; a stand-in for the store may use a smaller one). With one it is everything at or after the position, and never fewer than a screen; with `older` it is one more screen below the position, so a reader
 * that had a screen and shrank (the older ones were closed meanwhile) still gets a full screen of what it asked for. `floor` is where the answer ends, null when it has nothing.
 */
export function cut<T>(
  list: readonly T[],
  placeOf: (item: T) => Place,
  reach: Reach,
  screen: number = QUEUE_PAGE,
): { shown: T[]; more: boolean; floor: string | null } {
  let held = 0
  if (reach.through !== undefined) {
    const through = reach.through
    while (held < list.length && !isBelow(placeOf(list[held] as T), through)) held += 1
  }
  const end = reach.through !== undefined && reach.older === true ? held + screen : Math.max(held, screen)
  const shown = list.slice(0, end)
  const last = shown[shown.length - 1]
  return { shown, more: list.length > end, floor: last === undefined ? null : placeText(placeOf(last)) }
}
