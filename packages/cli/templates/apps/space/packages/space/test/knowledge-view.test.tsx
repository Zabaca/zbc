// The knowledge base as markup: every state of it drawn from a literal answer, and what it says and must never say. What a press does is knowledge-dom.test.tsx, in a DOM.
import { describe, expect, test } from 'bun:test'
import type { KnowledgeBase } from '@space/workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { fixtureKnowledge } from '../src/fixture-knowledge'
import { AddEntry, BusinessChoice, EntryCard, History, KnowledgeView, businessWords, outOfDate } from '../src/client/Knowledge'
import { KnowledgeTab } from '../src/client/KnowledgeTab'
import { OwnerContext } from '../src/client/owner'
import { SECTIONS, knowledgeBusiness, knowledgePath } from '../src/client/route'
import { Settings } from '../src/client/Settings'
import { STAND_IN_BUSINESSES } from '../src/stand-in-knowledge'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
/** Drawn in a shell for Northfield's owner, as the page is: "you" in a history is the owner. */
const html = (node: React.ReactNode) => renderToStaticMarkup(<OwnerContext.Provider value={meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield()).owner}>{node}</OwnerContext.Provider>)
const noop = async () => 'ok' as const
const base: KnowledgeBase = { ...fixtureKnowledge(NOW), business: null }
const draw = (b: KnowledgeBase = base, business: string | null = null) =>
  html(<KnowledgeView base={b} business={business} busy={false} onPick={() => undefined} onChange={noop} onAdd={noop} />)
const entry = (id: string) => base.entries.find((e) => e.id === id) as KnowledgeBase['entries'][number]

describe('the row of choices and what each shows', () => {
  test('All and then each business, in the declaration’s order, the chosen one pressed', () => {
    const all = html(<BusinessChoice base={base} chosen={null} onPick={() => undefined} />)
    expect([...all.matchAll(/data-testid="(kb-[a-z-]+)"/g)].map((m) => m[1])).toEqual(['kb-all', 'kb-northfield', 'kb-ridgeway-cycles', 'kb-shiftlantern'])
    expect(all).toContain('>All<')
    expect(all).toContain('>Ridgeway Cycles<')
    expect(html(<BusinessChoice base={base} chosen="northfield" onPick={() => undefined} />)).toMatch(/aria-pressed="true"[^>]*data-testid="kb-northfield"/)
  })

  test('all of it by default, with a line saying each business’s assistant reads only what is marked for it', () => {
    const out = draw()
    expect(out).toContain('Each business’s assistant reads only the entries marked for it')
    expect(out).toContain('a price here is a price it will quote to that business’s customers')
    expect(out).not.toContain('data-testid="reads-line"')
    // Every entry of the base, whichever its business: the fixture's nine, in the three states.
    expect(out.match(/data-testid="entry"/g)).toHaveLength(base.entries.length)
  })

  test('a business shows exactly what its assistant reads: the active entries marked for it, and the waiting and removed ones marked for it beside them', () => {
    const out = draw(base, 'ridgeway-cycles')
    expect(out).toContain('Ridgeway Cycles’s assistant reads the 3 active entries below, and nothing else.')
    expect(out).toContain('Reply time')
    expect(out).toContain('Pricing')
    expect(out).toContain('>Hours<')
    expect(out).not.toContain('What a website costs')
    expect(out).not.toContain('Where the guides are')
    const rights = draw(base, 'shiftlantern')
    expect(rights).toContain('ShiftLantern’s assistant reads the 2 active entries below')
    expect(rights).toContain('Where the guides are')
    expect(rights).not.toContain('Pricing')
    // The entry for every business is in each business's list.
    for (const id of ['northfield', 'ridgeway-cycles', 'shiftlantern']) expect(draw(base, id)).toContain('Reply time')
  })

  test('a proposal that would take an entry off the chosen business is shown there too, though it is marked for others', () => {
    const takeOff = { ...entry('k-hours-change'), id: 'k-hours-off', businesses: ['shiftlantern'] }
    const withIt: KnowledgeBase = { ...base, entries: [...base.entries, takeOff] }
    // It would change Hours, which Ridgeway reads, so Ridgeway's list shows it; Northfield's, which neither reads Hours nor is named, does not.
    expect(draw(withIt, 'ridgeway-cycles')).toContain('data-id="k-hours-off"')
    expect(draw(withIt, 'shiftlantern')).toContain('data-id="k-hours-off"')
    expect(draw(withIt, 'northfield')).not.toContain('data-id="k-hours-off"')
  })

  test('a business with no entry says nothing is marked for it, and that its assistant then states no price, hour or policy', () => {
    const none = { ...base, entries: base.entries.filter((e) => !e.businesses.includes('northfield')) }
    const out = draw(none, 'northfield')
    expect(out).toContain('Nothing is marked for Northfield Works yet.')
    expect(out).toContain('states no price, hour or policy')
    expect(draw({ ...base, entries: [] })).toContain('Nothing yet.')
  })
})

