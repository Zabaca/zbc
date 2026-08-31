import { describe, expect, test } from 'bun:test'
import { renderInstructions } from './instructions'

const PUBLIC = {
  publicAccess: true,
  appendOnly: true,
  retentionHours: 24,
  maxPushBytes: 99 * 1024 * 1024,
  maxRepoBytes: 250 * 1024 * 1024,
  events: true,
  signedPushes: true,
}

describe('renderInstructions', () => {
  test('states every limit the instance enforces, before the example', async () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    // Unwrapped, because the hard wrap is a rendering detail and the claims
    // are what this test is about.
    const beforeExample = text.slice(0, text.indexOf('PUSH A REPOSITORY')).replace(/\s+/g, ' ')

    for (const claim of [
      'world-readable and world-writable',
      'append-only',
      '24 hours after its LAST PUSH',
      '99 MiB',
      '250 MiB',
      'random suffix',
    ]) {
      expect(beforeExample).toContain(claim)
    }
  })

  test('never claims a rule this instance does not enforce', () => {
    const text = renderInstructions('https://walgit.example', {}).replace(/\s+/g, ' ')
    expect(text).not.toContain('append-only')
    expect(text).not.toContain('LAST PUSH')
    expect(text).not.toMatch(/may not exceed/)
    // A stream nobody serves is the same defect as a cap nobody enforces: an
    // agent that reads about it writes a client before finding out.
    expect(text).not.toContain('WebSocket')
    expect(text).not.toContain('watch')
    expect(text).not.toContain('_walgit/events')
    // Signing is the same rule one step earlier: with no nonce seed the host
    // never advertises `push-cert`, so an agent told to sign is refused by its
    // OWN git — a flag that cannot work is worse than one never mentioned.
    expect(text).not.toContain('--signed')
    expect(text).not.toContain('signingkey')
    expect(text).not.toContain('fingerprint')
    expect(text).not.toContain('_walgit/provenance')
    // …and says what an unconfigured instance actually does instead.
    expect(text).toContain('requires a credential')
  })

  test('the example names the origin the agent reached us on', () => {
    expect(renderInstructions('https://walgit.example', PUBLIC)).toContain(
      'git clone https://walgit.example/$NAME.git',
    )
    expect(renderInstructions('http://127.0.0.1:8080', PUBLIC)).toContain(
      'git clone http://127.0.0.1:8080/$NAME.git',
    )
  })

  test('byte caps carry the raw count, so an agent need not guess our rounding', () => {
    const text = renderInstructions('https://walgit.example', { maxPushBytes: 99 * 1024 * 1024 })
    expect(text).toContain('(103809024 bytes)')
  })

  test('an unreadable cap is impossible to state, because policy carries numbers', () => {
    // Guarding the direction rather than the formatting: a limit absent from
    // policy must produce no sentence at all, never "NaN".
    expect(renderInstructions('https://walgit.example', {})).not.toContain('NaN')
  })

  test('with events on, the socket is named in the scheme a socket dials', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    expect(text).toContain('WATCH FOR PUSHES INSTEAD OF FETCHING ON A TIMER')
    // The socket is dialled on the origin the agent reached us on, as a socket
    // scheme — an agent copying `https://` into a WebSocket gets nothing.
    expect(text).toContain('wss://walgit.example/_walgit/events')
    // The wire moved to /llms.txt when a client was published. What this
    // document owes an agent is the socket's address in a scheme a socket can
    // dial, and one command that already speaks it — an agent reading THIS is
    // orienting, not implementing, and every line it keeps is context the agent
    // wanted for the task it interrupted.
    expect(text.replace(/\s+/g, ' ')).toContain('bunx @zabaca/agentgit watch')
    expect(text).not.toContain('{"watch"')
  })

  test('a plain-http origin dials a plain-ws socket', () => {
    expect(renderInstructions('http://127.0.0.1:8080', PUBLIC)).toContain(
      'ws://127.0.0.1:8080/_walgit/events',
    )
  })

  test('is plain text a model can read without parsing anything', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    expect(text).not.toContain('<')
    expect(text.split('\n').every((line) => line.length <= 90)).toBe(true)
  })
})

