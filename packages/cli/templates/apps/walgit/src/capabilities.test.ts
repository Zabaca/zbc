/**
 * The one derivation of what this deployment advertises
 * (`shared/capabilities.ts`).
 *
 * It lives in `shared/` because both halves read it and neither may own it, and
 * it is tested here with the rest of the suite rather than behind a Workers
 * runtime — the same arrangement as `landing.test.ts` and `llms.test.ts`.
 *
 * What is asserted is the shape of each predicate rather than any document's
 * wording: three documents and the push path now agree because they read this,
 * so this is the only place the reading itself is checked.
 */

import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom } from '../shared/capabilities'
import { announceConfigFromEnv } from './announce'

describe('the stream takes both halves', () => {
  /**
   * The behaviour this module changed, and the reason it is a behaviour change
   * rather than a refactor.
   *
   * The Worker used to claim the socket path on `WALGIT_EVENTS_TOKEN` alone
   * while the container's `post-receive` announced only with both. Token-only
   * meant the edge advertised the stream in two documents, answered the
   * handshake with current refs, and then delivered nothing forever — because
   * the push path had no URL to announce to. An advertised socket that never
   * speaks is worse than none, since an agent writes the client before finding
   * out.
   */
  test('is off with either half missing', () => {
    expect(capabilitiesFrom({}).events).toBe(false)
    expect(capabilitiesFrom({ WALGIT_EVENTS_TOKEN: 'secret' }).events).toBe(false)
    expect(capabilitiesFrom({ WALGIT_EVENTS_URL: 'https://agentgit.example' }).events).toBe(false)
  })

  // Blank collapses to unset, the same reading `containerEnv` makes at the seam:
  // a variable cleared to an empty string is a capability turned off, not one
  // configured with nothing.
  test('is off with either half blank', () => {
    for (const [url, token] of [
      ['', 'secret'],
      ['   ', 'secret'],
      ['https://agentgit.example', ''],
      ['https://agentgit.example', '   '],
    ]) {
      expect(capabilitiesFrom({ WALGIT_EVENTS_URL: url, WALGIT_EVENTS_TOKEN: token }).events).toBe(
        false,
      )
    }
  })

  test('is on only with both set', () => {
    expect(
      capabilitiesFrom({
        WALGIT_EVENTS_URL: 'https://agentgit.example',
        WALGIT_EVENTS_TOKEN: 'secret',
      }).events,
    ).toBe(true)
  })

  /**
   * The one thing that could still make an advertisement a lie: the push path
   * decides where to announce from `announceConfigFromEnv` (`src/announce.ts`),
   * which reads the same two variables for itself. It is not simply `events` —
   * it returns a `{url, token}` rather than a boolean — so what has to hold is
   * that its truthiness and this flag cannot disagree.
   */
  test('and agrees with what the push path announces to, in every combination', () => {
    for (const url of [undefined, '', '  ', 'https://agentgit.example']) {
      for (const token of [undefined, '', '  ', 'secret']) {
        const env = { WALGIT_EVENTS_URL: url, WALGIT_EVENTS_TOKEN: token }
        expect(capabilitiesFrom(env).events).toBe(announceConfigFromEnv(env) !== null)
      }
    }
  })
})

/**
 * The two strengths of the Signer List flag, which used to be a paragraph
 * repeated in three doc comments and enforced nowhere.
 */
describe('the two strengths of the gate', () => {
  const SEED = { WALGIT_PUSH_CERT_SEED: 'nonce-seed' }
  const GATE = { WALGIT_SIGNER_LISTS: '1' }

  /**
   * `pre-receive` refuses on the flag by itself (`signerListsEnabled`,
   * `src/signers.ts`), so a deployment that sets it with no nonce seed refuses
   * EVERY push to a claimed name. Any sentence that only states what is refused
   * has to be corrected there — "world-writable" is more wrong on that
   * deployment, not less.
   */
  test('namesCanRefuse is the flag alone, with no seed', () => {
    const caps = capabilitiesFrom(GATE)
    expect(caps.namesCanRefuse).toBe(true)
    expect(caps.signedPushes).toBe(false)
  })

  /**
   * And any sentence that sends somebody off to CLAIM a name needs the seed as
   * well: with the flag and no seed nothing can sign, so they would claim it
   * with an unsigned push and then be refused on every push to it, their own
   * included, with no way to sign out of it.
   */
  test('namesCanBeClaimed needs the seed too', () => {
    expect(capabilitiesFrom(GATE).namesCanBeClaimed).toBe(false)
    expect(capabilitiesFrom({ ...GATE, ...SEED }).namesCanBeClaimed).toBe(true)
  })

  // The seed without the flag is signing without ownership, which is the state
  // every deployment that took ADR-0011 and not ADR-0012 is in.
  test('and the seed alone claims neither', () => {
    const caps = capabilitiesFrom(SEED)
    expect(caps.signedPushes).toBe(true)
    expect(caps.namesCanRefuse).toBe(false)
    expect(caps.namesCanBeClaimed).toBe(false)
  })
})

