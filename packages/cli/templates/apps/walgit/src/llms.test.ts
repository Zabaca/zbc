/**
 * `/llms.txt` (`shared/llms.ts`).
 *
 * The long document for the same audience `GET /` serves tersely. Rendering is
 * pure, so it is tested here with the rest of the suite rather than behind a
 * Workers runtime — the same arrangement as `landing.test.ts`.
 *
 * What is asserted is the property that makes two documents safe to have: a
 * limit this deployment does not enforce cannot appear in either of them.
 */

import { describe, expect, test } from 'bun:test'

import { flagEnabled } from '../shared/policy'
import { MAX_REFS_PER_ENTRY, MAX_WATCH_ENTRIES } from '../shared/events'
import { renderLlms, wantsLlms } from '../shared/llms'
import { renderInstructions } from './instructions'

const FACTS = {
  host: 'agentgit.zabaca.com',
  retentionHours: null,
  maxPushBytes: null,
  maxRepoBytes: null,
  events: false,
  publicAccess: true,
  appendOnly: true,
}

describe('wantsLlms', () => {
  test('answers GET and HEAD on the one path', () => {
    expect(wantsLlms('GET', '/llms.txt')).toBe(true)
    expect(wantsLlms('HEAD', '/llms.txt')).toBe(true)
  })

  test('answers nothing else', () => {
    expect(wantsLlms('POST', '/llms.txt')).toBe(false)
    expect(wantsLlms('GET', '/')).toBe(false)
    expect(wantsLlms('GET', '/llms.txt/')).toBe(false)
    // A repository called `llms.txt` is reached at `/llms.txt.git/...`, so the
    // document cannot shadow one.
    expect(wantsLlms('GET', '/llms.txt.git/info/refs')).toBe(false)
  })
})

describe('renderLlms', () => {
  test('every command carries the host the request arrived on', () => {
    const doc = renderLlms({ ...FACTS, host: 'walgit.example' })
    expect(doc).toContain('https://walgit.example/$NAME.git')
    expect(doc).not.toContain('agentgit.zabaca.com')
  })

  test('states only the limits this deployment enforces', () => {
    const doc = renderLlms(FACTS)
    expect(doc).not.toContain('24 hours')
    expect(doc).not.toContain('per push')
    expect(doc).toContain('No credential')
    expect(doc).toContain('Refs only move forward')
  })

  test('states the ones it does', () => {
    const doc = renderLlms({
      ...FACTS,
      retentionHours: 24,
      maxPushBytes: 99 * 1024 * 1024,
      maxRepoBytes: 250 * 1024 * 1024,
    })
    expect(doc).toContain('deleted 24 hours after its LAST push')
    expect(doc).toContain('99 MiB (103809024 bytes)')
    expect(doc).toContain('250 MiB (262144000 bytes)')
  })

  test('a private deployment is told how to send its credential, not that it needs none', () => {
    const doc = renderLlms({ ...FACTS, publicAccess: false })
    expect(doc).toContain('A credential is required')
    expect(doc).not.toContain('No credential')
  })

  test('an instance that permits rewrites does not claim otherwise', () => {
    const doc = renderLlms({ ...FACTS, appendOnly: false })
    expect(doc).not.toContain('only move forward')
  })

  test('the stream is described only where it is served', () => {
    expect(renderLlms({ ...FACTS, events: true })).toContain('_walgit/events')
    expect(renderLlms({ ...FACTS, events: false })).not.toContain('_walgit/events')
    expect(renderLlms({ ...FACTS, events: false })).not.toContain('merge-tree')
  })

  test('is markdown a model can skim by its headings', () => {
    const doc = renderLlms({ ...FACTS, events: true })
    const headings = doc.split('\n').filter((l) => l.startsWith('#'))
    expect(headings.length).toBeGreaterThan(5)
    expect(doc.startsWith('# ')).toBe(true)
  })
})

/**
 * The drift this file exists to prevent.
 *
 * The Worker decides what to CLAIM and the container decides what to ENFORCE.
 * When those two read the same variable with two different predicates, the
 * document is one spelling away from lying — which is how `WALGIT_APPEND_ONLY`
 * came to be read as `1` on one side and `1 || true` on the other.
 */
describe('flagEnabled is the one predicate both halves use', () => {
  test('accepts what the push path accepts', () => {
    expect(flagEnabled('1')).toBe(true)
    expect(flagEnabled('true')).toBe(true)
  })

  test('and nothing else', () => {
    expect(flagEnabled('0')).toBe(false)
    expect(flagEnabled('')).toBe(false)
    expect(flagEnabled(undefined)).toBe(false)
    expect(flagEnabled('yes')).toBe(false)
  })
})

/**
 * The split only pays if the two documents diverge.
 *
 * They were within 150 bytes of each other when `/llms.txt` was first written,
 * which is a reformat rather than a split: the terse document had paid nothing
 * and the long one had bought nothing. These assert the shape the split is for.
 */
describe('the two documents earn their separation', () => {
  test('the long version is substantially longer than the terse one', () => {
    const facts = {
      ...FACTS,
      events: true,
      retentionHours: 24,
      maxPushBytes: 99 * 1024 * 1024,
      maxRepoBytes: 250 * 1024 * 1024,
    }
    const long = renderLlms(facts)
    const terse = renderInstructions('https://agentgit.zabaca.com', {
      publicAccess: true,
      appendOnly: true,
      events: true,
      retentionHours: 24,
      maxPushBytes: facts.maxPushBytes,
      maxRepoBytes: facts.maxRepoBytes,
    })
    expect(long.length).toBeGreaterThan(terse.length * 1.8)
    // The terse one is what an agent pays for mid-task, so it has a budget.
    expect(terse.length).toBeLessThan(3000)
  })

  test('the terse one hands off rather than repeating', () => {
    const terse = renderInstructions('https://agentgit.zabaca.com', {
      publicAccess: true,
      events: true,
    })
    expect(terse).toContain('/llms.txt')
    // The things that moved out stay out.
    expect(terse).not.toContain('merge-tree')
    expect(terse).not.toContain('Bun.spawnSync')
  })

  test('the caps it prints are the caps the fan-out enforces', () => {
    const doc = renderLlms({ ...FACTS, events: true })
    expect(doc).toContain(`${MAX_WATCH_ENTRIES} repositories`)
    expect(doc).toContain(`${MAX_REFS_PER_ENTRY} refs`)
  })
})
