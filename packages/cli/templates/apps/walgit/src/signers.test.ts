/**
 * The Signer List decision, and the words it produces.
 *
 * Every case here is a table entry over pure inputs — no keypair, no
 * subprocess, no repository, no server. That is the point of the seam: what a
 * push does to a repository's list is decided from the file's bytes and the ref
 * changes, and a test that needed a real `git push` to ask the question would
 * be testing git.
 *
 * The messages are asserted on because they are product copy: for the agent
 * that just failed to claim a name, the refusal is the entire documentation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { SIGNERS_REF, ZERO_OID } from '../shared/protocol'
import { git, gitOrThrow } from './git'
import {
  checkSignerList,
  gitSignersSource,
  MAX_SIGNER_LIST_BYTES,
  parseSignerList,
  signerListsEnabled,
  type SignersFile,
  type SignersSource,
} from './signers'
import type { RefChange } from './wal-index'

const KEY_A = 'SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw'
const KEY_B = 'SHA256:0000MXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw'
const OID = 'a'.repeat(40)
const OTHER_OID = 'b'.repeat(40)

/** A list of `count` distinct, well-formed fingerprints — 51 bytes per line. */
const listOf = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `SHA256:${String(i).padStart(6, '0')}${'A'.repeat(37)}`,
  ).join('\n') + '\n'

const change = (ref: string, newOid = OID, oldOid = ZERO_OID): RefChange => ({
  ref,
  oldOid,
  newOid,
})

/** A source that hands back one file for any oid, or one refusal. */
const source =
  (file: SignersFile): SignersSource =>
  () =>
    file
const holding = (text: string) => source({ found: true, text })

describe('the flag', () => {
  test('is off unless the instance sets it', () => {
    expect(signerListsEnabled({})).toBe(false)
    expect(signerListsEnabled({ WALGIT_SIGNER_LISTS: '' })).toBe(false)
    expect(signerListsEnabled({ WALGIT_SIGNER_LISTS: '0' })).toBe(false)
    expect(signerListsEnabled({ WALGIT_SIGNER_LISTS: 'yes' })).toBe(false)
  })

  test('is on for the two spellings every walgit flag accepts', () => {
    expect(signerListsEnabled({ WALGIT_SIGNER_LISTS: '1' })).toBe(true)
    expect(signerListsEnabled({ WALGIT_SIGNER_LISTS: 'true' })).toBe(true)
  })

  test('is its own variable, not a consequence of the push-certificate seed', () => {
    // Ownership is a server-side refusal with no client-side coupling, so it
    // must not arrive on a running deployment as a side effect of the seed that
    // turned signing on (docs/adr/0012).
    expect(signerListsEnabled({ WALGIT_PUSH_CERT_SEED: 'a-real-seed' })).toBe(false)
  })
})

describe('parseSignerList', () => {
  const reads = (text: string) => {
    const parsed = parseSignerList(text)
    if (!parsed.ok) throw new Error(`expected a readable list, got line ${parsed.lineNumber}`)
    return parsed.signers
  }

  const cases: [name: string, text: string, signers: string[]][] = [
    ['one key', `${KEY_A}\n`, [KEY_A]],
    ['a file with no trailing newline', KEY_A, [KEY_A]],
    ['two keys, in the order the file names them', `${KEY_B}\n${KEY_A}\n`, [KEY_B, KEY_A]],
    ['blank lines', `\n${KEY_A}\n\n\n${KEY_B}\n\n`, [KEY_A, KEY_B]],
    ['whole-line comments', `# the laptop\n${KEY_A}\n#nothing\n`, [KEY_A]],
    ['a comment trailing a key', `${KEY_A} # alice's laptop\n`, [KEY_A]],
    ['surrounding whitespace', `   ${KEY_A}\t\n`, [KEY_A]],
    ['carriage returns, from a client on Windows', `${KEY_A}\r\n${KEY_B}\r\n`, [KEY_A, KEY_B]],
    [
      'a duplicate, collapsed to its first mention',
      `${KEY_A}\n${KEY_B}\n${KEY_A}\n`,
      [KEY_A, KEY_B],
    ],
  ]

  for (const [name, text, signers] of cases) {
    test(`reads ${name}`, () => expect(reads(text)).toEqual(signers))
  }

  const empty: [name: string, text: string][] = [
    ['an empty file', ''],
    ['a file of blank lines', '\n\n   \n'],
    ['a file of nothing but comments', '# who may push here\n# nobody yet\n'],
  ]

  for (const [name, text] of empty) {
    test(`reads ${name} as a list of no keys, rather than as an error`, () => {
      // The distinction matters one level up: an empty list is refused for a
      // different reason, in different words, than an unreadable one.
      expect(reads(text)).toEqual([])
    })
  }

  const malformed: [name: string, text: string, line: number][] = [
    ['a truncated fingerprint', `SHA256:tooshort\n`, 1],
    ['a raw public key rather than its fingerprint', `ssh-ed25519 AAAAC3Nz alice\n`, 1],
    ['an allowed-signers line', `alice@example.com ssh-ed25519 AAAAC3Nz\n`, 1],
    ['the MD5 spelling ssh-keygen used to print', `MD5:16:27:ac:a5:76:28:2d:36\n`, 1],
    ['a key with a name after it and no comment marker', `${KEY_A} alice\n`, 1],
    ['a good key followed by a typo, on the typo', `${KEY_A}\nSHA256:oops\n`, 2],
  ]

  for (const [name, text, line] of malformed) {
    test(`refuses ${name} rather than skipping it`, () => {
      // Skipping is the dangerous reading: a typo'd key would drop out
      // silently, and the agent that pushed it would believe it had granted
      // access it had not.
      const parsed = parseSignerList(text)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.lineNumber).toBe(line)
    })
  }
})

