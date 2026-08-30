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
import { pushCertSeed, signedPushEnabled } from '../shared/provenance'
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
  signedPushes: false,
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

  test('signing is described only where a seed turns it on', () => {
    const on = renderLlms({ ...FACTS, signedPushes: true })
    expect(on).toContain('--signed=if-asked')
    expect(on).toContain('_walgit/provenance')
    // With no seed the host does not advertise `push-cert` at all, so every
    // word of it goes — the flag, the config, the endpoint and the vocabulary.
    const off = renderLlms({ ...FACTS, signedPushes: false })
    for (const claim of [
      '--signed',
      'signingkey',
      'push certificate',
      'fingerprint',
      'Signer',
      'provenance',
    ]) {
      expect(off).not.toContain(claim)
    }
  })

  test('recommends the form that is correct against every host', () => {
    const doc = renderLlms({ ...FACTS, signedPushes: true })
    expect(doc).toContain('--signed=if-asked')
    // `=yes` appears only as the thing NOT to use, and the sentence saying so
    // is what stops an agent copying it out of the surrounding prose.
    expect(doc.replace(/\s+/g, ' ')).toContain('Use `--signed=if-asked`, not `--signed=yes`.')
  })

  test('says what a fingerprint is taken to mean, and what it is not', () => {
    const doc = renderLlms({ ...FACTS, signedPushes: true }).replace(/\s+/g, ' ')
    // The identity is a key. Saying so is what stops a reader treating a
    // fingerprint as an account this host does not have.
    expect(doc).toContain('not a person and not an account')
    expect(doc).toContain('no list of allowed signers')
    // And the half a reader is likeliest to assume wrongly: signing buys
    // nothing, so an anonymous push is not a second-class one.
    expect(doc).toContain('Unsigned pushes are ordinary')
    expect(doc).toContain('buys no access')
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
    // Every capability on, which is the only version of this test worth
    // having: the budget has to hold for the deployment that claims the most,
    // and each feature so far has arrived believing it was "just three lines".
    const facts = {
      ...FACTS,
      events: true,
      signedPushes: true,
      retentionHours: 24,
      maxPushBytes: 99 * 1024 * 1024,
      maxRepoBytes: 250 * 1024 * 1024,
    }
    const long = renderLlms(facts)
    const terse = renderInstructions('https://agentgit.zabaca.com', {
      publicAccess: true,
      appendOnly: true,
      events: true,
      signedPushes: true,
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

/**
 * The seed is the capability, and both halves read it the same way.
 *
 * `WALGIT_PUSH_CERT_SEED` is what the container writes onto every repository
 * as `receive.certNonceSeed`, which is the only thing that makes
 * `git-receive-pack` advertise `push-cert`. If the Worker read it with a
 * second predicate, a document could offer signing on a host whose git refuses
 * it — the `WALGIT_APPEND_ONLY` drift again, with a worse failure mode,
 * because the agent finds out only after writing the push.
 */
describe('signedPushEnabled is the one reading of the seed', () => {
  test('a configured seed is the capability, whatever it spells', () => {
    expect(signedPushEnabled('a-long-random-seed')).toBe(true)
    // Not a boolean variable: `0` and `false` are perfectly good seeds, and
    // reading them as "off" would silently disable a configured deployment.
    expect(signedPushEnabled('false')).toBe(true)
    expect(pushCertSeed('  spaced  ')).toBe('spaced')
  })

  test('unset and blank are both "this deployment does not take one"', () => {
    expect(signedPushEnabled(undefined)).toBe(false)
    expect(signedPushEnabled('')).toBe(false)
    expect(signedPushEnabled('   ')).toBe(false)
    expect(pushCertSeed('')).toBeNull()
  })
})
