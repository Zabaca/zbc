// The fold a fixture message carries is what the inbox's own page makes of its text. A stand-in is only TOLD the fold, so a hand-written one could drift
// from the inbox's code and the screenshots would show a fold the inbox never makes; this checks every message the local fixtures hold against the
// inbox's `readText`, the one function its page and its `messagesWith` both use.
import { describe, expect, test } from 'bun:test'
import { readText } from '../../inbox/src/read'
import { fixtureApps } from '../src/stand-ins'

describe('the fixtures', () => {
  test('give every message the fold the inbox makes of it', () => {
    const { inbox } = fixtureApps(Date.now())
    const threads = inbox.threads()
    let folded = 0
    for (const t of threads) {
      const kept = t.messages ?? []
      for (const [i, m] of kept.entries()) {
        // The fixtures are mail that came in through Gmail, so the inbox reflows the hard wraps of its text.
        const made = readText(m.text, { earlier: kept.slice(0, i).map((e) => e.text), subject: t.subject, viaGmail: true })
        expect([m.id, m.read ?? { visible: m.text, quoted: '' }]).toEqual([m.id, made])
        if (made.quoted !== '') folded++
      }
    }
    // The fixtures hold folds to draw: a thread that quotes, or this proves nothing.
    expect(folded).toBeGreaterThanOrEqual(3)
  })
})