describe('checkSignerList', () => {
  test('a push that does not touch the list ref writes none, and is allowed', () => {
    const verdict = checkSignerList('alpha', [change('refs/heads/main')], () => {
      throw new Error('the source must not be consulted for a push that moves no list')
    })
    expect(verdict).toEqual({ ok: true, signers: null })
  })

  test('a push with no ref changes at all writes none, and is allowed', () => {
    expect(checkSignerList('alpha', [], holding(`${KEY_A}\n`))).toEqual({ ok: true, signers: null })
  })

  test('a readable list is resolved to the keys it names', () => {
    const verdict = checkSignerList(
      'alpha',
      [change('refs/heads/main'), change(SIGNERS_REF)],
      holding(`# keys\n${KEY_A}\n${KEY_B}\n${KEY_A}\n`),
    )
    expect(verdict).toEqual({ ok: true, signers: [KEY_A, KEY_B] })
  })

  test('the list is read from the oid the push moves the ref TO', () => {
    const asked: string[] = []
    checkSignerList('alpha', [change(SIGNERS_REF, OTHER_OID, OID)], (oid) => {
      asked.push(oid)
      return { found: true, text: `${KEY_A}\n` }
    })
    expect(asked).toEqual([OTHER_OID])
  })

  test('a push naming the list ref twice is judged on the update that lands last', () => {
    const verdict = checkSignerList(
      'alpha',
      [change(SIGNERS_REF, OID), change(SIGNERS_REF, OTHER_OID, OID)],
      (oid) => ({ found: true, text: oid === OTHER_OID ? `${KEY_B}\n` : `${KEY_A}\n` }),
    )
    expect(verdict).toEqual({ ok: true, signers: [KEY_B] })
  })

  const refused: [name: string, changes: RefChange[], read: SignersSource, kind: string][] = [
    [
      'a list naming no keys',
      [change(SIGNERS_REF)],
      holding('# who may push here\n\n'),
      'empty-list',
    ],
    ['a list file that is empty', [change(SIGNERS_REF)], holding(''), 'empty-list'],
    [
      'a deletion of the list ref',
      [change(SIGNERS_REF, ZERO_OID, OID)],
      holding(`${KEY_A}\n`),
      'empty-list',
    ],
    [
      'a ref pointed straight at a blob',
      [change(SIGNERS_REF)],
      source({ found: false, why: `${SIGNERS_REF} points at blob` }),
      'unreadable-list',
    ],
    [
      'a commit with no signers file in its tree',
      [change(SIGNERS_REF)],
      source({ found: false, why: 'that commit has no file named `signers` in it' }),
      'unreadable-list',
    ],
    [
      'a file holding no readable fingerprint',
      [change(SIGNERS_REF)],
      holding('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 alice@example.com\n'),
      'unreadable-list',
    ],
  ]

  for (const [name, changes, read, kind] of refused) {
    test(`refuses ${name}`, () => {
      const verdict = checkSignerList('alpha', changes, read)
      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.kind).toBe(kind as 'empty-list' | 'unreadable-list')
    })
  }

  test('nothing is refused for being unsigned or for naming a stranger — not yet', () => {
    // This slice records the list and enforces nothing with it. A push by
    // nobody in particular that lists somebody else entirely still lands.
    expect(checkSignerList('alpha', [change(SIGNERS_REF)], holding(`${KEY_B}\n`))).toEqual({
      ok: true,
      signers: [KEY_B],
    })
  })
})

/**
 * The one thing here that cannot be a table entry.
 *
 * `gitSignersSource` IS `git cat-file`, so a double for it would be the bug
 * restated — the same reason `append-only.test.ts` runs its ancestry test
 * against a real repository. Everything that decides anything sits above this
 * and is tested without it.
 */