describe('an entry names its businesses', () => {
  test('as small labels, in the declaration’s order, on every card', () => {
    const out = html(<EntryCard entry={entry('k-guides')} base={base} busy={false} onChange={noop} />)
    expect(out).toContain('data-business="northfield"')
    expect(out).toContain('data-business="shiftlantern"')
    expect(out).not.toContain('data-business="ridgeway-cycles"')
    expect(draw().match(/data-testid="entry-businesses"/g)).toHaveLength(base.entries.length)
    expect(html(<EntryCard entry={entry('k-reply')} base={base} busy={false} onChange={noop} />).match(/data-business=/g)).toHaveLength(3)
  })

  test('the words for a list of them', () => {
    expect(businessWords(['northfield'], base)).toBe('Northfield Works')
    expect(businessWords(['northfield', 'shiftlantern'], base)).toBe('Northfield Works and ShiftLantern')
    expect(businessWords(['northfield', 'ridgeway-cycles', 'shiftlantern'], base)).toBe('Northfield Works, Ridgeway Cycles and ShiftLantern')
    expect(businessWords(['gone'], base)).toBe('gone')
  })

  test('an entry’s previous version is the one before it in its own list: the sequence number is one counter across every entry, so it is not consecutive', () => {
    const guides = entry('k-guides')
    // Another entry was written between the two versions: this entry's are seq 1 and 3, as the real store numbers them.
    const spread = { ...guides, versions: [{ ...(guides.versions[0] as (typeof guides.versions)[number]), seq: 1 }, { ...(guides.versions[1] as (typeof guides.versions)[number]), seq: 3 }] }
    const out = html(<History entry={spread} base={base} />)
    expect(out).toContain('Now for Northfield Works and ShiftLantern (was ShiftLantern).')
    // The fixture shares one counter across its entries too: no two versions of the base have the same seq.
    const all = base.entries.flatMap((e) => e.versions.map((v) => v.seq))
    expect(new Set(all).size).toBe(all.length)
    expect(html(<History entry={guides} base={base} />)).toContain('(was ShiftLantern)')
  })

  test('the history says who changed whom an entry is told to, and when: a change of businesses alone is a version', () => {
    const out = html(<History entry={entry('k-guides')} base={base} onPutBack={() => undefined} />)
    expect(out).toContain('Now for Northfield Works and ShiftLantern (was ShiftLantern).')
    expect(out).toContain('For ShiftLantern.')
    expect(out.indexOf('Now for Northfield Works')).toBeLessThan(out.indexOf('For ShiftLantern.'))
    expect(out).toContain('you')
    // An older version can be put back, businesses and all.
    expect(out.match(/Put this back/g)).toHaveLength(1)
  })
})

describe('what waits for Tessa', () => {
  test('is under his name and read by nobody; a change is shown beside what it would change', () => {
    const out = draw()
    expect(out).toContain('Waiting for you (3)')
    expect(out).toContain('Nothing reads it until you approve it.')
    expect(out).toContain('Proposed by Claude')
    expect(out).toContain('Now, in Hours')
    expect(out).toContain('Approve the change')
    expect(out).toContain('Proposed change')
  })

  test('a proposal that has gone out of date is marked, says why, and can only be rejected', () => {
    const stale = entry('k-pricing-change')
    expect(outOfDate(stale, base.entries)).toBe(true)
    const out = html(<EntryCard entry={stale} base={base} target={entry('k-pricing')} stale busy={false} onChange={noop} />)
    expect(out).toContain('Out of date')
    expect(out).toContain('This change is out of date.')
    expect(out).toContain('can only be rejected')
    expect(out).toContain('data-testid="reject-entry"')
    expect(out).not.toContain('data-testid="approve-entry"')
    expect(out).not.toContain('data-testid="edit-entry"')
    // In the whole page: three proposals wait, one is out of date, and only the other two can be approved.
    const page = draw()
    expect(page.match(/data-testid="stale-tag"/g)).toHaveLength(1)
    expect(page.match(/data-testid="approve-entry"/g)).toHaveLength(2)
    expect(page.match(/data-testid="reject-entry"/g)).toHaveLength(3)
  })

  test('out of date is the app’s own rule: the entry it would change is changed since, not active, or gone', () => {
    const current = entry('k-hours-change')
    expect(outOfDate(current, base.entries)).toBe(false)
    expect(outOfDate({ ...current, replacesVersion: 0 }, base.entries)).toBe(true)
    expect(outOfDate(current, base.entries.map((e) => (e.id === 'k-hours' ? { ...e, status: 'removed' as const } : e)))).toBe(true)
    expect(outOfDate(current, base.entries.filter((e) => e.id !== 'k-hours'))).toBe(true)
    // A new entry, and an entry that is not a proposal, are never out of date.
    expect(outOfDate(entry('k-lights'), base.entries)).toBe(false)
    expect(outOfDate(entry('k-pricing'), base.entries)).toBe(false)
  })
})

