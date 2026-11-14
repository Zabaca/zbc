// A property test of the one promise the left menu makes: every number in it equals the rows its list holds. The menu's counts are the inbox's (`rowCounts`, packages/inbox/src/store/row-counts.ts) and the
// lists are the space's (`mergeConversations`, narrowed as the page narrows them); both read the same placement of each thread (`placeConversation`: the one outsider who wrote last, a Client's list among
// that Client's people), and this test makes random worlds and holds the two together for every view, every mailbox and both Clients. It found, before it was kept: a Client's unread that disagreed when a
// teammate's two contacts (one linked to a Client, one not) are one row (31 in 45,000 worlds).
//
// A fixed seed and a bounded count: it runs in about a second, and half the teammate worlds are built to contain that case and gives the same worlds every time. The worlds include a teammate known by two addresses, Tessa's own other Gmail accounts, contacts with no
// address, contacts that share a name with their address (a bare address), business mailboxes, Bulk, closed and drafts. nav-counts.test.ts is the same promise through the real store.
import { describe, expect, test } from 'bun:test'
import { isBulk } from '@space/inbox/src/queue'
import { isInside, placeConversation } from '@space/inbox/src/store/placement'
import { type RowParty, rowCounts } from '@space/inbox/src/store/row-counts'
import type { InboxPeople, InboxThreadLine } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import { narrow, type ListView } from '../src/client/format'
import { mergeConversations, type View } from '../src/conversations'

const base = northfield()
const PEOPLE = [
  { name: 'Priya', address: 'priya@northfield.example', signIn: 'priya_n@gmail.com', role: 'member' },
  { name: 'Sam', address: 'sam@northfield.example', signIn: 'sam_k@gmail.com', role: 'member' },
  { name: 'Tessa', address: 'tessa@northfield.example', signIn: 'tessa@northfield.example', role: 'owner' },
]
// The install, with the people the worlds use as the team. Only `people`, `person` and `personBySignIn` are read by the merge.
const install = {
  ...base,
  people: PEOPLE,
  person: (a: string) => PEOPLE.find((p) => p.address === a.trim().toLowerCase()) ?? null,
  personBySignIn: (a: string) => PEOPLE.find((p) => p.signIn === a?.trim().toLowerCase()) ?? null,
} as unknown as typeof base
const team = PEOPLE.map((p) => [p.address, p.signIn])
// Tessa's own addresses: every Gmail account of his (the inbox's `ownAddresses()`), beside the team's.
const OWN = ['tessa@northfield.example', 'tessa@ashgrove.example', 'tessa_marlow@gmail.com']
const INSIDE = new Set([...OWN, ...team.flat()])

// A mailbox on the mail server (read and written over JMAP, 'jm') is one of them too: its conversations are email ones, in a mailbox of its own like Ridgeway's.
// Telegram's mailbox is one of them: its conversations are of kind telegram, its people have no email address (only a Telegram identity), and a bot's chat is Bulk by the sender rule.
const MAILBOXES = [null, { id: 'ridgeway', name: 'Ridgeway', address: 'info@ridgeway.example' }, { id: 'rc', name: 'RC', address: 'hi@rc.example' }, { id: 'tg', name: 'Telegram', address: '7000000001' }, { id: 'jm', name: 'harborline', address: 'test@harborline.example' }]
const TIMES = [null, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z']

interface World {
  contacts: { id: string; name: string; addresses: string[]; clientId: number | null }[]
  facts: Record<string, unknown>[]
  parties: RowParty[]
  people: InboxPeople
}

function makeWorld(rnd: () => number, ownAndTeam: boolean): World {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const contacts: World['contacts'] = []
  for (let i = 0; i < 1 + Math.floor(rnd() * 7); i++) {
    const r = rnd()
    const teammate = pick(PEOPLE)
    const addresses = ownAndTeam
      ? r < 0.15
        ? [teammate.address]
        : r < 0.3
          ? [teammate.signIn]
          : r < 0.4
            ? [pick(OWN)]
            : r < 0.5
              ? []
              : r < 0.6
                ? [`o${i}@x.example`, `o${i}b@y.example`]
                : [`o${i}@x.example`]
      : r < 0.1
        ? []
        : r < 0.2
          ? [`o${i}@x.example`, `o${i}b@y.example`]
          : [`o${i}@x.example`]
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].sort()
    contacts.push({ id: `c${i}`, addresses: unique, name: rnd() < 0.5 ? `Name ${i}` : (unique[0] ?? ''), clientId: rnd() < 0.3 ? pick([7, 9]) : null })
  }
  // Half of the teammate worlds start with the case that is rare at random: one teammate known by both addresses, one contact linked to a Client and one not (a row of two contacts).
  if (ownAndTeam && rnd() < 0.5 && contacts.length >= 2) {
    const teammate = pick(PEOPLE)
    contacts[0] = { id: 'c0', name: 'Name 0', addresses: [teammate.address], clientId: pick([7, 9]) }
    contacts[1] = { id: 'c1', name: 'Name 1', addresses: [teammate.signIn], clientId: null }
  }
  // An address belongs to one contact.
  const seen = new Set<string>()
  for (const c of contacts) c.addresses = c.addresses.filter((a) => (seen.has(a) ? false : (seen.add(a), true)))

  const facts: World['facts'] = []
  const parties: RowParty[] = []
  const placedOf = new Map<string, ReturnType<typeof placeConversation>>()
  const onOf = new Map<string, World['contacts']>()
  for (let t = 0; t < 1 + Math.floor(rnd() * 8); t++) {
    const on = contacts.filter(() => rnd() < 0.4)
    if (on.length === 0) continue
    const f = {
      id: `t${t}`,
      lastActivityAt: '',
      drafts: rnd() < 0.2 ? 1 : 0,
      newestInbound: rnd() < 0.3 ? { listUnsubscribe: true, labels: [], automated: false } : rnd() < 0.15 ? { listUnsubscribe: false, labels: [], automated: true } : null,
      clientIds: [],
      open: rnd() < 0.75,
      unread: rnd() < 0.4,
      mailbox: pick(MAILBOXES),
      at: t,
    }
    facts.push(f)
    const placed = placeConversation(
      on.map((c) => ({ contactId: c.id, name: c.name, addresses: c.addresses, clientId: c.clientId, inside: isInside(c.addresses, INSIDE), wroteAt: pick(TIMES), touchedAt: pick(TIMES) })),
    )
    placedOf.set(f.id, placed)
    onOf.set(f.id, on)
    for (const c of on)
      parties.push({ conversationId: f.id, contactId: c.id, clientId: c.clientId, addresses: c.addresses, placed: placed.everyone === c.id, placedInClient: c.clientId !== null && placed.byClient.get(c.clientId) === c.id })
  }
  const people: InboxPeople = {
    more: false,
    people: contacts.flatMap((c) => {
      const lines = facts
        .filter((f) => (onOf.get(f.id as string) ?? []).some((o) => o.id === c.id))
        .map((f): InboxThreadLine => {
          const placed = placedOf.get(f.id as string) as ReturnType<typeof placeConversation>
          return {
            conversationId: f.id as string,
            subject: '',
            kind: (f.mailbox as { id: string } | null)?.id === 'tg' ? 'telegram' : 'email',
            at: 1000 - (f.at as number),
            snippet: 's',
            direction: 'in',
            unread: f.unread as boolean,
            open: f.open as boolean,
            bulk: isBulk(f as never),
            drafts: f.drafts as number,
            mailbox: f.mailbox as InboxThreadLine['mailbox'],
            alsoOn: [],
            listed: placed.everyone === c.id,
            listedInClient: c.clientId === null || placed.byClient.get(c.clientId) === c.id,
          }
        })
      if (lines.length === 0) return []
      const first = lines[0] as InboxThreadLine
      return [
        {
          contactId: c.id,
          name: c.name,
          addresses: c.addresses,
          client: c.clientId === null ? null : { id: c.clientId, name: `K${c.clientId}`, listed: true },
          suggestedClient: null,
          newest: { conversationId: first.conversationId, at: 0, kind: 'email', direction: 'in', subject: '', snippet: '' },
          unread: 0,
          conversations: lines,
        },
      ]
    }),
  }
  return { contacts, facts, parties, people }
}

