// What the menu's views list, against what the menu counts: Drafts holds every conversation with a draft whatever state it is in, a Client its open conversations
// Bulk included, so the tree cannot say "Drafts 1" while the list says nobody has a draft; and a person's Client pills, the dashed one for a Client only suggested.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { lane, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { type ConversationsAnswer, type ListedPerson, type ListedRow, parseView } from '../src/conversations'
import { ConversationsScreen } from '../src/client/Conversations'
import { narrow, requestFor } from '../src/client/format'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { LANE_TEAM, NORTHFIELD_TEAM, ago, contact, thread, world } from './world'

const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const HARBOR = { id: 7, name: 'Harbor Dental' }
const TAMARACK = { id: 3, name: 'Tamarack Print Supply' }

/** Harbor's people have an open thread, a Bulk one, and a closed one with a draft on it; Lena (no Client) has an open thread with a draft. */
function inbox() {
  return standInInbox(
    [{ ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: HARBOR }, { ...contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'), client: HARBOR }, contact('c-lena', 'Lena Fischer', 'lena@bakery.example'), { ...contact('c-ned', 'Ned Quill', 'ned@bakery.example'), suggested: TAMARACK }],
    [
      thread('t-dana', ago(10), ['c-dana']),
      thread('t-marcus-bulk', ago(20), ['c-marcus'], { bulk: true }),
      thread('t-marcus-closed', ago(30), ['c-marcus'], { open: false }),
      thread('t-lena', ago(40), ['c-lena']),
      thread('t-lena-closed', ago(50), ['c-lena'], { open: false }),
      thread('t-ned', ago(60), ['c-ned']),
    ],
    {
      drafts: [
        { id: 'd-1', conversationId: 't-lena', contactId: 'c-lena', subject: 'Re', text: 'Hi', at: ago(5) },
        { id: 'd-2', conversationId: 't-marcus-closed', contactId: 'c-marcus', subject: 'Re', text: 'Hi', at: ago(6) },
      ],
    },
  )
}

async function listed(query: string): Promise<ConversationsAnswer> {
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox(), meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60 })
  const res = await w.call(`/api/conversations${query}`, { jwt: await w.signIn('tessa@northfield.example') })
  expect(res.status).toBe(200)
  return (await res.json()) as ConversationsAnswer
}
const names = (a: ConversationsAnswer | ListedRow[]) => (Array.isArray(a) ? a : a.rows).map((r) => r.name)

describe('Drafts lists what the menu counts', () => {
  test('every person with a draft waiting on a conversation of ANY state: an open one, and one that is closed', async () => {
    const a = await listed('?view=drafts')
    expect(names(a).sort()).toEqual(['Lena Fischer', 'Marcus Chen'])
    // The closed conversation with a draft is there though Closed and the main list hold it apart; the counts of drafts are per row.
    expect(Object.fromEntries((a.rows as ListedPerson[]).map((r) => [r.name, r.drafts]))).toEqual({ 'Lena Fischer': 1, 'Marcus Chen': 1 })
    expect(names(narrow(a.rows, 'drafts', 'all')).sort()).toEqual(['Lena Fischer', 'Marcus Chen'])
    // The main list alone would have shown one of them: that was the mismatch.
    expect(names(narrow((await listed('')).rows, 'drafts', 'all'))).toEqual(['Lena Fischer'])
  })

  test('the page asks for it by name, and the Worker knows the name', () => {
    expect(requestFor('drafts')).toBe('/api/conversations?scope=mail&view=drafts')
    expect(parseView('drafts', undefined)).toEqual({ kind: 'drafts' })
    expect(parseView('drafts', 'ridgeway')).toBeNull()
  })
})

