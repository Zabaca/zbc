// When a call's object tells the space's live object: when WHO IS IN THE CALL changes, and when a call is made. Pure, so `bun test` drives it.
//
// The pages that draw calls (Today's "in a call now", the Calls list, a conversation's call card, a call's own screen) read them again when told. The message names the part (calls) and nobody and nothing else: a
// call's name is its link and stays out of it, and a call is listed to the people it relates to, which the read applies. A call's heartbeat (`checkIn`) arrives every few seconds for every person in it, so it
// tells only when it changed who is there (a person it dropped as gone), not each time.

/** The calls after which the people in a call can be different, or the call is new. */
export const PRESENCE_CALLS = ['create', 'join', 'leave', 'checkIn'] as const

export const changesPresence = (method: string): boolean => (PRESENCE_CALLS as readonly string[]).includes(method)

/** The calls after which the object sets its alarm for the next person to be dropped: someone joined. (`checkIn` moves the deadline later; the alarm that is set fires early and sets itself again.) */
export const armsReap = (method: string): boolean => method === 'join'

/**
 * Whether a call that changes presence should tell, given how many were in the call before it and after (null: the call did not exist yet, or could not be counted). A new call always tells (it is a row
 * on the lists); the others only when the count moved.
 */
export function shouldTell(method: string, before: number | null, after: number | null): boolean {
  if (!changesPresence(method)) return false
  if (method === 'create') return true
  return before !== after
}
