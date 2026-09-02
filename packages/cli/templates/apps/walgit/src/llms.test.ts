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

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { flagEnabled } from '../shared/policy'
import { pushCertSeed, signedPushEnabled } from '../shared/provenance'
import { MAX_REFS_PER_ENTRY, MAX_WATCH_ENTRIES } from '../shared/events'
import { renderLlms, wantsLlms } from '../shared/llms'
import { SIGNERS_REF } from '../shared/protocol'
import { renderInstructions } from './instructions'

const HOST = 'agentgit.zabaca.com'

/**
 * Fixtures are ENVIRONMENTS read through `capabilitiesFrom`, never
 * `Capabilities` literals: two of the booleans are two readings of one flag, so
 * a literal can spell a deployment that cannot exist — a name that can be
 * claimed on a host where nothing can sign — and this manual's whole job is to
 * describe deployments that do.
 */
const caps = (env: CapabilityEnv) => capabilitiesFrom(env)
const OPEN: CapabilityEnv = { WALGIT_PUBLIC: '1', WALGIT_APPEND_ONLY: '1' }
const LIMITS: CapabilityEnv = {
  WALGIT_RETENTION_HOURS: '24',
  WALGIT_MAX_PUSH_BYTES: String(99 * 1024 * 1024),
  WALGIT_MAX_REPO_BYTES: String(250 * 1024 * 1024),
}
const EVENTS: CapabilityEnv = {
  WALGIT_EVENTS_URL: `https://${HOST}`,
  WALGIT_EVENTS_TOKEN: 'events',
}
const SEED: CapabilityEnv = { WALGIT_PUSH_CERT_SEED: 'nonce-seed' }
const GATE: CapabilityEnv = { WALGIT_SIGNER_LISTS: '1' }

/** Open and append-only, enforcing and offering nothing else. */
const BASE = caps(OPEN)

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
    const doc = renderLlms('walgit.example', BASE)
    expect(doc).toContain('https://walgit.example/$NAME.git')
    expect(doc).not.toContain('agentgit.zabaca.com')
  })

  test('states only the limits this deployment enforces', () => {
    const doc = renderLlms(HOST, BASE)
    expect(doc).not.toContain('24 hours')
    expect(doc).not.toContain('per push')
    expect(doc).toContain('No credential')
    expect(doc).toContain('Refs only move forward')
  })

  test('states the ones it does', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...LIMITS }))
    expect(doc).toContain('deleted 24 hours after its LAST push')
    expect(doc).toContain('99 MiB (103809024 bytes)')
    expect(doc).toContain('250 MiB (262144000 bytes)')
  })

  test('a private deployment is told how to send its credential, not that it needs none', () => {
    const doc = renderLlms(HOST, caps({ WALGIT_APPEND_ONLY: '1' }))
    expect(doc).toContain('A credential is required')
    expect(doc).not.toContain('No credential')
  })

  test('an instance that permits rewrites does not claim otherwise', () => {
    const doc = renderLlms(HOST, caps({ WALGIT_PUBLIC: '1' }))
    expect(doc).not.toContain('only move forward')
  })

  test('the stream is described only where it is served', () => {
    expect(renderLlms(HOST, caps({ ...OPEN, ...EVENTS }))).toContain('_walgit/events')
    expect(renderLlms(HOST, BASE)).not.toContain('_walgit/events')
    expect(renderLlms(HOST, BASE)).not.toContain('merge-tree')
  })

  test('signing is described only where a seed turns it on', () => {
    const on = renderLlms(HOST, caps({ ...OPEN, ...SEED }))
    expect(on).toContain('--signed=if-asked')
    expect(on).toContain('_walgit/provenance')
    // With no seed the host does not advertise `push-cert` at all, so every
    // word of it goes — the flag, the config, the endpoint and the vocabulary.
    const off = renderLlms(HOST, BASE)
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
    const doc = renderLlms(HOST, caps({ ...OPEN, ...SEED }))
    expect(doc).toContain('--signed=if-asked')
    // `=yes` appears only as the thing NOT to use, and the sentence saying so
    // is what stops an agent copying it out of the surrounding prose.
    expect(doc.replace(/\s+/g, ' ')).toContain('Use `--signed=if-asked`, not `--signed=yes`.')
  })

  test('says what a fingerprint is taken to mean, and what it is not', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...SEED })).replace(/\s+/g, ' ')
    // The identity is a key. Saying so is what stops a reader treating a
    // fingerprint as an account this host does not have.
    expect(doc).toContain('not a person and not an account')
    expect(doc).toContain('no list of allowed signers')
    expect(doc).toContain('Unsigned pushes are ordinary')
    // And the half a reader is likeliest to assume wrongly: signing buys
    // nothing, so an anonymous push is not a second-class one.
    expect(doc).toContain('buys no access')
  })

  test('stops saying signing refuses nothing once the gate can refuse', () => {
    // The manual promised, in this very paragraph, that "if provenance ever
    // starts refusing things, it will say so on this page first". This is that
    // page keeping its word: it is not the feature's documentation, only the
    // removal of the three sentences the gate makes false.
    const doc = renderLlms(HOST, caps({ ...OPEN, ...SEED, ...GATE })).replace(/\s+/g, ' ')
    expect(doc).toContain('Signer List')
    expect(doc).toContain('refs/walgit/signers')
    expect(doc).not.toContain('refuses nothing on the strength of it')
    expect(doc).not.toContain('no list of allowed signers')
    expect(doc).not.toContain('no name is owned by the key that first pushed it')
    // What is still true is still said: reads are not gated by any of it.
    expect(doc).toContain('world-readable')
  })

  /**
   * The credential bullet, which is the first thing in the document about write
   * access and the last one still promising it unconditionally.
   *
   * Read from `signerLists` ALONE, unlike `## Hold a name` below: that section
   * teaches an agent to claim a name and must not do so where nothing can sign,
   * whereas this only says what `pre-receive` refuses — and `pre-receive`
   * refuses on this flag by itself.
   */
  test('the credential bullet stops promising world-writability', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...GATE }))
    expect(doc).not.toContain('world-readable and world-writable')
    const flat = doc.replace(/\s+/g, ' ')
    expect(flat).toContain('a name that has not written a **Signer List** takes a push from anyone')
    // The unclaimed name is still the ordinary case, and the document says so
    // rather than leaving an agent to assume the gate is everywhere.
    expect(flat).toContain('which is every name until someone writes one')
    // Reads, and the warning, are untouched.
    expect(doc).toContain('world-readable')
    expect(doc).toContain('Do not push a secret.')
  })

  test('and with the flag off it is the sentence it has always been', () => {
    const doc = renderLlms(HOST, BASE)
    expect(doc).toContain(
      'Everything here is world-readable and world-writable. Do not push a secret.',
    )
  })

  /**
   * The append-only bullet says the same thing one line later — *"safe to hand
   * a repository to a stranger: they can build on it"* — so correcting only the
   * credential bullet would leave the two adjacent entries disagreeing, and an
   * agent reading the list top to bottom would get both readings.
   */
  test('the append-only bullet beside it stops making the same promise', () => {
    const off = renderLlms(HOST, BASE)
    expect(off).toContain('safe to hand a repository to a stranger')

    const on = renderLlms(HOST, caps({ ...OPEN, ...GATE }))
    expect(on).not.toContain('safe to hand a repository to a stranger')
    expect(on).toContain('safe to hand an unclaimed name to a stranger')
    // Untouched: what append-only itself guarantees.
    expect(on).toContain('Adding a commit or a branch is always allowed.')
  })

  test('is markdown a model can skim by its headings', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...EVENTS }))
    const headings = doc.split('\n').filter((l) => l.startsWith('#'))
    expect(headings.length).toBeGreaterThan(5)
    expect(doc.startsWith('# ')).toBe(true)
  })
})