describe('gitSignersSource', () => {
  let work: string
  let gitDir: string
  let withList = ''
  let withoutList = ''
  let blob = ''
  let asDirectory = ''
  let oversized = ''
  let nearCap = ''

  const nearCapKeys = 1000

  const commit = (message: string): string => {
    gitOrThrow([
      '-C',
      work,
      '-c',
      'user.email=walgit@example.test',
      '-c',
      'user.name=walgit',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      message,
    ])
    return git(['-C', work, 'rev-parse', 'HEAD']).stdout.trim()
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-signers-'))
    gitOrThrow(['init', '--quiet', '--initial-branch=main', work])
    gitDir = path.join(work, '.git')
    withoutList = commit('nothing to do with signers')
    fs.writeFileSync(path.join(work, 'signers'), `# laptop\n${KEY_A}\n`)
    gitOrThrow(['-C', work, 'add', 'signers'])
    withList = commit('claim')
    blob = git(['-C', work, 'rev-parse', `${withList}:signers`]).stdout.trim()

    gitOrThrow(['-C', work, 'rm', '--quiet', 'signers'])
    fs.mkdirSync(path.join(work, 'signers'))
    fs.writeFileSync(path.join(work, 'signers', 'keys'), `${KEY_A}\n`)
    gitOrThrow(['-C', work, 'add', 'signers'])
    asDirectory = commit('a directory where the file should be')

    gitOrThrow(['-C', work, 'rm', '-r', '--quiet', 'signers'])
    fs.writeFileSync(path.join(work, 'signers'), listOf(1400))
    gitOrThrow(['-C', work, 'add', 'signers'])
    oversized = commit('far too many keys')

    fs.writeFileSync(path.join(work, 'signers'), listOf(nearCapKeys))
    gitOrThrow(['-C', work, 'add', 'signers'])
    nearCap = commit('a lot of keys, but not too many')
  })

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  test('reads the signers file out of a commit', () => {
    const file = gitSignersSource(gitDir)(withList)
    expect(file).toEqual({ found: true, text: `# laptop\n${KEY_A}\n` })
  })

  test('and the whole way through, that commit resolves to the key it names', () => {
    expect(
      checkSignerList('alpha', [change(SIGNERS_REF, withList)], gitSignersSource(gitDir)),
    ).toEqual({ ok: true, signers: [KEY_A] })
  })

  test('a commit with no signers file is not a list', () => {
    const file = gitSignersSource(gitDir)(withoutList)
    expect(file.found).toBe(false)
    if (file.found) return
    expect(file.why).toContain('`signers`')
  })

  test('a ref pointed straight at a blob is not a list', () => {
    // The measured reason the list has to be a commit chain: a blob-valued ref
    // fails `merge-base --is-ancestor` with exit 128, which the append-only
    // judge reads as a rewrite — so it could be created once and never edited,
    // leaving no way to grant or revoke (docs/adr/0012).
    const file = gitSignersSource(gitDir)(blob)
    expect(file.found).toBe(false)
    if (file.found) return
    expect(file.why).toContain('blob')
  })

  test('an oid this repository has never heard of is not a list', () => {
    const file = gitSignersSource(gitDir)('f'.repeat(40))
    expect(file.found).toBe(false)
  })

  test('a directory named signers is refused as a directory, not as a missing file', () => {
    // Telling an agent to add a file it demonstrably just pushed is a refusal
    // it cannot act on, which is the same as no refusal at all.
    const file = gitSignersSource(gitDir)(asDirectory)
    expect(file.found).toBe(false)
    if (file.found) return
    expect(file.why).toContain('directory')
  })

  test('a file past the cap is refused unread, naming both numbers', () => {
    // Unread is the point. `git()` buffers a subprocess's output and an
    // oversized read there can come back TRUNCATED with a zero exit — which
    // would resolve a list that is not the one the ref holds, silently, which
    // is the whole failure the strict parser exists to prevent.
    const file = gitSignersSource(gitDir)(oversized)
    expect(file.found).toBe(false)
    if (file.found) return
    expect(file.why).toContain(String(MAX_SIGNER_LIST_BYTES))
    expect(file.why).toMatch(/is \d+ bytes/)
  })

  test('a big-but-allowed file is read whole, to its last key', () => {
    // The other side of the cap: right under it, every byte survives the
    // subprocess. A truncation here would drop keys off the end of the list
    // and nothing downstream would notice.
    const file = gitSignersSource(gitDir)(nearCap)
    expect(file.found).toBe(true)
    if (!file.found) return
    const parsed = parseSignerList(file.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.signers).toHaveLength(nearCapKeys)
  })
})

