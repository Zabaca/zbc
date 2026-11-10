import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Check, formatReport, type Hit, MAX_FILE_BYTES, MissingRoot, packageOf, readTree, runCommand, summarize } from '../src/check-tree'

const hit = (path: string, line: number, kind: string): Hit => ({ path, line, kind, detail: `${kind} found`, text: 'some line of text' })

describe('grouping by package', () => {
  test('a path under packages/ belongs to its package, the deploy kit to its own group, any other path to its first folder', () => {
    expect(packageOf('packages/inbox/src/app.ts')).toBe('inbox')
    expect(packageOf('kit/worker-settings.ts')).toBe('kit')
    expect(packageOf('inbox/src/app.ts')).toBe('inbox')
    expect(packageOf('README.md')).toBe('(root)')
  })
})

describe('the report', () => {
  const hits = [hit('packages/inbox/src/a.ts', 3, 'address'), hit('packages/inbox/src/a.ts', 9, 'phone'), hit('packages/meet/src/b.ts', 1, 'address')]

  test('counts per package and per kind, and totals', () => {
    const { byPackage, totals, kinds } = summarize(hits)
    expect(kinds).toEqual(['address', 'phone'])
    expect(byPackage.map((group) => [group.name, group.hits, group.lines, group.files, group.kinds])).toEqual([
      ['inbox', 2, 2, 1, { address: 1, phone: 1 }],
      ['meet', 1, 1, 1, { address: 1, phone: 0 }],
    ])
    expect(totals).toEqual({ hits: 3, lines: 3, files: 2, kinds: { address: 2, phone: 1 } })
  })

  test('the full report lists hits by package, file and line; the summary only counts', () => {
    const scanned = { checked: 10, skipped: { binary: 1, large: 0 } }
    const full = formatReport('a check', hits, scanned, { summary: false })
    expect(full).toContain('== inbox')
    expect(full).toContain('packages/inbox/src/a.ts')
    expect(full).toMatch(/\n\s+3\s+address/)
    expect(full).toContain('a check: 3 hit(s) on 3 line(s) in 2 of 10 text file(s) (skipped 1 binary, 0 over 2 MB)')
    const summary = formatReport('a check', hits, scanned, { summary: true })
    expect(summary).not.toContain('packages/inbox/src/a.ts')
    expect(summary).toContain('package')
    expect(summary).toMatch(/total\s+3\s+3\s+2\s+2\s+1/)
  })

  test('no hits is one line', () => {
    expect(formatReport('a check', [], { checked: 4, skipped: { binary: 0, large: 0 } }, { summary: true })).toBe('a check: 0 hit(s) on 0 line(s) in 0 of 4 text file(s) (skipped 0 binary, 0 over 2 MB)')
  })
})

describe('reading a tree', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-tree-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('text files are read; binaries, build output, installed packages, secrets and oversized files are skipped and counted', () => {
    mkdirSync(join(root, 'pkg/src'), { recursive: true })
    mkdirSync(join(root, 'pkg/node_modules/dep'), { recursive: true })
    mkdirSync(join(root, 'pkg/dist'), { recursive: true })
    writeFileSync(join(root, 'pkg/src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'pkg/README.md'), '# pkg\n')
    writeFileSync(join(root, 'pkg/node_modules/dep/index.js'), 'x')
    writeFileSync(join(root, 'pkg/dist/out.js'), 'x')
    writeFileSync(join(root, 'pkg/.env'), 'SECRET=1')
    writeFileSync(join(root, 'pkg/.dev.vars'), 'SECRET=1')
    writeFileSync(join(root, 'pkg/logo.png'), Buffer.from([137, 80, 78, 71]))
    writeFileSync(join(root, 'pkg/data.dat'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(root, 'pkg/huge.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))
    const { files, skipped } = readTree(root, ['pkg'])
    expect(files.map((file) => file.path)).toEqual(['pkg/README.md', 'pkg/src/a.ts'])
    expect(files[1]?.text).toBe('export const a = 1\n')
    expect(skipped).toEqual({ binary: 4, large: 1 })
  })

  test('a root that is not a folder is an error, not an empty scan', () => {
    expect(() => readTree(root, ['nothing-here'])).toThrow(MissingRoot)
    writeFileSync(join(root, 'a-file.txt'), 'x')
    expect(() => readTree(root, ['a-file.txt'])).toThrow(MissingRoot)
  })
})

describe('the command', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-command-'))
    mkdirSync(join(root, 'packages/space'), { recursive: true })
    writeFileSync(join(root, 'packages/space/a.txt'), 'fine\nBAD here\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const check: Check = (file) => file.text.split('\n').flatMap((text, index) => (text.includes('BAD') ? [{ path: file.path, line: index + 1, kind: 'bad', detail: 'found BAD', text }] : []))
  const run = (argv: string[], repoRoot = root) => {
    const out: string[] = []
    const err: string[] = []
    const code = runCommand('a check', check, argv, repoRoot, { out: (line) => out.push(line), err: (line) => err.push(line) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  test('a folder named by path is scanned whole and reported relative to it; without --strict a hit exits 0', () => {
    const { code, out } = run([join(root, 'packages/space')])
    expect(code).toBe(0)
    expect(out).toContain('a check: 1 hit(s) on 1 line(s) in 1 of 1 text file(s)')
    expect(out).toContain('a.txt')
  })

  test('--summary prints counts without the lines', () => {
    const { out } = run(['--summary', join(root, 'packages/space')])
    expect(out).toContain('total')
    expect(out).not.toContain('found BAD')
  })

  test('--strict exits 1 on a hit and 0 on a clean tree', () => {
    expect(run(['--strict', join(root, 'packages/space')]).code).toBe(1)
    writeFileSync(join(root, 'packages/space/a.txt'), 'fine\n')
    expect(run(['--strict', join(root, 'packages/space')]).code).toBe(0)
  })

  test('--strict exits 1 when no file was checked, and says so', () => {
    mkdirSync(join(root, 'empty'))
    const { code, err } = run(['--strict', join(root, 'empty')])
    expect(code).toBe(1)
    expect(err).toContain('no file was checked')
    expect(run([join(root, 'empty')]).code).toBe(0)
  })

  test('a folder that does not exist is a usage error (exit 2), strict or not, and nothing is reported as clean', () => {
    for (const argv of [[join(root, 'missing')], ['--strict', join(root, 'missing')]]) {
      const { code, out, err } = run(argv)
      expect(code).toBe(2)
      expect(out).toBe('')
      expect(err).toContain('not a folder')
    }
  })

  test('with no folder named, the space’s own folder is scanned whole, and one that is not there is an error', () => {
    const { code, out } = run(['--strict'])
    expect(code).toBe(1)
    expect(out).toContain('packages/space/a.txt')
    expect(run([], join(root, 'missing')).code).toBe(2)
    expect(run([], join(root, 'missing')).err).toContain('not a folder')
  })

  test('an option it does not know is a usage error', () => {
    const { code, err } = run(['--stict'])
    expect(code).toBe(2)
    expect(err).toContain('unknown option --stict')
  })
})
