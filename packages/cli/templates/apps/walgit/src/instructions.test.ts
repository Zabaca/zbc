import { describe, expect, test } from 'bun:test'
import { renderInstructions } from './instructions'

const PUBLIC = {
  publicAccess: true,
  appendOnly: true,
  retentionHours: 24,
  maxPushBytes: 99 * 1024 * 1024,
  maxRepoBytes: 250 * 1024 * 1024,
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

  test('is plain text a model can read without parsing anything', () => {
    const text = renderInstructions('https://walgit.example', PUBLIC)
    expect(text).not.toContain('<')
    expect(text.split('\n').every((line) => line.length <= 90)).toBe(true)
  })
})
