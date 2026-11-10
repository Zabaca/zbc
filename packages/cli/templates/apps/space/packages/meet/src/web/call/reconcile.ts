// What to ask the SFU for, from what the call's list says. Pure: no page, no
// media. The controller holds the set of publications it has pulled in (or is
// pulling in) and calls this after every check-in.

import type { Kind, Snapshot } from '../../model'

export interface Pub {
  memberId: string
  kind: Kind
  v: number
}

/** One publication has one key; `v` changes when the same kind is published again, so a restarted share is a new key. */
export const keyOf = (p: Pub): string => `${p.memberId}:${p.kind}:${p.v}`

/** Everything other people are publishing, once each, in the list's order. */
export function wanted(snapshot: Snapshot, selfId: string): Pub[] {
  const seen = new Set<string>()
  const out: Pub[] = []
  for (const m of snapshot.members) {
    if (m.id === selfId) continue
    for (const p of m.publishing) {
      const pub = { memberId: m.id, kind: p.kind, v: p.v }
      if (seen.has(keyOf(pub))) continue
      seen.add(keyOf(pub))
      out.push(pub)
    }
  }
  return out
}

/**
 * `held` is what has been pulled in or is being pulled in. Returns what to
 * subscribe to (wanted, not held) and what to let go of (held, no longer
 * wanted: the person left, or stopped sharing).
 */
export function reconcile(snapshot: Snapshot, selfId: string, held: Iterable<Pub>): { subscribe: Pub[]; unsubscribe: Pub[] } {
  const want = wanted(snapshot, selfId)
  const wantKeys = new Set(want.map(keyOf))
  const heldByKey = new Map<string, Pub>()
  for (const p of held) heldByKey.set(keyOf(p), p)
  return {
    subscribe: want.filter((p) => !heldByKey.has(keyOf(p))),
    unsubscribe: [...heldByKey.values()].filter((p) => !wantKeys.has(keyOf(p))),
  }
}
