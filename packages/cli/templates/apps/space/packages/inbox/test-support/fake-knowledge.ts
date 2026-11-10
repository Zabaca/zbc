import {
  answered,
  KNOWLEDGE_AGENT_PREFIX,
  type KnowledgeBase,
  type KnowledgeEntry,
  type KnowledgeForInbox,
  type KnowledgeProposal,
  type KnowledgeText,
  refused,
  type SpaceReply,
} from '@space/workspace'

/**
 * The knowledge app as the inbox sees it (packages/knowledge, its inbox face), in memory: the test adapter of the seam
 * in src/knowledge.ts, as clients-part.ts is for the Clients part. It answers the contract's three methods in the contract's
 * shapes, filters by business the way the app does (an ACTIVE entry whose businesses include the one asked for, oldest first), and can
 * be made to fail, hang or answer nonsense, as an app that is down, slow or mid-deploy can.
 *
 * The rules of the knowledge base itself (versions, the owner alone changing entries, the fifty proposals) are the knowledge app's and
 * proven in its own tests; this is only enough of it to see what the inbox asks and what it does with the answer. Answers cross the
 * boundary structured-cloned, as a service binding's do.
 */

export interface Seeded {
  title: string
  body: string
  businesses: string[]
  status?: KnowledgeEntry['status']
}

const NORTHFIELD_BUSINESSES = [
  { id: 'northfield', name: 'Northfield Works' },
  { id: 'ridgeway-cycles', name: 'Ridgeway Cycles' },
  { id: 'shiftlantern', name: 'ShiftLantern' },
]

export class FakeKnowledge implements KnowledgeForInbox {
  entries: KnowledgeEntry[] = []
  /** When set, every call throws it, as a binding to a Worker that is down does. */
  failure: Error | null = null
  /** When set, every call answers this instead (a thing that is not a reply, or a refusal). */
  answer: unknown = undefined
  /** When set, a call does not answer until this many milliseconds have passed (a hang, for the four-second rule). */
  delayMs = 0
  /** Every call, in order: what was asked and with what. */
  calls: { method: 'activeFor' | 'readBase' | 'propose'; args: unknown[] }[] = []

  /** The businesses the knowledge base knows: Northfield's unless a test for another company gives its own. */
  constructor(
    seed: Seeded[] = [],
    private readonly businesses: { id: string; name: string }[] = NORTHFIELD_BUSINESSES,
  ) {
    for (const s of seed) this.seed(s)
  }

  seed(s: Seeded): KnowledgeEntry {
    const n = this.entries.length + 1
    const entry: KnowledgeEntry = {
      id: `kb-${n}`,
      title: s.title,
      body: s.body,
      businesses: [...s.businesses],
      status: s.status ?? 'active',
      proposedBy: null,
      replaces: null,
      replacesVersion: null,
      createdAt: n,
      createdBy: 'tessa@northfield.example',
      updatedAt: n,
      updatedBy: 'tessa@northfield.example',
      version: 1,
      versions: [
        { seq: 1, by: 'tessa@northfield.example', at: n, title: s.title, body: s.body, businesses: [...s.businesses] },
      ],
    }
    this.entries.push(entry)
    return entry
  }

  private async answerWith<T>(
    method: 'activeFor' | 'readBase' | 'propose',
    args: unknown[],
    make: () => SpaceReply<T>,
  ): Promise<SpaceReply<T>> {
    this.calls.push({ method, args })
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.failure) throw this.failure
    if (this.answer !== undefined) return structuredClone(this.answer) as SpaceReply<T>
    return structuredClone(make())
  }

  activeFor(business: string): Promise<SpaceReply<KnowledgeText[]>> {
    return this.answerWith('activeFor', [business], () => {
      if (!this.businesses.some((b) => b.id === business)) return refused('not-found', 'No such business.')
      return answered(
        this.entries
          .filter((e) => e.status === 'active' && e.businesses.includes(business))
          .map((e) => ({ title: e.title, body: e.body })),
      )
    })
  }

  readBase(business?: string): Promise<SpaceReply<KnowledgeBase>> {
    return this.answerWith('readBase', [business], () => {
      if (business !== undefined && !this.businesses.some((b) => b.id === business))
        return refused('not-found', 'No such business.')
      return answered({
        businesses: this.businesses,
        business: business ?? null,
        entries: this.entries.filter((e) => business === undefined || e.businesses.includes(business)),
      })
    })
  }

  propose(by: string, proposal: KnowledgeProposal): Promise<SpaceReply<KnowledgeEntry>> {
    return this.answerWith('propose', [by, proposal], () => {
      if (!by.startsWith(KNOWLEDGE_AGENT_PREFIX)) return refused('not-admitted', 'Only an agent proposes.')
      if (proposal.replaces === undefined || proposal.replaces === null) {
        if (!proposal.title || !proposal.body || !proposal.businesses?.length)
          return refused('bad-request', 'A new entry needs a title, a body and a business.')
      }
      const entry = this.seed({
        title: proposal.title ?? '',
        body: proposal.body ?? '',
        businesses: proposal.businesses ?? [],
        status: 'proposed',
      })
      entry.proposedBy = by
      entry.replaces = proposal.replaces ?? null
      return answered(entry)
    })
  }
}
