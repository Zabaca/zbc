// What the Workspace object tells the space's live object after a call. Pure, so `bun test` drives it with no object.
//
// Every change the core stores that it would send to a socket is also a change the TEAM'S pages must read again, and a teammate's page has no socket on this object: it has one on the space's live object, which
// is told here. The message names the part (chat), the teammates it is for and, when the change is one conversation's, the key the page opens that conversation by; it never carries the change itself. Guests are not told
// this way: they keep their own sockets here, which `flush` still pushes to.

import type { LiveMessage } from '@space/workspace'
import type { Effect } from './workspace'

/** The conversation a change belongs to, or null (a structure change can be about no one conversation). */
export const convOf = (change: Extract<Effect, { t: 'deliver' }>['change']): number | null => (typeof change.data.conv === 'number' ? change.data.conv : null)

/** How the core says who among some people is a teammate and what their page calls the conversation (`WorkspaceCore.liveTargets`). */
export type LiveTargets = (people: string[], conv: number | null) => { email: string; key?: string }[]

/**
 * The messages for the changes a call just made: one per distinct conversation key, naming the teammates it is for, and one with no key for the changes that are no conversation's. A burst of changes in
 * one conversation (a message and the read mark that follows) is one message to each person, not one each.
 */
export function chatMessages(effects: readonly Effect[], targets: LiveTargets): LiveMessage[] {
  const byKey = new Map<string, Set<string>>()
  for (const e of effects) {
    if (e.t !== 'deliver') continue
    for (const { email, key } of targets(e.people, convOf(e.change))) {
      const k = key ?? ''
      byKey.set(k, (byKey.get(k) ?? new Set()).add(email))
    }
  }
  return [...byKey].map(([key, people]) => ({ part: 'chat', people: [...people], ...(key !== '' && { conversation: key }) }))
}