describe('a Client lists its open conversations, Bulk included', () => {
  test('Harbor’s people are there for a Bulk thread, and a person with only a closed thread is not', async () => {
    const a = await listed('?view=client')
    expect(names(a).sort()).toEqual(['Dana Reyes', 'Lena Fischer', 'Marcus Chen', 'Ned Quill']) // the open list, Bulk included, before the page keeps the Client's own
    const harbor = narrow(a.rows, 'client:7', 'all')
    expect(names(harbor).sort()).toEqual(['Dana Reyes', 'Marcus Chen'])
    const marcus = harbor.find((r) => r.name === 'Marcus Chen') as ListedPerson
    // Marcus's open Bulk thread is in his row, and his closed one is not (the Client's count is open conversations).
    expect(marcus.mail.map((m) => m.newest.subject)).toEqual(['Subject of t-marcus-bulk'])
    expect(requestFor('client:7')).toBe('/api/conversations?scope=mail&view=client')
    expect(parseView('client', undefined)).toEqual({ kind: 'client' })
  })
})

describe('a person’s Client pills', () => {
  const draw = (a: ConversationsAnswer) =>
    renderToStaticMarkup(<ConversationsScreen me={ME} now={Date.now()} answer={a} loading={false} problem={null} view="all" who="all" onWho={() => undefined} query="" onQuery={() => undefined} results={null} live="off" selected={null} go={() => undefined} />)

  test('a linked person has the Client’s pill; a person with none linked and a suggestion has the dashed one with a question mark, saying it counts for nothing yet', async () => {
    const markup = draw(await listed('?view=client'))
    expect(markup).toContain('data-testid="client-pill"')
    expect(markup.match(/data-testid="client-pill"/g)).toHaveLength(2) // Dana and Marcus
    expect(markup).toContain('data-testid="client-suggested"')
    expect(markup).toContain('Tamarack Print Supply ?')
    expect(markup).toContain('Not counted until it is linked there.')
    // Only Ned has the suggestion; Lena has none, and a linked person has no dashed pill.
    expect(markup.match(/data-testid="client-suggested"/g)).toHaveLength(1)
  })

  test('a person known by two addresses that belong to two Clients shows both pills, once each', async () => {
    const two = standInInbox(
      [{ ...contact('c-work', 'Corin', 'corin@pinecrest.test'), client: HARBOR }, { ...contact('c-gmail', 'Corin (personal)', 'corin.private@example.com'), client: TAMARACK }],
      [thread('t1', ago(10), ['c-work']), thread('t2', ago(20), ['c-gmail'])],
    )
    const w = await world(lane(), LANE_TEAM, { inbox: two, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60 })
    const res = await w.call('/api/conversations', { jwt: await w.signIn('lane@pinecrest.test') })
    const a = (await res.json()) as ConversationsAnswer
    const corin = a.rows.filter((r) => r.type === 'person') as ListedPerson[]
    expect(corin).toHaveLength(1)
    expect(corin[0]?.clients.map((c) => c.name)).toEqual(['Harbor Dental', 'Tamarack Print Supply'])
    expect(corin[0]?.suggestedClient).toBeNull()
    const markup = draw(a)
    expect(markup.match(/data-testid="client-pill"/g)).toHaveLength(2)
    // Narrowing to either Client keeps the person.
    expect(narrow(a.rows, 'client:7', 'all')).toHaveLength(1)
    expect(narrow(a.rows, 'client:3', 'all')).toHaveLength(1)
    expect(narrow(a.rows, 'client:9', 'all')).toHaveLength(0)
  })

  test('an inbox that does not carry suggestions (an older one) is read as none', async () => {
    const old = inbox()
    const people = old.people.bind(old)
    old.people = async (a, s) => {
      const r = await people(a, s)
      if (r.ok) for (const p of r.value.people) delete (p as { suggestedClient?: unknown }).suggestedClient
      return r
    }
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: old, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60 })
    const a = (await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).json()) as ConversationsAnswer
    expect(a.rows.every((r) => r.type !== 'person' || r.suggestedClient === null)).toBe(true)
    expect(a.parts[0]).toMatchObject({ part: 'mail', state: 'ok' })
  })
})
