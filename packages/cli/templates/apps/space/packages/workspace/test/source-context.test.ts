import { describe, expect, test } from 'bun:test'
import { classify, CODE, COMMENT, kindOf, STRING } from '../src/source-context'

/** The text of `text` that the scanner calls `what`, joined: what a reader of the check would call a comment, a string or code. */
const only = (path: string, text: string, what: number) =>
  [...text]
    .filter((_, index) => classify(path, text).mask[index] === what)
    .join('')
    .trim()

describe('what kind of file it is', () => {
  test('by extension, and by name where there is none', () => {
    expect(['a.ts', 'a.tsx', 'a.mjs', 'a.astro', 'a.css'].map(kindOf)).toEqual(['code', 'code', 'code', 'code', 'code'])
    expect(['a.md', 'a.txt', 'README', 'LICENSE', 'docs/CONTEXT.md'].map(kindOf)).toEqual(['markdown', 'markdown', 'markdown', 'markdown', 'markdown'])
    expect(['a.yaml', 'a.toml', 'a.sh', '.gitignore', 'Dockerfile'].map(kindOf)).toEqual(['hash', 'hash', 'hash', 'hash', 'hash'])
    expect(['a.sql', 'a.json', 'a.html', 'a.svg', 'a.unknown', 'Makefile'].map(kindOf)).toEqual(['sql', 'json', 'html', 'html', 'other', 'other'])
  })
})

describe('code', () => {
  test('a line comment, a block comment, and a string of each quote', () => {
    expect(only('a.ts', 'const a = 1 // note\nconst b = "x" /* y */ + \'z\'', COMMENT)).toBe('// note/* y */')
    expect(only('a.ts', 'const b = "x" + \'z\' + `w`', STRING)).toBe('"x"\'z\'`w`')
  })

  test('a double slash after a colon is a URL, not a comment, and inside a string it is text', () => {
    expect(only('a.ts', 'const u = "https://a.example/x" // end', COMMENT)).toBe('// end')
    expect(only('a.ts', 'go(https://a.example)', COMMENT)).toBe('')
  })

  test('a template string keeps its kind across lines, and the code inside ${} is code again', () => {
    const text = 'const q = `a ${b.value} c\nd`\nconst e = f.value'
    expect(only('a.ts', text, STRING)).toBe('`a ${} c\nd`')
    expect(only('a.ts', text, CODE)).toContain('b.value')
    expect(only('a.ts', text, CODE)).toContain('f.value')
  })

  test('a single-quoted string ends at its line, so one stray apostrophe does not swallow the file', () => {
    expect(only('a.tsx', "<p>Don't</p>\nconst a = b.value", CODE)).toContain('b.value')
  })

  test('a regular expression with a slash or a quote in it is skipped by its escape', () => {
    expect(only('a.ts', 'const r = /https?:\\/\\/a/ // after', COMMENT)).toBe('// after')
  })

  test('a line that begins with * outside any comment is read as a comment, as a pasted doc-comment line is', () => {
    expect(only('a.ts', ' * since the start', COMMENT)).toBe('* since the start')
  })

  test('an HTML comment is a comment in a component file only', () => {
    expect(only('a.astro', '<!-- note --><p/>', COMMENT)).toBe('<!-- note -->')
    expect(only('a.ts', 'const a = 1 <!-- note', COMMENT)).toBe('')
  })
})