/**
 * The boolean-ish variables, which BOTH halves have to read identically: the
 * container enforces append-only from this answer and the edge documents
 * describe it from the same one (`flagEnabled`, docs/adr/0010).
 */
describe('the flags take 1 and true, and nothing else', () => {
  test('publicAccess and appendOnly are on for either spelling', () => {
    for (const raw of ['1', 'true']) {
      expect(capabilitiesFrom({ WALGIT_PUBLIC: raw }).publicAccess).toBe(true)
      expect(capabilitiesFrom({ WALGIT_APPEND_ONLY: raw }).appendOnly).toBe(true)
    }
  })

  test('and off for everything else', () => {
    for (const raw of [undefined, '', '0', 'yes', 'TRUE', 'on']) {
      expect(capabilitiesFrom({ WALGIT_PUBLIC: raw }).publicAccess).toBe(false)
      expect(capabilitiesFrom({ WALGIT_APPEND_ONLY: raw }).appendOnly).toBe(false)
    }
  })
})

/**
 * The three numbers, whose absent value is `null` rather than an omitted key —
 * a document asks `!== null` and gets one answer, and the push path takes the
 * same field as its cap (`limitsOf`, `src/limits.ts`).
 */
describe('a number that is not a positive number is no limit at all', () => {
  const NUMBERS = [
    'WALGIT_RETENTION_HOURS',
    'WALGIT_MAX_PUSH_BYTES',
    'WALGIT_MAX_REPO_BYTES',
  ] as const
  const READ = {
    WALGIT_RETENTION_HOURS: (c: ReturnType<typeof capabilitiesFrom>) => c.retentionHours,
    WALGIT_MAX_PUSH_BYTES: (c: ReturnType<typeof capabilitiesFrom>) => c.maxPushBytes,
    WALGIT_MAX_REPO_BYTES: (c: ReturnType<typeof capabilitiesFrom>) => c.maxRepoBytes,
  }

  // Zero would refuse every push and a negative one is a typo; neither may
  // silently become "this host accepts nothing", and neither may reach a
  // document as a stated cap of NaN.
  test('unset, blank, unparseable, zero and negative all read as null', () => {
    for (const name of NUMBERS) {
      for (const raw of [undefined, '', '   ', 'lots', 'NaN', '0', '-1']) {
        expect(READ[name](capabilitiesFrom({ [name]: raw }))).toBeNull()
      }
    }
  })

  test('a positive number is the limit', () => {
    expect(capabilitiesFrom({ WALGIT_RETENTION_HOURS: '24' }).retentionHours).toBe(24)
    expect(capabilitiesFrom({ WALGIT_MAX_PUSH_BYTES: '104857600' }).maxPushBytes).toBe(104857600)
    expect(capabilitiesFrom({ WALGIT_MAX_REPO_BYTES: '250000000' }).maxRepoBytes).toBe(250000000)
  })
})

/**
 * The empty environment, which is what a deployment that has configured nothing
 * offers — and what `src/http.ts` falls back to when it is wired without
 * capabilities. Nothing is `undefined`: every field is present and says no.
 */
test('an unconfigured deployment advertises nothing, and says so in every field', () => {
  expect(capabilitiesFrom({})).toEqual({
    publicAccess: false,
    appendOnly: false,
    events: false,
    signedPushes: false,
    namesCanRefuse: false,
    namesCanBeClaimed: false,
    retentionHours: null,
    maxPushBytes: null,
    maxRepoBytes: null,
  })
})
