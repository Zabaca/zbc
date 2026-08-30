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

  test('with events on, the stream is described with its wire format', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    expect(text).toContain('WATCH FOR PUSHES INSTEAD OF FETCHING ON A TIMER')
    // The socket is dialled on the origin the agent reached us on, as a socket
    // scheme — an agent copying `https://` into a WebSocket gets nothing.
    expect(text).toContain('wss://walgit.example/_walgit/events')
    // The send/recv transcript moved to /llms.txt. What stays is the socket,
    // the one message that starts it, and a sentence saying what comes back —
    // an agent reading THIS document is orienting, not implementing.
    expect(text).toContain('{"watch":[{"repo":"$NAME"}]}')
    expect(text.replace(/\s+/g, ' ')).toContain('the current sha of everything you named')
    // Latest state, stated as such: an agent told about a cursor would build a
    // client this server cannot serve.
    expect(text.replace(/\s+/g, ' ').toLowerCase()).toContain('no cursor and no replay')
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
  test('with events on, it is described in one clause and located', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: true })
    expect(text.replace(/\s+/g, ' ')).toContain('whether what arrived touches your work')
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