/**
 * The client in the instructions.
 *
 * The socket is only worth advertising if the next line tells an agent what to
 * do with it. Without this, an agent that finds the stream still has to invent
 * the loop — and inventing it is how you get a poller.
 */
describe('the watch section hands off rather than carrying everything', () => {
  test('with events on, it names the socket and points at the manual', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: true })
    expect(text).toContain('wss://walgit.example/_walgit/events')
    expect(text).toContain('https://walgit.example/llms.txt')
    // The client itself lives in the long document now. This page is read
    // mid-task, and every line it keeps is context an agent wanted elsewhere.
    expect(text).not.toContain('Bun.spawnSync')
  })

  test('with events off, nothing about a client is claimed', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: false })
    expect(text).not.toContain('_walgit/events')
    expect(text).not.toContain('git","fetch"')
  })
})

/**
 * The collision check.
 *
 * An event is only worth more than a timer if it answers the question the
 * fetch was being run for, so `GET /` carries the two commands that answer it.
 */
describe('the collision check is named but not spelled out here', () => {
  // What `GET /` owes an agent is that the check exists and one command that
  // runs it. The commands themselves stay in the long document: this is read
  // mid-task, and every line costs context the agent wanted for the task.
  test('with events on, it is described in one clause and located', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: true })
    const flat = text.replace(/\s+/g, ' ')
    expect(flat).toContain('collides with your uncommitted work')
    // The published client, and the two facts that decide whether an agent
    // reaches for it: no install, and no argument.
    expect(flat).toContain('bunx @zabaca/agentgit watch')
    expect(flat).toContain('--once')
    expect(text).toContain('/llms.txt')
    // The commands are in the long document; repeating them here would put the
    // page back where it was before the split.
    expect(text).not.toContain('merge-tree')
  })

  test('with events off, neither the stream nor the check is mentioned', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: false })
    expect(text).not.toContain('merge-tree')
    expect(text).not.toContain('_walgit/events')
    // But the manual is still worth finding.
    expect(text).toContain('/llms.txt')
  })
})

/**
 * Signing, in the terse document.
 *
 * Three things and no argument: that a push may be signed, the config that
 * signs it, and where the answer is read back. The reasoning — what a
 * fingerprint is taken to mean, and that anonymous stays first-class — is in
 * `/llms.txt`, because an agent reading THIS page is mid-task.
 */
describe('the signing section says it is possible, and not why', () => {
  test('names the flag, the config and the read-back endpoint', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    expect(text).toContain('SIGN A PUSH, AND BE CREDITED FOR IT')
    // `if-asked`, never `yes`: one form is correct against every host, and an
    // agent that learns `--signed=yes` here fails against hosts without a seed.
    expect(text).toContain('--signed=if-asked')
    expect(text).not.toContain('--signed=yes')
    expect(text).toContain('gpg.format=ssh')
    expect(text).toContain('https://walgit.example/_walgit/provenance?repo=$NAME')
  })

  test('says the one thing an agent must not have to look up: nothing is refused', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC).replace(/\s+/g, ' ')
    expect(text).toContain('Nothing is refused for being unsigned.')
  })

  test('…and stops saying it once a name can refuse an unsigned push', () => {
    // One clause, not a section: the page has a byte budget and ADR-0012 put
    // discovery in /llms.txt and in the refusal itself. What it cannot do is go
    // on promising the opposite of what `pre-receive` does.
    const text = renderInstructions('https://walgit.example', {
      ...PUBLIC,
      signerLists: true,
    }).replace(/\s+/g, ' ')
    expect(text).toContain('Signer List')
    expect(text).not.toContain('Nothing is refused for being unsigned.')
  })

  /**
   * The access bullet, which is the other promise the gate falsifies — and the
   * one an agent reads first, before it has decided to sign anything.
   *
   * Read from `signerLists` ALONE, unlike the clause above it: `pre-receive`
   * refuses on this flag by itself (`signerListsEnabled`, `src/hook-main.ts`),
   * so on a deployment that sets it with no nonce seed a claimed name refuses
   * EVERY push — which makes unconditional writability more wrong, not less.
   */
  test('the access bullet stops promising a write nobody can make', () => {
    const text = renderInstructions('https://walgit.example', {
      ...PUBLIC,
      signerLists: true,
    }).replace(/\s+/g, ' ')
    expect(text).not.toContain('world-readable and world-writable')
    expect(text).toContain('Anyone may push, with no credential, unless a name holds a Signer List')
    // The half that was NOT traded away for the correction. This page renders
    // three bytes under its budget, so the sentence had to be bought — and the
    // clause that catches the case an agent has not thought of is not where a
    // warning about secrets goes looking for savings.
    expect(text).toContain('or anything you would not publish')
  })

  test('and it is corrected on the flag alone, with no nonce seed', () => {
    const text = renderInstructions('https://walgit.example', {
      publicAccess: true,
      signerLists: true,
    }).replace(/\s+/g, ' ')
    expect(text).not.toContain('world-readable and world-writable')
    expect(text).toContain('unless a name holds a Signer List')
    // Without teaching any of it: no ref, no command, no way in. ADR-0012 put
    // that in /llms.txt and in the refusal, and the seedless deployment could
    // not act on it anyway.
    expect(text).not.toContain('refs/walgit/signers')
    expect(text).not.toContain('--signed')
  })

  test('with no seed, the capability does not exist on the page', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, signedPushes: false })
    expect(text).not.toContain('SIGN A PUSH')
    expect(text).not.toContain('--signed')
    expect(text).not.toContain('_walgit/provenance')
  })

  test('the argument stays in the long document', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    // The page is read mid-task; a paragraph on what a key does and does not
    // prove is exactly the kind of line the split exists to move.
    expect(text).not.toContain('push certificate')
    expect(text).not.toContain('allowed signers')
  })
})

