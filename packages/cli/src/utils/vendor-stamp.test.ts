import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readStamp, STAMP_FILE, vendorVintage, writeStamp } from './vendor-stamp'

/**
 * The vintage seam: what a project's stamp + its detected distribution mode
 * mean for the lines `zbc apply` prints. Expected strings come from the
 * ticket's requirement, not from re-running the formatter.
 */

describe('vendorVintage', () => {
  test('a subtree project on the CLI version says nothing', () => {
    const v = vendorVintage({
      vendorMode: true,
      cliVersion: '0.14.0',
      stamp: { mode: 'subtree', cliVersion: '0.14.0', coreRef: 'zbc-core-v0.14.0', vendoredAt: '' },
    })
    expect(v.stale).toBe(false)
    expect(v.warnings).toEqual([])
  })

  test('a subtree project behind the CLI names its ref and the fix', () => {
    const v = vendorVintage({
      vendorMode: true,
      cliVersion: '0.14.0',
      stamp: { mode: 'subtree', cliVersion: '0.10.2', coreRef: 'zbc-core-v0.10.2', vendoredAt: '' },
    })
    expect(v.stale).toBe(true)
    const text = v.warnings.join('\n')
    expect(text).toContain('zbc-core-v0.10.2')
    expect(text).toContain('0.14.0')
    expect(text).toContain('zbc update')
  })

  test('a subtree project with no stamp reports an unknown vintage', () => {
    const v = vendorVintage({ vendorMode: true, cliVersion: '0.14.0', stamp: null })
    expect(v.stale).toBe(true)
    expect(v.warnings.join('\n')).toContain('unknown')
  })

  test('copy mode warns on every apply, even on the current CLI version', () => {
    const v = vendorVintage({
      vendorMode: false,
      cliVersion: '0.14.0',
      stamp: { mode: 'copy', cliVersion: '0.14.0', vendoredAt: '' },
    })
    const text = v.warnings.join('\n')
    expect(text).toContain('copy mode')
    expect(text).toContain('zbc init --subtree')
  })
})

describe('the stamp on disk', () => {
  test('round-trips at the project root, outside the subtree prefix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))
    try {
      await writeStamp(root, { mode: 'subtree', cliVersion: '0.14.0', coreRef: 'zbc-core-v0.14.0' })
      expect(STAMP_FILE.startsWith('vendor/')).toBe(false)
      expect(fs.existsSync(path.join(root, STAMP_FILE))).toBe(true)
      const stamp = await readStamp(root)
      expect(stamp?.coreRef).toBe('zbc-core-v0.14.0')
      expect(stamp?.vendoredAt).toBeString()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a corrupt stamp reads as absent rather than throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))
    try {
      fs.writeFileSync(path.join(root, STAMP_FILE), '{not json')
      expect(await readStamp(root)).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the zbc repo itself', () => {
  test('says nothing when the engine is symlinked into the templates it develops', () => {
    const v = vendorVintage({
      vendorMode: false,
      cliVersion: '0.14.0',
      stamp: null,
      engineIsLinked: true,
    })
    expect(v.stale).toBe(false)
    expect(v.warnings).toEqual([])
  })
})

describe('a subtree project whose vendoring did not land', () => {
  test('is told the prefix is missing, not that it should try subtree mode', () => {
    const v = vendorVintage({
      vendorMode: false,
      cliVersion: '0.15.0',
      stamp: {
        mode: 'subtree',
        cliVersion: '0.15.0',
        coreRef: 'zbc-core-v0.15.0',
        vendoredAt: '',
      },
    })
    expect(v.stale).toBe(true)
    const text = v.warnings.join('\n')
    expect(text).toContain('vendor/zbc')
    expect(text).not.toContain('zbc init --subtree')
  })
})

describe('prerelease CLI builds', () => {
  test('a 0.15.0 stamp under a 0.15.0-rc.1 CLI is not silently called current', () => {
    const v = vendorVintage({
      vendorMode: true,
      cliVersion: '0.15.0-rc.1',
      stamp: { mode: 'subtree', cliVersion: '0.15.0', coreRef: 'zbc-core-v0.15.0', vendoredAt: '' },
    })
    expect(v.warnings.length).toBeGreaterThan(0)
  })
})
