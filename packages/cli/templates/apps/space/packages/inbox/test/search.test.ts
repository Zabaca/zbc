import { describe, expect, test } from 'bun:test'
import {
  EXCERPT_CHARS,
  excerptAround,
  highlight,
  likePattern,
  MAX_QUERY_CHARS,
  MAX_TERMS,
  searchTerms,
} from '../src/search'

/** What a typed query means, and the text work a result needs (src/search.ts), by table. */

describe('the words of a query', () => {
  test.each([
    ['dominique', ['dominique']],
    ['  Dominique   QUOTE ', ['dominique', 'quote']],
    ['tab\tand\nnewline', ['tab', 'and', 'newline']],
    ['again again AGAIN', ['again']],
    ['100%_off\\now', ['100%_off\\now']],
    ['', []],
    ['   ', []],
    ['milo_brandt@gmail.com', ['milo_brandt@gmail.com']],
  ])('%j is %j', (raw, expected) => {
    expect(searchTerms(raw)).toEqual(expected)
  })

  test('anything that is not text has no words', () => {
    for (const raw of [undefined, null, 4, {}, ['a']]) expect(searchTerms(raw)).toEqual([])
  })

  test('only the first words count, and only the first characters are read', () => {
    expect(searchTerms('a b c d e f g h')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(searchTerms('a b c d e f g h')).toHaveLength(MAX_TERMS)
    expect(searchTerms('x'.repeat(MAX_QUERY_CHARS + 50))).toEqual(['x'.repeat(MAX_QUERY_CHARS)])
  })
})

describe('the pattern a word becomes', () => {
  test.each([
    ['quote', '%quote%'],
    ['50%', '%50\\%%'],
    ['a_b', '%a\\_b%'],
    ['a\\b', '%a\\\\b%'],
    ["o'brien", "%o'brien%"],
  ])('%s is %s', (term, pattern) => {
    expect(likePattern(term)).toBe(pattern)
  })
})

describe('the line that says why a message matched', () => {
  test.each([
    ['the word is at the start', 'Quote attached, thanks.', ['quote'], 'Quote attached, thanks.'],
    ['case is ignored and the text kept', 'Please SEND the QUOTE', ['quote'], 'Please SEND the QUOTE'],
    ['whitespace is collapsed', 'a\n\n  quote\tfor you', ['quote'], 'a quote for you'],
    ['the earliest of several words', 'one two three', ['three', 'two'], 'one two three'],
    ['nothing found', 'nothing here', ['quote'], null],
    ['no words', 'anything', [], null],
    ['empty text', '', ['quote'], null],
  ])('%s', (_what, text, terms, expected) => {
    expect(excerptAround(text, terms)).toBe(expected)
  })

  test('a long text is cut around the match, with an ellipsis where it was cut', () => {
    const text = `${'before '.repeat(30)}NEEDLE${' after'.repeat(60)}`
    const line = excerptAround(text, ['needle']) as string
    expect(line.startsWith('…')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
    expect(line).toContain('NEEDLE')
    expect(line.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2)
  })

  test('a match near the start keeps the start; one near the end keeps the end', () => {
    const head = excerptAround(`needle ${'x '.repeat(200)}`, ['needle']) as string
    expect(head.startsWith('needle')).toBe(true)
    expect(head.endsWith('…')).toBe(true)
    const tail = excerptAround(`${'x '.repeat(200)}needle`, ['needle']) as string
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.endsWith('needle')).toBe(true)
  })
})

describe('marking the words in a line', () => {
  test.each([
    [
      'one match',
      'Quote for Dana',
      ['quote'],
      [
        ['Quote', true],
        [' for Dana', false],
      ],
    ],
    [
      'two words',
      'Dana sent the quote',
      ['dana', 'quote'],
      [
        ['Dana', true],
        [' sent the ', false],
        ['quote', true],
      ],
    ],
    [
      'the same word twice',
      'a b a',
      ['a'],
      [
        ['a', true],
        [' b ', false],
        ['a', true],
      ],
    ],
    ['overlapping words are one mark', 'quotation', ['quot', 'tation'], [['quotation', true]]],
    ['adjacent words are one mark', 'ab', ['a', 'b'], [['ab', true]]],
    ['no match', 'nothing', ['quote'], [['nothing', false]]],
    ['no words', 'nothing', [], [['nothing', false]]],
    ['empty text', '', ['a'], [['', false]]],
  ])('%s', (_what, text, terms, expected) => {
    expect(highlight(text, terms).map((p) => [p.text, p.hit])).toEqual(expected as [string, boolean][])
  })

  test('the pieces always add back up to the text', () => {
    const text = 'Re: Quote for Dana Reyes <dana@acme.example>'
    expect(
      highlight(text, ['quote', 'dana', 'acme'])
        .map((p) => p.text)
        .join(''),
    ).toBe(text)
  })
})
