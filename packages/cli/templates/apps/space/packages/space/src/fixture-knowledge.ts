// Invented data for a local page (`SPACE_FIXTURES`, src/app.ts): the Knowledge tab as it looks with entries for each business, one for all three, one
// whose businesses were changed (so its history shows who was told it), proposals waiting, one gone out of date, and a removed entry. Times are counted
// back from `now`. Never reached on a deployed address. Every price is made up.

import type { KnowledgeEntry, KnowledgeVersion } from '@space/workspace'
import { STAND_IN_BUSINESSES, type StandInKnowledgeState } from './stand-in-knowledge'

const MIN = 60_000
const OWNER = 'tessa@northfield.example'

export function fixtureKnowledge(now: number): StandInKnowledgeState {
  const ago = (minutes: number) => now - minutes * MIN
  const day = 60 * 24
  // One counter across every entry, as the real store's: an entry's own versions are not consecutive numbers.
  let seq = 0
  const v = (minutes: number, by: string, title: string, body: string, businesses: string[]): KnowledgeVersion => ({ seq: ++seq, by, at: ago(minutes), title, body, businesses })
  const entry = (over: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, 'id' | 'title' | 'body' | 'businesses'>): KnowledgeEntry => {
    const versions = over.versions ?? [v(day * 9, OWNER, over.title, over.body, over.businesses)]
    return {
      status: 'active',
      proposedBy: null,
      replaces: null,
      replacesVersion: null,
      createdAt: ago(day * 9),
      createdBy: OWNER,
      updatedAt: ago(day * 9),
      updatedBy: OWNER,
      version: versions.length,
      versions,
      ...over,
    }
  }
  const ALL = STAND_IN_BUSINESSES.map((b) => b.id)
  const pricing = entry({
    id: 'k-pricing',
    title: 'Pricing',
    body: 'A winter service with a full safety check is $180. A brake bleed is $45.',
    businesses: ['ridgeway-cycles'],
    updatedAt: ago(day * 2),
    versions: [
      v(day * 9, OWNER, 'Pricing', 'A winter service with a full safety check is $160. A brake bleed is $45.', ['ridgeway-cycles']),
      v(day * 2, OWNER, 'Pricing', 'A winter service with a full safety check is $180. A brake bleed is $45.', ['ridgeway-cycles']),
    ],
  })
  const guides = entry({
    id: 'k-guides',
    title: 'Where the guides are',
    body: 'The guides live at shiftlantern.example/guides. Point people there; never name a guide that is not listed.',
    businesses: ['northfield', 'shiftlantern'],
    updatedAt: ago(day * 3),
    versions: [
      v(day * 9, OWNER, 'Where the guides are', 'The guides live at shiftlantern.example/guides. Point people there; never name a guide that is not listed.', ['shiftlantern']),
      // A change of businesses alone is a version: from now on Northfield's assistant is told this too.
      v(day * 3, OWNER, 'Where the guides are', 'The guides live at shiftlantern.example/guides. Point people there; never name a guide that is not listed.', ['northfield', 'shiftlantern']),
    ],
  })
  const entries: KnowledgeEntry[] = [
    entry({ id: 'k-hours', title: 'Hours', body: 'Open Monday to Friday 9 to 5, and Saturday 9 to 1. Closed Sunday.', businesses: ['ridgeway-cycles'] }),
    pricing,
    entry({
      id: 'k-sites',
      title: 'What a website costs',
      body: 'A five page site starts at $2,400 and is ready in three weeks. Care plans start at $79 a month.',
      businesses: ['northfield'],
      createdAt: ago(day * 5),
      updatedAt: ago(day * 5),
      versions: [v(day * 5, OWNER, 'What a website costs', 'A five page site starts at $2,400 and is ready in three weeks. Care plans start at $79 a month.', ['northfield'])],
    }),
    guides,
    entry({ id: 'k-reply', title: 'Reply time', body: 'We answer every message within one business day.', businesses: ALL }),
    // Waiting for him: a new entry for two businesses, a change that is still current, and a change gone out of date.
    entry({
      id: 'k-lights',
      title: 'Lights and bags before a service',
      body: 'Please take lights and bags off before a service. Locks can stay on.',
      businesses: ['ridgeway-cycles'],
      status: 'proposed',
      proposedBy: 'agent:claude',
      createdAt: ago(60 * 5),
      updatedAt: ago(60 * 5),
      updatedBy: 'agent:claude',
      versions: [v(60 * 5, 'agent:claude', 'Lights and bags before a service', 'Please take lights and bags off before a service. Locks can stay on.', ['ridgeway-cycles'])],
    }),
    entry({
      id: 'k-hours-change',
      title: 'Hours',
      body: 'Open Monday to Friday 9 to 6, and Saturday 9 to 1. Closed Sunday.',
      businesses: ['ridgeway-cycles'],
      status: 'proposed',
      proposedBy: 'agent:claude',
      replaces: 'k-hours',
      replacesVersion: 1,
      createdAt: ago(60 * 3),
      updatedAt: ago(60 * 3),
      updatedBy: 'agent:claude',
      versions: [v(60 * 3, 'agent:claude', 'Hours', 'Open Monday to Friday 9 to 6, and Saturday 9 to 1. Closed Sunday.', ['ridgeway-cycles'])],
    }),
    entry({
      id: 'k-pricing-change',
      title: 'Pricing',
      body: 'A winter service with a full safety check is $170. A brake bleed is $45.',
      businesses: ['ridgeway-cycles'],
      status: 'proposed',
      proposedBy: 'agent:claude',
      replaces: 'k-pricing',
      // Written against version 1 of Pricing; he has since corrected it, so approving this would put the old price back.
      replacesVersion: 1,
      createdAt: ago(day * 4),
      updatedAt: ago(day * 4),
      updatedBy: 'agent:claude',
      versions: [v(day * 4, 'agent:claude', 'Pricing', 'A winter service with a full safety check is $170. A brake bleed is $45.', ['ridgeway-cycles'])],
    }),
    entry({ id: 'k-old', title: 'Holiday hours 2025', body: 'Closed December 24 to January 2.', businesses: ['ridgeway-cycles'], status: 'removed', updatedAt: ago(day * 4) }),
  ]
  return { businesses: STAND_IN_BUSINESSES, entries }
}
