import { describe, expect, test } from 'bun:test'
import { renderInstructions } from './instructions'

const PUBLIC = {
  publicAccess: true,
  appendOnly: true,
  retentionHours: 24,
  maxPushBytes: 99 * 1024 * 1024,
  maxRepoBytes: 250 * 1024 * 1024,
  events: true,
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
    // The three messages, in the order a client sees them.
    expect(text).toContain('{"watch":[{"repo":"$NAME","refs":["refs/heads/main"]}]}')
    expect(text).toContain('"ok":true')
    expect(text).toContain('"sha":"d4e5f6..."')
    // Latest state, stated as such: an agent told about a cursor would build a
    // client this server cannot serve.
    expect(text.replace(/\s+/g, ' ')).toContain('no cursor and no replay')
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
describe('the watch section carries a runnable client', () => {
  test('with events on, a background client is spelled out', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: true })
    expect(text).toContain('wss://walgit.example/_walgit/events')
    expect(text).toContain('Bun.spawnSync(["git","fetch"])')
    expect(text).toContain('examples/watch.ts')
  })

  test('with events off, nothing about a client is claimed', () => {
    const text = renderInstructions('https://walgit.example', { ...PUBLIC, events: false })
    expect(text).not.toContain('_walgit/events')
    expect(text).not.toContain('git","fetch"')
  })
})
