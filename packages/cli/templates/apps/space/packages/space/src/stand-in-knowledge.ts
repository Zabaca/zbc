// The stand-in for the knowledge app (packages/knowledge, `createSpaceKnowledge`, which runs in the space's Worker): what `bun test` asks instead of the real one, and what a
// local page shows with fixture data (`SPACE_FIXTURES`, src/app.ts) so the Knowledge tab can be seen and photographed without it.
//
// It keeps the shape of the real answers (packages/workspace/src/knowledge.ts) and the rules the tab leans on: a change names the version it was
// shown (a stale one is `conflict`), an entry needs at least one business the base lists, adding what an active entry already says is refused,
// a change of businesses is a version, and approving a proposed change over an entry that has moved past the version it was written against is
// refused. It checks nothing about who is asking: the real app admits the owner only, and the space's own tests prove the person its one sign-in check named is
// the one handed over (`calls[].asker`). Every call is recorded, so a test can see what was and was not sent.

import {
  answered,
  failed,
  type KnowledgeBase,
  type KnowledgeBusiness,
  type KnowledgeChange,
  type KnowledgeEntry,
  type KnowledgeForSpace,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'

/** The businesses of Northfield's declaration, in its order: what the tab's row of choices lists. */
export const STAND_IN_BUSINESSES: KnowledgeBusiness[] = [
  { id: 'northfield', name: 'Northfield Works' },
  { id: 'ridgeway-cycles', name: 'Ridgeway Cycles' },
  { id: 'shiftlantern', name: 'ShiftLantern' },
]

export interface StandInKnowledgeState {
  businesses: KnowledgeBusiness[]
  entries: KnowledgeEntry[]
}

export interface StandInKnowledge {
  /** Every call, by method and its arguments after the person, who is recorded by address. */
  calls: { method: string; args: unknown[]; asker?: string }[]
  state: StandInKnowledgeState
  /** What the next call does instead of the normal thing: `throw` (the binding fails), `hang` (never answers), `broken` (a fault). */
  script: ('throw' | 'hang' | 'broken')[]
  methods: KnowledgeForSpace
}

const OWNER = 'tessa@northfield.example'

export function standInKnowledge(initial: Partial<StandInKnowledgeState> = {}, options: { now?: () => number } = {}): StandInKnowledge {
  const state: StandInKnowledgeState = { businesses: STAND_IN_BUSINESSES, entries: [], ...initial }
  const calls: StandInKnowledge['calls'] = []
  const script: StandInKnowledge['script'] = []
  const now = options.now ?? Date.now
  let ids = 0

  async function enter<T>(asker: SignedIn, method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    calls.push({ method, args, asker: asker.person.address })
    const step = script.shift()
    if (step === 'throw') throw new Error('stand-in knowledge app lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('The knowledge base could not answer that. Nothing was changed.')
    return null
  }

  const known = (ids: string[]): boolean => ids.every((id) => state.businesses.some((b) => b.id === id))
  const inOrder = (ids: string[]): string[] => state.businesses.map((b) => b.id).filter((id) => ids.includes(id))
  /** `seq` is one counter across every entry, as the real store's is: an entry's versions are not consecutive numbers. */
  const nextSeq = (): number => 1 + Math.max(0, ...state.entries.flatMap((e) => e.versions.map((v) => v.seq)))
  const ORDER = { active: 0, proposed: 1, removed: 2 } as const

  const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'
  const methods: KnowledgeForSpace = {
    async storeBookmark(a) {
      return (await enter<{ bookmark: string }>(a, 'storeBookmark', [])) ?? answered({ bookmark: BOOKMARK })
    },
    async restartStore(a) {
      return (await enter<{ restarted: true }>(a, 'restartStore', [])) ?? answered({ restarted: true as const })
    },
    async restoreStore(a, bookmark) {
      return (await enter<{ restoring: true }>(a, 'restoreStore', [bookmark])) ?? answered({ restoring: true as const })
    },
    async knowledge(a, business) {
      const early = await enter<KnowledgeBase>(a, 'knowledge', [business])
      if (early) return early
      if (business !== undefined && !state.businesses.some((b) => b.id === business)) return refused('not-found', 'No such business.')
      const entries = state.entries
        .filter((e) => business === undefined || e.businesses.includes(business))
        .map((e, n) => ({ e, n }))
        .sort((x, y) => ORDER[x.e.status] - ORDER[y.e.status] || x.n - y.n)
        .map(({ e }) => e)
      return answered({ businesses: state.businesses, business: business ?? null, entries: structuredClone(entries) })
    },
    async changeKnowledge(a, change: KnowledgeChange) {
      const early = await enter<KnowledgeEntry>(a, 'changeKnowledge', [change])
      if (early) return early
      const at = now()
      if (change.do === 'add') {
        const title = change.title.trim()
        const body = change.body.trim()
        if (change.businesses.length === 0) return refused('bad-request', 'Choose at least one business for this entry.')
        if (!known(change.businesses)) return refused('bad-request', 'That is not a business of this company.')
        if (state.entries.some((e) => e.status === 'active' && e.title === title && e.body === body)) {
          return refused('conflict', 'An entry that says the same is already there, so nothing was added. Add the business to that entry instead.')
        }
        const businesses = inOrder(change.businesses)
        const entry: KnowledgeEntry = {
          id: `entry-${++ids}`,
          title,
          body,
          businesses,
          status: 'active',
          proposedBy: null,
          replaces: null,
          replacesVersion: null,
          createdAt: at,
          createdBy: OWNER,
          updatedAt: at,
          updatedBy: OWNER,
          version: 1,
          versions: [{ seq: nextSeq(), by: OWNER, at, title, body, businesses }],
        }
        state.entries.push(entry)
        return answered(structuredClone(entry))
      }
      const entry = state.entries.find((e) => e.id === change.id)
      if (!entry) return refused('not-found', 'No such entry.')
      if (change.version !== entry.version) return refused('conflict', 'This entry was changed since you saw it. Read it again.')
      if (change.do === 'edit') {
        if (entry.status === 'removed') return refused('conflict', 'A removed entry cannot be edited. Put it back first.')
        if (change.businesses !== undefined && change.businesses.length === 0) return refused('bad-request', 'Choose at least one business for this entry.')
        if (change.businesses !== undefined && !known(change.businesses)) return refused('bad-request', 'That is not a business of this company.')
        return apply(entry, { title: change.title, body: change.body, businesses: change.businesses })
      }
      if (change.do === 'approve') {
        if (entry.status !== 'proposed') return refused('conflict', 'Only a proposal can be approved.')
        if (entry.replaces !== null) {
          const target = state.entries.find((e) => e.id === entry.replaces)
          if (!target || target.status !== 'active') return refused('conflict', 'The entry this would change is gone. Reject it, or ask Claude to propose it as a new entry.')
          if (target.version !== entry.replacesVersion) {
            return refused('conflict', 'The entry this would change was changed after it was proposed, so approving it would undo that change, and nothing was changed. Reject it, and ask Claude to propose it again against the entry as it is now.')
          }
          apply(target, { title: entry.title, body: entry.body, businesses: entry.businesses })
          entry.status = 'removed'
          return answered(structuredClone(target))
        }
        entry.status = 'active'
      } else if (change.do === 'remove' || change.do === 'reject') entry.status = 'removed'
      else if (change.do === 'restore') entry.status = 'active'
      entry.updatedAt = at
      entry.updatedBy = OWNER
      return answered(structuredClone(entry))
    },
  }

  /** An edit: a new version when the words or the businesses differ, none when nothing does. */
  function apply(entry: KnowledgeEntry, over: { title?: string | undefined; body?: string | undefined; businesses?: string[] | undefined }): SpaceReply<KnowledgeEntry> {
    const title = (over.title ?? entry.title).trim()
    const body = (over.body ?? entry.body).trim()
    const businesses = over.businesses === undefined ? entry.businesses : inOrder(over.businesses)
    if (title === entry.title && body === entry.body && businesses.join() === entry.businesses.join()) return answered(structuredClone(entry))
    const at = now()
    Object.assign(entry, { title, body, businesses, updatedAt: at, updatedBy: OWNER, version: entry.version + 1 })
    entry.versions.push({ seq: nextSeq(), by: OWNER, at, title, body, businesses })
    return answered(structuredClone(entry))
  }

  return { calls, state, script, methods }
}
