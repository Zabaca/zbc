import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { clearBootResidue } from './boot-residue'
import { lockPath, markerPath } from './materialize'
import { pendingDir, pendingPath } from './pending'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function reposDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-residue-'))
  dirs.push(dir)
  return dir
}

describe('clearBootResidue', () => {
  test('removes a dead push’s hand-off record and a held materialize lock', () => {
    // The disk a snapshot restores: a record naming a pid that, in the new
    // container, may be alive again as somebody else — and a lock nobody holds.
    const root = reposDir()
    const gitDir = path.join(root, 'alpha.git')
    fs.mkdirSync(pendingDir(gitDir), { recursive: true })
    fs.writeFileSync(pendingPath(gitDir, 42), JSON.stringify({ pid: 42, ts: Date.now() }))
    fs.mkdirSync(lockPath(gitDir))

    const result = clearBootResidue(root)

    expect(result.repos).toBe(1)
    expect(fs.existsSync(pendingDir(gitDir))).toBe(false)
    expect(fs.existsSync(lockPath(gitDir))).toBe(false)
  })

  test('keeps the materialize marker — that is evidence, not process state', () => {
    // An interrupted restore left it, and `syncRepo` trusts it over the refs.
    const root = reposDir()
    const gitDir = path.join(root, 'alpha.git')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(markerPath(gitDir), '')

    expect(clearBootResidue(root).cleared).toEqual([])
    expect(fs.existsSync(markerPath(gitDir))).toBe(true)
  })

  test('an empty or absent disk is nothing to do', () => {
    expect(clearBootResidue(path.join(reposDir(), 'missing'))).toEqual({ repos: 0, cleared: [] })
    expect(clearBootResidue(reposDir())).toEqual({ repos: 0, cleared: [] })
  })
})