/** The menu's numbers against the rows each list holds when opened; the names of the views that disagree. */
function disagreements(w: World): string[] {
  const counts = rowCounts(w.facts as never, w.parties, team)
  const list = (view: View, lv: ListView) => {
    const rows = narrow(mergeConversations({ install, self: ['tessa@northfield.example'], view, inbox: w.people, meet: null }).rows, lv, 'all')
    return { count: rows.length, unread: rows.filter((r) => r.unread > 0).length }
  }
  const zero = { count: 0, unread: 0 }
  const want: Record<string, unknown> = {
    inbox: list({ kind: 'main' }, 'all'),
    unread: list({ kind: 'unread' }, 'unread').count,
    bulk: list({ kind: 'bulk' }, 'bulk'),
    closed: list({ kind: 'closed' }, 'closed'),
    drafts: list({ kind: 'drafts' }, 'drafts').count,
    ridgeway: list({ kind: 'mailbox', id: 'ridgeway' }, 'mailbox:ridgeway'),
    rc: list({ kind: 'mailbox', id: 'rc' }, 'mailbox:rc'),
    tg: list({ kind: 'mailbox', id: 'tg' }, 'mailbox:tg'),
    jm: list({ kind: 'mailbox', id: 'jm' }, 'mailbox:jm'),
    client7: list({ kind: 'client', id: 7 }, 'client:7'),
    client9: list({ kind: 'client', id: 9 }, 'client:9'),
  }
  const got: Record<string, unknown> = {
    inbox: counts.views.inbox,
    unread: counts.views.unread.count,
    bulk: counts.views.bulk,
    closed: counts.views.closed,
    drafts: counts.views.drafts.count,
    ridgeway: counts.mailboxes.ridgeway ?? zero,
    rc: counts.mailboxes.rc ?? zero,
    tg: counts.mailboxes.tg ?? zero,
    jm: counts.mailboxes.jm ?? zero,
    client7: counts.clients[7] ?? zero,
    client9: counts.clients[9] ?? zero,
  }
  return Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]))
}

/** A fixed-seed generator (a linear congruential one): the same worlds on every run. */
const generator = (seed: number) => {
  let n = seed
  return () => ((n = (n * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

const WORLDS = 3000

describe('the menu equals the rows, for random worlds', () => {
  for (const [what, ownAndTeam, seed] of [
    ['outsiders only', false, 11],
    ['with teammates (known by two addresses) and Tessa’s other Gmail accounts', true, 12],
    ['with teammates and Tessa’s other Gmail accounts, another seed', true, 13],
  ] as const)
    test(`${WORLDS} worlds ${what}: every view, mailbox and Client`, () => {
      const rnd = generator(seed)
      const bad: string[] = []
      for (let i = 0; i < WORLDS; i++) {
        const w = makeWorld(rnd, ownAndTeam)
        const views = disagreements(w)
        if (views.length > 0) bad.push(`world ${i}: ${views.join(', ')} ${JSON.stringify(w.parties)}`)
      }
      expect(bad.slice(0, 3)).toEqual([])
    })
})