describe('the sections and the forms', () => {
  test('the active ones say the assistants read them, the removed are folded away, and each change is offered where it applies', () => {
    const out = draw()
    expect(out).toContain('Active (5) · the assistants read these')
    expect(out).toContain('<details')
    expect(out).toContain('Removed (1)')
    expect(out.match(/data-testid="restore-entry"/g)).toHaveLength(1)
    expect(out.match(/data-testid="remove-entry"/g)).toHaveLength(5)
  })

  test('adding asks for a title, the words and a business: Every business is one choice, and the button waits for one', () => {
    const closed = html(<AddEntry base={base} busy={false} onAdd={noop} />)
    expect(closed).toContain('>Add an entry<')
    const open = html(<AddEntry base={base} busy={false} onAdd={noop} initialOpen />)
    expect(open).toContain('New entry')
    expect(open).toContain('data-testid="pick-every"')
    expect(open.match(/type="checkbox"/g)).toHaveLength(STAND_IN_BUSINESSES.length)
    expect(open).toContain('Pick at least one business')
    expect(open).toMatch(/<button[^>]*disabled=""[^>]*data-testid="submit-entry"/)
    // In a business’s list the add form begins with that business ticked.
    const inNorthfield = html(<AddEntry base={base} busy={false} onAdd={noop} initialOpen initialBusinesses={['northfield']} />)
    expect(inNorthfield).toMatch(/data-testid="pick-northfield"[^>]*checked=""/)
    expect(inNorthfield).not.toContain('Pick at least one business')
  })

  test('the edit form carries the businesses too, with the caps on the words', () => {
    const out = html(<EntryCard entry={entry('k-guides')} base={base} busy={false} onChange={noop} initialEditing />)
    expect(out).toContain('data-testid="business-picker"')
    expect(out).toContain('maxLength="200"')
    expect(out).toContain('maxLength="10000"')
    expect(out).toContain('>Save<')
  })
})

describe('the tab and its address', () => {
  const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())

  test('the business chosen is in the address, and anything that is not a business id is All', () => {
    expect(knowledgeBusiness('?business=ridgeway-cycles')).toBe('ridgeway-cycles')
    expect(knowledgeBusiness('')).toBeNull()
    for (const bad of ['?business=', '?business=../x', '?business=A B', `?business=${'a'.repeat(80)}`, '?view=bulk']) expect([bad, knowledgeBusiness(bad)]).toEqual([bad, null])
    expect(knowledgePath('/knowledge', 'northfield')).toBe('/knowledge?business=northfield')
    expect(knowledgePath('/knowledge', null)).toBe('/knowledge')
    expect(knowledgeBusiness(knowledgePath('/knowledge', 'shiftlantern').slice('/knowledge'.length))).toBe('shiftlantern')
  })

  test('Knowledge is the last tab, after People, and the page is headed Knowledge', () => {
    expect(me.tabs.map((t) => t.id)).toEqual(['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'])
    const out = html(<KnowledgeTab me={me} search="?business=northfield" go={() => undefined} />)
    expect(out).toContain('data-testid="knowledge-tab"')
    expect(out).toContain('<h1 id="h-knowledge">Knowledge</h1>')
  })

  test('Settings has no knowledge section: the tab is the one place that changes it', () => {
    expect(SECTIONS.map((s) => s.id)).not.toContain('knowledge')
    expect(html(<Settings me={me} pathname="/settings/knowledge" go={() => undefined} />)).toContain('settings-not-found')
  })
})