/**
 * Ownership, which this page does not teach — in either state.
 *
 * ADR-0012 put discovery in `/llms.txt` and in the refusal message, and this is
 * the assertion that keeps it there. The reason is ADR-0011's own: signing had
 * to be on the front door because its failure lands client-side, after the
 * agent has already written the push, whereas ownership's failure lands on our
 * server, in our words, at the moment it is relevant. The refusal teaches; this
 * page does not have to, and it has no bytes to teach with.
 */
describe('the terse document never explains how to hold a name', () => {
  const EVERYTHING = { ...PUBLIC, signerLists: true }

  test('it names no ref, no file, no fingerprint and no command', () => {
    for (const policy of [PUBLIC, EVERYTHING]) {
      // Lowercased, because this document SHOUTS its headings: a `GRANT AND
      // REVOKE` section would walk straight past a lowercase needle.
      const text = renderInstructions('https://walgit.example', policy).toLowerCase()
      for (const teaching of [
        'refs/walgit/signers',
        'ssh-keygen',
        'sha256:',
        'ls-remote',
        'grant',
        'revoke',
        // Not "claim": the name-collision rule has said "claimed first-come"
        // since before ownership existed, and it is about naming, not holding.
        'hold a name',
      ]) {
        expect(text).not.toContain(teaching)
      }
    }
  })

  /**
   * The budget, stated where the document it constrains lives.
   *
   * It is a real constraint rather than a round number: this text is what an
   * agent pays for mid-task, out of the context it wanted to spend on the task.
   * Every capability so far has arrived believing it was "just three lines", so
   * the version measured is the one claiming the most.
   */
  test('and stays inside its budget with every capability on', () => {
    // The real host rather than the short one the rest of this file uses: the
    // origin is printed six times, so a test measuring `walgit.example` would
    // hold a budget the deployment does not have.
    //
    // It renders 2,992 bytes today — eight under. Whatever breaks this did not
    // break the budget, it spent the last of it: the fix is to decide what
    // comes OUT of this page, not to raise the number. The five bytes it
    // regained were bought, not found: the access bullet dropped its opening
    // summary — "Everything here is public." said in five words what
    // "world-readable" says three words later — to pay for the Signer List
    // clause without touching the warning about secrets.
    const text = renderInstructions('https://agentgit.zabaca.com', EVERYTHING)
    expect(text.length).toBeLessThan(3000)
  })
})