describe('the refusal', () => {
  const refusalFor = (text: string): string => {
    const verdict = checkSignerList('alpha', [change(SIGNERS_REF)], holding(text))
    if (verdict.ok) throw new Error('expected a refusal')
    return verdict.message
  }

  test('names walgit, the repository and what to push instead', () => {
    const message = refusalFor('')
    expect(message).toStartWith('walgit: refused —')
    expect(message).toContain('alpha')
    expect(message).toContain(SIGNERS_REF)
    expect(message).toContain('`signers`')
  })

  test('shows the format, so the fix needs no other document', () => {
    const message = refusalFor('nonsense\n')
    expect(message).toContain('SHA256:')
    expect(message).toContain('ssh-keygen -lf')
    expect(message).toMatch(/blank lines and `#` comments are ignored/i)
  })

  test('says nothing was uploaded, because nothing was', () => {
    // The refusal runs before the pack reaches the object store, and saying so
    // is what stops an agent hunting for a half-written repository.
    expect(refusalFor('')).toContain('Nothing was uploaded')
  })

  test('an empty list is refused in its own words: this loses the name', () => {
    const message = refusalFor('# nobody\n')
    expect(message).toContain('claimable by anyone')
    expect(message).not.toContain('could not read')
  })

  test('an unreadable list is refused in its own words, quoting the bad line', () => {
    const message = refusalFor(`${KEY_A}\nSHA256:oops\n`)
    expect(message).toContain('line 2')
    expect(message).toContain('SHA256:oops')
    expect(message).toContain('could not read')
  })
})

/**
 * The one property the pure verdict cannot hold on its own: the refusal has to
 * be reached BEFORE the pack is uploaded.
 *
 * That is a fact about where the block sits in `hook-main`, and nothing above
 * this line would notice it moving below `preReceive` — the verdict would still
 * refuse, and the push would still fail, but every refused push would leave an
 * Orphan in the object store, which is the exact cost the placement exists to
 * avoid. So it is asserted where it is decided: the real hook process, a real
 * quarantine holding a real pack, and a store directory that has to still be
 * empty afterwards.
 *
 * A hook process rather than a server, so this stays cheap and needs no port:
 * `pre-receive` is a program git runs with refs on stdin, and that is all it is.
 */
describe('the refusal reaches the pusher before the pack reaches the store', () => {
  let work: string
  let store: string
  let quarantine: string
  let good = ''
  let bad = ''

  const commitSigners = (contents: string, message: string): string => {
    fs.writeFileSync(path.join(work, 'signers'), contents)
    gitOrThrow(['-C', work, 'add', 'signers'])
    gitOrThrow([
      '-C',
      work,
      '-c',
      'user.email=walgit@example.test',
      '-c',
      'user.name=walgit',
      'commit',
      '--quiet',
      '-m',
      message,
    ])
    return git(['-C', work, 'rev-parse', 'HEAD']).stdout.trim()
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-hook-'))
    gitOrThrow(['init', '--quiet', '--initial-branch=main', work])
    good = commitSigners(`${KEY_A}\n`, 'a list walgit can read')
    bad = commitSigners('not a fingerprint\n', 'a list walgit cannot read')
    // A quarantine that looks like one git built: `pre-receive` uploads whatever
    // pack it finds here, so its contents are what a misordered verdict would
    // leak into the store.
    quarantine = path.join(work, 'tmp_objdir-incoming')
    fs.mkdirSync(path.join(quarantine, 'pack'), { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.pack'), 'PACKDATA')
  })

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  const preReceiveHook = async (tip: string) => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-hookstore-'))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'hook-main.ts'), 'pre-receive'],
      {
        stdin: new TextEncoder().encode(`${ZERO_OID} ${tip} ${SIGNERS_REF}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          GIT_DIR: path.join(work, '.git'),
          WALGIT_REPO_ID: 'alpha',
          WALGIT_STORE_DIR: store,
          WALGIT_SIGNER_LISTS: '1',
          GIT_QUARANTINE_PATH: quarantine,
        },
      },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    const uploaded = fs.existsSync(path.join(store, 'repos', 'alpha', 'wal'))
      ? fs.readdirSync(path.join(store, 'repos', 'alpha', 'wal'))
      : []
    fs.rmSync(store, { recursive: true, force: true })
    return { code, stderr, uploaded }
  }

  test('a readable list is accepted, and its pack IS uploaded', async () => {
    // The control. Without it the assertion below could pass because this
    // harness never uploads anything at all.
    const { code, uploaded } = await preReceiveHook(good)
    expect(code).toBe(0)
    expect(uploaded.some((name) => name.endsWith('.pack'))).toBe(true)
  })

  test('an unreadable list is refused, and the store is untouched', async () => {
    const { code, stderr, uploaded } = await preReceiveHook(bad)
    expect(code).toBe(1)
    expect(stderr).toContain('walgit: refused')
    // Not "an orphan that gets collected later" — never written at all, which
    // is what the refusal's own last line promises the pusher.
    expect(uploaded).toEqual([])
  })
})
