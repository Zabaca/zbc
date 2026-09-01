/**
 * The ref-event protocol lives in `shared/`, because both halves speak it: the
 * Durable Object at the edge holds the subscriptions and the container's push
 * path produces the events. Every decision in it is pure, so it is tested here
 * with the rest of the suite rather than behind a Workers runtime — the same
 * arrangement as `landing.test.ts` and `container-env.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { parseTokens } from '../shared/credentials'
import {
  authorizeAnnounce,
  authorizeSubscribe,
  encode,
  eventsFromChanges,
  handshake,
  MAX_REFS_PER_ENTRY,
  MAX_WATCH_ENTRIES,
  parseAnnounce,
  parseWatch,
  watchCovers,
  watchedRepos,
} from '../shared/events'
import { ANNOUNCE_PATH, EVENTS_PATH, ZERO_OID } from '../shared/protocol'
import { normalizeRepoId } from './repo'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('authorizeSubscribe', () => {
  const tokens = ['read-token', 'rotating-token']

  test('takes exactly what a read takes — bearer or git basic', () => {
    expect(
      authorizeSubscribe({
        authorization: 'Bearer read-token',
        tokens,
        isPublic: false,
      }),
    ).toBe(true)
    // git sends `<user>:<password>`; the user half is ignored, as in src/http.ts.
    const basic = `Basic ${btoa('walgit:rotating-token')}`
    expect(authorizeSubscribe({ authorization: basic, tokens, isPublic: false })).toBe(true)
  })

  test('refuses a missing or wrong credential', () => {
    expect(authorizeSubscribe({ authorization: null, tokens, isPublic: false })).toBe(false)
    expect(
      authorizeSubscribe({
        authorization: 'Bearer nope',
        tokens,
        isPublic: false,
      }),
    ).toBe(false)
    expect(
      authorizeSubscribe({
        authorization: 'Basic ????',
        tokens,
        isPublic: false,
      }),
    ).toBe(false)
  })

  test('a public deployment has a public stream', () => {
    // An event says a ref moved and where to — strictly less than a clone of
    // the same repository already hands over, which anyone may do here.
    expect(authorizeSubscribe({ authorization: null, tokens: [], isPublic: true })).toBe(true)
  })
})

describe('authorizeAnnounce', () => {
  test('only the push path may publish', () => {
    expect(authorizeAnnounce('Bearer announce-secret', 'announce-secret')).toBe(true)
    expect(authorizeAnnounce('Bearer read-token', 'announce-secret')).toBe(false)
    expect(authorizeAnnounce(null, 'announce-secret')).toBe(false)
  })

  test('an unset secret authorizes nobody', () => {
    // The endpoint does not exist without one; this is the belt to that braces.
    expect(authorizeAnnounce('Bearer ', '')).toBe(false)
    expect(authorizeAnnounce('Bearer x', '')).toBe(false)
  })
})

describe('parseTokens', () => {
  test('reads the list the way src/server.ts reads it', () => {
    expect(parseTokens(' a , b ,, ')).toEqual(['a', 'b'])
    expect(parseTokens(undefined)).toEqual([])
  })
})

describe('parseWatch', () => {
  test('accepts the frozen wire form', () => {
    const parsed = parseWatch('{"watch":[{"repo":"my-thing","refs":["refs/heads/main"]}]}')
    expect(parsed).toEqual({
      ok: true,
      value: [{ repo: 'my-thing', refs: ['refs/heads/main'] }],
    })
  })

  test('omitted refs is a whole-repository watch', () => {
    const parsed = parseWatch('{"watch":[{"repo":"my-thing"}]}')
    expect(parsed.ok && parsed.value[0]!.refs).toBeUndefined()
  })

  test('a bad message is refused with a reason, never ignored', () => {
    // Silence would leave the client waiting forever on a subscription it
    // believes it made — indistinguishable from a repository nobody pushes to.
    for (const raw of ['not json', '[]', '{}', '{"watch":[]}', '{"watch":[{"repo":"../etc"}]}']) {
      const parsed = parseWatch(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.ok === false && parsed.error.length > 0).toBe(true)
    }
  })

  test('the repo gate matches the one a URL path goes through', () => {
    // Both go through `REPO_ID` in shared/protocol.ts, but not through the same
    // function: `normalizeRepoId` strips the address forms a URL carries first.
    // A name one accepts and the other refuses would be a hole in whichever is
    // laxer, so the two are driven from one list.
    for (const name of ['ok-name', 'a.b_c', 'A1']) {
      expect(parseWatch(`{"watch":[{"repo":"${name}"}]}`).ok).toBe(true)
      expect(normalizeRepoId(name)).toBe(name)
    }
    for (const name of ['-leading', 'has/slash', '.hidden', '']) {
      expect(parseWatch(`{"watch":[{"repo":"${name}"}]}`).ok).toBe(false)
      expect(() => normalizeRepoId(name)).toThrow()
    }
  })

  test('a ref must be a full ref name', () => {
    expect(parseWatch('{"watch":[{"repo":"r","refs":["main"]}]}').ok).toBe(false)
    expect(parseWatch('{"watch":[{"repo":"r","refs":["refs/tags/v1"]}]}').ok).toBe(true)
  })
})

describe('parseAnnounce', () => {
  test('accepts a push and a deletion', () => {
    const parsed = parseAnnounce({
      events: [
        { repo: 'my-thing', ref: 'refs/heads/main', sha: SHA_A },
        { repo: 'my-thing', ref: 'refs/heads/gone', sha: null },
      ],
    })
    expect(parsed.ok && parsed.value).toHaveLength(2)
  })

  test('refuses a malformed announcement', () => {
    expect(parseAnnounce(null).ok).toBe(false)
    expect(parseAnnounce({}).ok).toBe(false)
    expect(
      parseAnnounce({
        events: [{ repo: 'r', ref: 'refs/heads/main', sha: 'zz' }],
      }).ok,
    ).toBe(false)
    expect(
      parseAnnounce({
        events: [{ repo: '/etc', ref: 'refs/heads/main', sha: SHA_A }],
      }).ok,
    ).toBe(false)
  })
})

describe('watchCovers', () => {
  const named = [{ repo: 'my-thing', refs: ['refs/heads/main'] }]
  const whole = [{ repo: 'my-thing' }]

  test('a named ref matches only itself', () => {
    expect(watchCovers(named, { repo: 'my-thing', ref: 'refs/heads/main' })).toBe(true)
    expect(watchCovers(named, { repo: 'my-thing', ref: 'refs/heads/other' })).toBe(false)
    expect(watchCovers(named, { repo: 'other', ref: 'refs/heads/main' })).toBe(false)
  })

  test('an omitted ref list covers every ref in that repository', () => {
    expect(watchCovers(whole, { repo: 'my-thing', ref: 'refs/heads/anything' })).toBe(true)
    expect(watchCovers(whole, { repo: 'other', ref: 'refs/heads/anything' })).toBe(false)
  })

  test('watchedRepos is what the handshake has to look up', () => {
    expect(watchedRepos([{ repo: 'a' }, { repo: 'a', refs: [] }, { repo: 'b' }])).toEqual([
      'a',
      'b',
    ])
  })
})

describe('handshake', () => {
  const refsByRepo = {
    'my-thing': { 'refs/heads/main': SHA_A, 'refs/heads/dev': SHA_B },
  }

  test('answers with current state, so connect and catch-up are one operation', () => {
    expect(handshake([{ repo: 'my-thing', refs: ['refs/heads/main'] }], refsByRepo)).toEqual({
      ok: true,
      refs: [{ repo: 'my-thing', ref: 'refs/heads/main', sha: SHA_A }],
    })
  })

  test('a whole-repository watch lists every ref and invents none', () => {
    const answer = handshake([{ repo: 'my-thing' }], refsByRepo)
    expect(answer.refs.map((r) => r.ref)).toEqual(['refs/heads/dev', 'refs/heads/main'])
    expect(handshake([{ repo: 'empty' }], refsByRepo).refs).toEqual([])
  })

  test('a named ref that does not exist is answered, as absent', () => {
    // The client asked about that ref, so "it is not there" is the answer —
    // and it is the same shape a deletion arrives in later.
    expect(handshake([{ repo: 'my-thing', refs: ['refs/heads/nope'] }], refsByRepo).refs).toEqual([
      { repo: 'my-thing', ref: 'refs/heads/nope', sha: null },
    ])
  })
})

describe('eventsFromChanges', () => {
  test('a moved ref carries its new sha', () => {
    expect(
      eventsFromChanges('my-thing', [{ ref: 'refs/heads/main', oldOid: SHA_A, newOid: SHA_B }]),
    ).toEqual([{ repo: 'my-thing', ref: 'refs/heads/main', sha: SHA_B }])
  })

  test('a deletion is null, not the zero oid', () => {
    // A client comparing shas must never have to know the zero oid is not a
    // commit.
    expect(
      eventsFromChanges('my-thing', [{ ref: 'refs/heads/gone', oldOid: SHA_A, newOid: ZERO_OID }]),
    ).toEqual([{ repo: 'my-thing', ref: 'refs/heads/gone', sha: null }])
  })

  test('non-ref updates are not events', () => {
    expect(eventsFromChanges('my-thing', [{ ref: 'HEAD', oldOid: SHA_A, newOid: SHA_B }])).toEqual(
      [],
    )
  })
})

describe('the wire', () => {
  test('carries no cursor of any kind', () => {
    // ADR-0009: events are latest state. A `seq` or a `since` on the wire would
    // be a promise of replay, and a second source of truth beside index.json.
    const wire = [
      encode(
        handshake([{ repo: 'r', refs: ['refs/heads/main'] }], {
          r: { 'refs/heads/main': SHA_A },
        }),
      ),
      encode({ repo: 'r', ref: 'refs/heads/main', sha: SHA_B }),
      encode({ repo: 'r', ref: 'refs/heads/main', sha: null }),
    ].join('\n')

    for (const forbidden of ['seq', 'since', 'cursor', 'offset', 'version']) {
      expect(wire).not.toContain(forbidden)
    }
  })

  test('the paths are the ones the Worker routes and the container does not', () => {
    expect(EVENTS_PATH).toBe('/_walgit/events')
    expect(ANNOUNCE_PATH).toBe('/_walgit/announce')
  })
})

describe('caps', () => {
  // A client over the cap has to know how far over it is to split its
  // subscription; a bare limit makes it guess.
  test('a subscribe over the cap names the cap and the count asked for', () => {
    const watch = Array.from({ length: MAX_WATCH_ENTRIES + 3 }, (_, i) => ({
      repo: `repo-${i}`,
    }))
    const parsed = parseWatch(JSON.stringify({ watch }))

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain(String(MAX_WATCH_ENTRIES))
    expect(parsed.error).toContain(String(MAX_WATCH_ENTRIES + 3))
  })

  test('exactly the cap is allowed', () => {
    const watch = Array.from({ length: MAX_WATCH_ENTRIES }, (_, i) => ({ repo: `repo-${i}` }))
    expect(parseWatch(JSON.stringify({ watch })).ok).toBe(true)
  })

  test('too many refs names the cap, the count and the repository', () => {
    const refs = Array.from({ length: MAX_REFS_PER_ENTRY + 1 }, (_, i) => `refs/heads/b${i}`)
    const parsed = parseWatch(JSON.stringify({ watch: [{ repo: 'demo', refs }] }))

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain(String(MAX_REFS_PER_ENTRY))
    expect(parsed.error).toContain(String(MAX_REFS_PER_ENTRY + 1))
    expect(parsed.error).toContain('demo')
  })
})

describe('no wildcard', () => {
  // A wildcard on a public deployment is a firehose of strangers' pushes, so
  // there is no spelling of one: every entry names a repository, and the
  // repo-id gate rejects the characters a wildcard would need.
  test.each(['*', '**', 'a*', '.*', '%', 'all', 'demo/*'])(
    'rejects %p as a repository name',
    (repo) => {
      const parsed = parseWatch(JSON.stringify({ watch: [{ repo }] }))
      if (repo === 'all') {
        // A repository genuinely named "all" is a repository, not a wildcard.
        expect(parsed.ok).toBe(true)
        return
      }
      expect(parsed.ok).toBe(false)
    },
  )

  test('there is no watch form that omits the repository', () => {
    expect(parseWatch(JSON.stringify({ watch: [{}] })).ok).toBe(false)
    expect(parseWatch(JSON.stringify({ watch: [{ refs: ['refs/heads/main'] }] })).ok).toBe(false)
    expect(parseWatch(JSON.stringify({ watch: 'all' })).ok).toBe(false)
  })
})

describe('reconnecting after a drop', () => {
  // What makes closing a slow subscriber safe: no history is owed, so the
  // client that comes back is immediately correct from its handshake alone.
  test('the handshake carries current state, whatever was missed', () => {
    const watch = [{ repo: 'demo', refs: ['refs/heads/main'] }]
    const answer = handshake(watch, { demo: { 'refs/heads/main': SHA_B } })

    expect(answer.refs).toEqual([{ repo: 'demo', ref: 'refs/heads/main', sha: SHA_B }])
  })
})