/**
 * Holding a name, taught here and nowhere else.
 *
 * ADR-0012 put discovery in this document and in the refusal itself: `GET /` is
 * read mid-task against a byte budget, and ownership's failure lands on our
 * server, in our words, at the moment it is relevant. So this is the only place
 * an agent can learn a name is holdable BEFORE it is refused for pushing to
 * somebody else's — which is the whole reason the section exists.
 */
describe('the section that teaches a name can be held', () => {
  const HELD = caps({ ...OPEN, ...SEED, ...GATE })

  test('claiming, granting, revoking and reading are each one command or one commit', () => {
    const doc = renderLlms(HOST, HELD)
    expect(doc).toContain('## Hold a name')
    expect(doc).toContain(SIGNERS_REF)
    // The file, spelled the way `src/signers.ts` refuses with — the manual and
    // the refusal must not describe two different files.
    expect(doc).toContain('a file called `signers`')
    expect(doc).toContain('ssh-keygen -lf')
    // A key file that is not there must stop the recipe: the alternative is a
    // half-written list that claims the name with one key, which is the exact
    // shape the subsection below it exists to talk an agent out of.
    expect(doc).toContain('set -e -o pipefail')
    // Reading a list is git, not an endpoint anyone had to invent — but
    // `ls-remote` answers "claimed?" and never "by whom", and a clone does not
    // fetch `refs/walgit/*`, so the command that prints the keys is here too.
    expect(doc).toContain('git ls-remote')
    expect(doc).toContain('git cat-file -p FETCH_HEAD:signers')
    expect(doc).toContain('"claim":{"signers"')
    const flat = doc.replace(/\s+/g, ' ')
    expect(flat).toContain('adding a line grants, removing one revokes')
    // The rule that decides whether a just-granted agent should retry.
    expect(flat).toContain('A grant governs the NEXT push')
  })

  // The step the recipe would otherwise break silently: the document's own
  // earlier example pushes a branch unsigned, and that push is refused from the
  // moment the list lands. An agent told how to claim a name and not told this
  // has been handed a working command and a broken one.
  test('says what claiming a name costs every push after it', () => {
    const flat = renderLlms(HOST, HELD).replace(/\s+/g, ' ')
    expect(flat).toContain('must carry a signature from a key the list names')
    expect(flat).toContain('Only the founding push is free')
  })

  test('says a list may hold more than one key, and what one key costs', () => {
    const flat = renderLlms(HOST, HELD).replace(/\s+/g, ' ')
    expect(flat).toContain('List two keys')
    expect(flat).toContain('There is no recovery for a lost key')
    expect(flat).toContain('the one-key list is the shape most agents write')
  })

  // The one rendered sentence in the section: idle expiry is a way back from a
  // lost key on a deployment that collects, and there is none on one that does
  // not. Claiming either on the wrong deployment is the drift this file exists
  // to catch, arriving in the sentence with the highest cost of being wrong.
  test('and that the way back is idle expiry, only where a deployment has one', () => {
    const collecting = renderLlms(
      HOST,
      caps({ ...OPEN, ...SEED, ...GATE, WALGIT_RETENTION_HOURS: '24' }),
    ).replace(/\s+/g, ' ')
    expect(collecting).toContain('24 hours without a push collects the repository')
    const forever = renderLlms(HOST, HELD)
    expect(forever).toContain('A lost key ends the name')
    expect(forever).not.toContain('collects the repository')
  })

  // Revocation is where the section is most tempted to promise append-only,
  // which is its own flag: on a deployment that permits rewrites, a listed key
  // can delete what a revoked one pushed, so the guarantee is not the host's to
  // make. The revocation half is true either way and is stated either way.
  test('promises append-only about a revoked key only where it is enforced', () => {
    const flat = (appendOnly: boolean) =>
      renderLlms(
        HOST,
        caps({
          WALGIT_PUBLIC: '1',
          ...(appendOnly ? { WALGIT_APPEND_ONLY: '1' } : {}),
          ...SEED,
          ...GATE,
        }),
      ).replace(/\s+/g, ' ')
    expect(flat(true)).toContain('nothing it pushed can be taken away afterwards')
    expect(flat(false)).not.toContain('nothing it pushed can be taken away afterwards')
    for (const on of [true, false]) {
      expect(flat(on)).toContain('revoking it undoes nothing that key already pushed')
    }
  })

  test('names the two lists that are refused, on any repository', () => {
    const flat = renderLlms(HOST, HELD).replace(/\s+/g, ' ')
    expect(flat).toContain('refused on claimed and unclaimed names alike')
    expect(flat).toContain('deleting the ref is the empty case')
  })

  test('with the flag off, nothing in the document mentions holding a name', () => {
    const doc = renderLlms(
      HOST,
      caps({
        ...OPEN,
        ...EVENTS,
        ...SEED,
        WALGIT_RETENTION_HOURS: '24',
        WALGIT_MAX_PUSH_BYTES: '1024',
        WALGIT_MAX_REPO_BYTES: '2048',
      }),
    )
    expect(doc).not.toContain('Hold a name')
    expect(doc).not.toContain(SIGNERS_REF)
    expect(doc).not.toContain('Signer List')
  })

  // `WALGIT_SIGNER_LISTS` without `WALGIT_PUSH_CERT_SEED` is a misconfiguration
  // the gate deliberately does not paper over: nothing can sign, so every push
  // to a claimed name is refused as unsigned. Teaching an agent to claim one
  // there would hand it a command that cannot work.
  test('and with no seed to sign against, it is not taught either', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...GATE }))
    expect(doc).not.toContain('Hold a name')
    expect(doc).not.toContain(SIGNERS_REF)
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
    const everything = caps({ ...OPEN, ...LIMITS, ...EVENTS, ...SEED, ...GATE })
    const long = renderLlms(HOST, everything)
    const terse = renderInstructions(`https://${HOST}`, everything)
    expect(long.length).toBeGreaterThan(terse.length * 1.8)
    // The terse one is what an agent pays for mid-task, so it has a budget.
    expect(terse.length).toBeLessThan(3000)
  })

  test('the terse one hands off rather than repeating', () => {
    const terse = renderInstructions(`https://${HOST}`, caps({ WALGIT_PUBLIC: '1', ...EVENTS }))
    expect(terse).toContain('/llms.txt')
    // The things that moved out stay out.
    expect(terse).not.toContain('merge-tree')
    expect(terse).not.toContain('Bun.spawnSync')
  })

  test('the caps it prints are the caps the fan-out enforces', () => {
    const doc = renderLlms(HOST, caps({ ...OPEN, ...EVENTS }))
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