describe('regular expressions and JSX', () => {
  test('a quote or a backtick inside a regular expression does not start a string', () => {
    const quote = "const a = /'/.test(s) ? 'x.value' : ''\nconst b = c.value"
    expect(only('a.ts', quote, CODE)).toContain('c.value')
    expect(only('a.ts', quote, STRING)).toBe("'x.value'''")
    const tick = 'const a = s.replace(/`/g, "")\nconst b = c.value'
    expect(only('a.ts', tick, CODE)).toContain('c.value')
    expect(only('a.ts', 'if (/"/.test(s)) go("a.b")\nconst z = c.value', CODE)).toContain('c.value')
  })

  test('a slash after a value is a division, and a slash after an operator, a bracket or return is a regular expression', () => {
    expect(only('a.ts', 'const a = b / c // note', COMMENT)).toBe('// note')
    expect(only('a.ts', "return /'/.test(s) // note", COMMENT)).toBe('// note')
    expect(only('a.ts', 'const r = [/a\\/b/, /[/]/] // note', COMMENT)).toBe('// note')
  })

  test('text between JSX tags is prose, an apostrophe in it starts nothing, and an expression in it is code again', () => {
    const jsx = "const a = <p>We're at {x.value} today</p>\nconst b = c.value"
    expect(only('a.tsx', jsx, STRING)).toContain("We're at")
    expect(only('a.tsx', jsx, STRING)).toContain('today')
    expect(only('a.tsx', jsx, CODE)).toContain('x.value')
    expect(only('a.tsx', jsx, CODE)).toContain('c.value')
    expect(only('a.tsx', "return <p>We're at {'x.example.com'}</p>", STRING)).toContain("'x.example.com'")
  })

  test('JSX nests: text after a closing tag belongs to the parent, and a self-closing tag opens nothing', () => {
    const jsx = 'const a = (\n  <div>\n    <b>one</b> two\n    <img src="a.png" />\n    three\n  </div>\n)\nconst b = c.value'
    const strings = only('a.tsx', jsx, STRING)
    for (const word of ['one', 'two', 'three']) expect(strings).toContain(word)
    expect(only('a.tsx', jsx, CODE)).toContain('c.value')
  })

  test('a generic parameter list in a tsx file is not a tag: with extends, with a trailing comma, with a default', () => {
    for (const generic of ['<T extends Element = HTMLElement>(testid: string) => x', '<T,>(x: T) => x', '<T = string>(x: T) => x', '<Key extends string>(k: Key) => k']) {
      const text = `const f = ${generic}\nconst d = e.value`
      expect([generic, only('a.tsx', text, CODE)]).toEqual([generic, expect.stringContaining('e.value')])
      expect(only('a.tsx', text, STRING)).toBe('')
    }
  })

  test('a slash after ++ or -- divides, so a comment after it is a comment', () => {
    expect(only('a.ts', 'const a = i++ / 2 // comment', COMMENT)).toBe('// comment')
    expect(only('a.ts', 'const a = i-- / 2 // comment', COMMENT)).toBe('// comment')
    expect(only('a.ts', 'const a = i++ /2/ 3 // comment', COMMENT)).toBe('// comment')
  })

  test('a comparison, a generic and an arrow function are not tags', () => {
    expect(only('a.tsx', 'const a = b < c ? 1 : 2\nconst d = e.value', CODE)).toContain('e.value')
    expect(only('a.tsx', 'const a = useState<string>("x")\nconst d = e.value', CODE)).toContain('e.value')
    expect(only('a.tsx', 'const f = (x: number) => x > 1\nconst d = e.value', CODE)).toContain('e.value')
  })

  test('JSX is read in tsx and jsx files only', () => {
    expect(only('a.ts', 'const a = <p>text</p>', STRING)).toBe('')
  })
})

describe('other kinds', () => {
  test('# begins a comment in shell, YAML and TOML only after whitespace, and not inside a quote', () => {
    expect(only('a.sh', 'echo "a#b" # c\nurl=x#y', COMMENT)).toBe('# c')
    expect(only('a.yaml', '# top\nk: v # trailing', COMMENT)).toBe('# top# trailing')
  })

  test('-- begins a comment in SQL, and a quoted -- does not', () => {
    expect(only('a.sql', "SELECT '--' -- note", COMMENT)).toBe('-- note')
  })

  test('Markdown prose is the comment kind, a fenced block is read by its language and inline code is a string', () => {
    const text = 'Prose `inline` more.\n\n```ts\nconst a = 1\n```\n\nAfter.'
    expect(only('a.md', text, CODE)).toContain('const a = 1')
    expect(only('a.md', text, STRING)).toBe('`inline`')
    expect(only('a.md', text, COMMENT)).toContain('Prose')
    expect(only('a.md', text, COMMENT)).toContain('After.')
  })

  test('a fence is scanned by its language: code, data, script, or as plain text when it has none', () => {
    const fenced = (language: string, body: string) => '```' + language + '\n' + body + '\n```'
    expect(only('a.md', fenced('ts', 'const a = b.value // note'), COMMENT)).toContain('// note')
    expect(only('a.md', fenced('ts', 'const a = "x"'), STRING)).toContain('"x"')
    expect(only('a.md', fenced('json', '{ "host": "x" }'), CODE)).toBe('```json```')
    expect(only('a.md', fenced('sh', 'dig +short MX x # c'), COMMENT)).toContain('# c')
    expect(only('a.md', fenced('sh', 'dig +short MX x'), STRING)).toContain('dig +short MX x')
    expect(only('a.md', fenced('', 'anything'), STRING)).toBe('anything')
    expect(only('a.md', fenced('tsx', 'const a = <p>Visit it</p>'), STRING)).toContain('Visit it')
  })

  test('a longer fence holds a shorter one, and what follows the outer fence is prose again', () => {
    const text = '````md\n```ts\nconst a = 1\n```\nstill inside\n````\n\nAfter the fence.'
    expect(only('a.md', text, COMMENT)).toContain('After the fence.')
    expect(only('a.md', text, CODE)).toContain('const a = 1')
    expect(only('a.md', '~~~\n```\ninside\n~~~\nafter', COMMENT)).toBe('after')
  })

  test('a fence that is never closed holds the rest of the file, as Markdown says', () => {
    expect(only('a.md', 'Before.\n```ts\nconst a = 1\nmore', COMMENT)).toBe('Before.')
  })

  test('a file of a kind with no comments is all string, so a name in it is read as written', () => {
    expect(only('a.unknown', 'a b', STRING)).toBe('a b')
  })
})
