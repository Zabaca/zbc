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
  checkSignerAllowed,
  checkSignerList,
  describeSigner,
  gitSignersSource,
  MAX_SIGNER_LIST_BYTES,
  parseSignerList,
  signerListsEnabled,
  type PushSigner,
  type GateRefusal,
  type ListRefusal,
  type SignersFile,
  type SignersSource,
} from './signers'
import { FileStore } from './store'
import { commitIndex, emptyIndex, type RefChange } from './wal-index'

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

/** A push walgit verified, and the key it named. */
const signed = (fingerprint: string) => ({ kind: 'signed' as const, fingerprint })

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

  const refused: [name: string, changes: RefChange[], read: SignersSource, kind: ListRefusal][] = [
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
      expect(verdict.kind).toBe(kind)
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

describe('describeSigner', () => {
  test('a Signer walgit established is the key it named', () => {
    expect(describeSigner(KEY_A, {})).toEqual({ kind: 'signed', fingerprint: KEY_A })
  })

  test('no Signer and no certificate is an unsigned push', () => {
    expect(describeSigner(null, {})).toEqual({ kind: 'unsigned', signable: false })
    expect(describeSigner(null, { GIT_PUSH_CERT: '  ' })).toEqual({
      kind: 'unsigned',
      signable: false,
    })
  })

  test('no Signer but a certificate that arrived is an unverified one', () => {
    // Every way verification can fail collapses to `null` upstream — a bad
    // nonce, a bad signature, an `ssh-keygen` that is missing or throws — and
    // they all land here, because git set the blob whatever became of it.
    expect(describeSigner(null, { GIT_PUSH_CERT: 'c0ffee' })).toEqual({ kind: 'unverified' })
    expect(
      describeSigner(null, { GIT_PUSH_CERT: 'c0ffee', GIT_PUSH_CERT_NONCE_STATUS: 'SLOP' }),
    ).toEqual({ kind: 'unverified' })
  })

  test('an unsigned push knows whether it could have been signed at all', () => {
    expect(describeSigner(null, { WALGIT_PUSH_CERT_SEED: 'a-real-seed' })).toEqual({
      kind: 'unsigned',
      signable: true,
    })
  })

  test('the certificate is never consulted when a Signer was established', () => {
    // The env read is second and narrow on purpose: who signed is
    // `establishSigner`'s answer and nothing here revisits it.
    expect(describeSigner(KEY_A, { GIT_PUSH_CERT: '' })).toEqual({
      kind: 'signed',
      fingerprint: KEY_A,
    })
  })
})

/**
 * The gate: while a repository HAS a list, a push not signed by a listed key is
 * refused.
 *
 * Pure over three inputs and nothing else — the Signer this push established,
 * the list as it stood BEFORE this push, and the ref changes — so every case is
 * a table entry with no keypair, no subprocess and no server anywhere near it.
 */
describe('checkSignerAllowed', () => {
  const unsigned = { kind: 'unsigned' as const, signable: true }
  const unverified = { kind: 'unverified' as const }
  const branch = [change('refs/heads/main')]

  const cases: [
    name: string,
    signer: PushSigner,
    claimed: string[] | null,
    kind: GateRefusal | null,
  ][] = [
    // An unclaimed name refuses nothing, which is what makes the founding
    // push need no exception written for it.
    ['an unsigned push to an unclaimed name', unsigned, null, null],
    ['an unverifiable push to an unclaimed name', unverified, null, null],
    ['a stranger’s signed push to an unclaimed name', signed(KEY_B), null, null],
    // A claimed one refuses everything but a key it names.
    ['a push by the only listed key', signed(KEY_A), [KEY_A], null],
    ['a push by the second of two listed keys', signed(KEY_B), [KEY_A, KEY_B], null],
    ['a push by a key the list does not name', signed(KEY_B), [KEY_A], 'not-listed'],
    ['an unsigned push to a claimed name', unsigned, [KEY_A], 'unsigned'],
    ['an unverifiable push to a claimed name', unverified, [KEY_A], 'unverified'],
  ]

  for (const [name, signer, claimed, kind] of cases) {
    test(`${kind === null ? 'allows' : `refuses (${kind})`} ${name}`, () => {
      const verdict = checkSignerAllowed('alpha', signer, claimed, branch)
      expect(verdict.ok).toBe(kind === null)
      if (verdict.ok || kind === null) return
      expect(verdict.kind).toBe(kind)
    })
  }

  test('breaking verification is not a way around the gate', () => {
    // Fail open's one exception, and the reason it has to exist: if an
    // unestablished Signer landed here the way it lands everywhere else, then
    // corrupting your own certificate would be the bypass (docs/adr/0012).
    for (const signer of [unsigned, unverified]) {
      expect(checkSignerAllowed('alpha', signer, [KEY_A], branch).ok).toBe(false)
    }
  })

  test('a list naming nobody reads as unclaimed, not as a name nobody can push to', () => {
    // `checkSignerList` refuses writing one, so reaching this means the Index
    // disagrees with what this code can produce. Of the two readings of that,
    // only "the name is open" has a way back.
    expect(checkSignerAllowed('alpha', unsigned, [], branch)).toEqual({ ok: true })
  })

  test('a grant governs the NEXT push, not its own', () => {
    // The whole of the rule is that `claimed` is the list as it stood BEFORE
    // this push, so a push that adds a key and a branch at once is still judged
    // by the list it is replacing.
    const grantAndBranch = [change(SIGNERS_REF), change('refs/heads/main')]
    expect(checkSignerAllowed('alpha', signed(KEY_B), [KEY_A], grantAndBranch).ok).toBe(false)
    // …and once it has landed, the same push by the same key is allowed.
    expect(checkSignerAllowed('alpha', signed(KEY_B), [KEY_A, KEY_B], grantAndBranch).ok).toBe(true)
  })

  test('a revoked key is refused on its next push', () => {
    // The mirror image, and the same one line of code: revoking is a commit
    // that removes a line, and the list that judges is whatever stood last.
    expect(checkSignerAllowed('alpha', signed(KEY_B), [KEY_A, KEY_B], branch).ok).toBe(true)
    expect(checkSignerAllowed('alpha', signed(KEY_B), [KEY_A], branch).ok).toBe(false)
  })

  test('the list ref is not its own exception: a stranger cannot rewrite the list', () => {
    // If it were, the gate would defend everything about a name except the one
    // ref that decides who holds it.
    expect(checkSignerAllowed('alpha', signed(KEY_B), [KEY_A], [change(SIGNERS_REF)]).ok).toBe(
      false,
    )
  })
})

describe('the refusal a stranger reads', () => {
  const refusalFor = (signer: PushSigner, changes = [change('refs/heads/main')]): string => {
    const verdict = checkSignerAllowed('alpha', signer, [KEY_A], changes)
    if (verdict.ok) throw new Error('expected a refusal')
    return verdict.message
  }

  test('says the name is held, and names a free one to use instead', () => {
    // The two things the pusher can act on. The free name is generated the same
    // way the append-only refusal generates one, and is random rather than
    // incrementing so a wave of agents is not handed the same "free" name.
    const message = refusalFor({ kind: 'unsigned', signable: true })
    expect(message).toStartWith('walgit: refused — alpha is held by a Signer List.')
    expect(message).toMatch(/alpha-[0-9a-f]{8}\.git/)
  })

  test('says how to be added to the list, and that a grant governs the next push', () => {
    // For most agents this refusal is the entire documentation of the feature —
    // ownership's failure lands on our server, in our words, at the moment it
    // is relevant (docs/adr/0012).
    const message = refusalFor({ kind: 'unsigned', signable: true })
    expect(message).toContain(SIGNERS_REF)
    expect(message).toContain('ssh-keygen -lf')
    expect(message).toContain('NEXT push')
  })

  test('names the refs the push would have written', () => {
    expect(refusalFor({ kind: 'unsigned', signable: true })).toContain('refs/heads/main')
    const many = ['a', 'b', 'c', 'd'].map((n) => change(`refs/heads/${n}`))
    // Truncated past three, because past three the list stops being read — but
    // the count still says the refusal took all of them.
    expect(refusalFor({ kind: 'unsigned', signable: true }, many)).toContain(
      'refs/heads/a, refs/heads/b, refs/heads/c and 1 more',
    )
  })

  test('tells an unsigned push to sign, and quotes the key it refused otherwise', () => {
    const unsigned = refusalFor({ kind: 'unsigned', signable: true })
    expect(unsigned).toContain('carries no signature')
    expect(unsigned).toContain('--signed=yes')

    const stranger = refusalFor({ kind: 'signed', fingerprint: KEY_B })
    expect(stranger).toContain(KEY_B)
    expect(stranger).not.toContain('carries no signature')
  })

  test('tells an unverifiable push to retry, not to sign something it already signed', () => {
    // Different failure, different fix: an agent told "sign your push" when it
    // did sign will re-send the same failing signature forever.
    const message = refusalFor({ kind: 'unverified' })
    expect(message).toContain('could not verify')
    expect(message).toContain('fresh')
    expect(message).not.toContain('carries no signature')
  })

  test('names the misconfiguration when the host cannot take a signature at all', () => {
    // Flag on, no nonce seed: `git-receive-pack` never advertises the
    // capability, so "push with --signed=yes" is advice the pusher's own git
    // refuses and the name is unpushable by everyone, its holder included. The
    // verdict is unchanged — failing open here would be the bypass — but the
    // refusal says whose problem it is instead of proposing a retry loop.
    const message = refusalFor({ kind: 'unsigned', signable: false })
    expect(message).toContain('WALGIT_PUSH_CERT_SEED')
    expect(message).toContain('misconfiguration')
    expect(message).not.toContain('git push --signed=yes origin')
  })

  test('says nothing was uploaded, because the gate runs before the upload', () => {
    expect(refusalFor({ kind: 'unsigned', signable: true })).toContain('Nothing was uploaded')
  })

  test('does not suggest a new branch, which is the advice a stranger cannot take', () => {
    // The reason the gate is judged above append-only: "push to a new branch"
    // is true of a rewrite and useless to someone who may not push here at all.
    expect(refusalFor({ kind: 'unsigned', signable: true })).not.toContain('push to a new branch')
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

  /**
   * Run the real `pre-receive` against a store that starts out holding
   * `claimed` — the Signer List this name already has, or nothing.
   */
  const preReceiveHook = async (
    tip: string,
    { ref = SIGNERS_REF, claimed = null }: { ref?: string; claimed?: string[] | null } = {},
  ) => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-hookstore-'))
    if (claimed) {
      // Published the way a claiming push publishes it — through the store's
      // own compare-and-swap — because the hook reads it through the store, and
      // a hand-written file is missing the bookkeeping that read needs.
      await commitIndex(
        new FileStore(store),
        { ...emptyIndex('alpha'), claim: { signers: claimed, ts: '2026-08-30T12:00:00.000Z' } },
        null,
      )
    }
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'hook-main.ts'), 'pre-receive'],
      {
        stdin: new TextEncoder().encode(`${ZERO_OID} ${tip} ${ref}\n`),
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

  test('a stranger is refused against a claim the store already holds', async () => {
    // The gate's own wiring: the list comes out of `index.json`, not out of a
    // git object, and the hook process is where that is decided. Unsigned here,
    // because a real certificate needs a real `git push` — which is
    // `push.e2e.test.ts`'s scenario.
    const { code, stderr, uploaded } = await preReceiveHook(good, { claimed: [KEY_A] })
    expect(code).toBe(1)
    expect(stderr).toContain('alpha is held by a Signer List')
    expect(stderr).toContain('carries no signature')
    expect(uploaded).toEqual([])
  })

  test('and refused BEFORE the list it pushed is even read', async () => {
    // A stranger pushing a malformed list gets the refusal that is about them,
    // not the one that is about their file: "your list has a typo on line 1" is
    // an invitation to fix it and try again, and the retry cannot work either.
    const { code, stderr } = await preReceiveHook(bad, { claimed: [KEY_A] })
    expect(code).toBe(1)
    expect(stderr).toContain('is held by a Signer List')
    expect(stderr).not.toContain('is not a key fingerprint')
  })

  test('an ordinary branch push to an unclaimed name is untouched by any of it', async () => {
    // Fail open, still, everywhere but a claimed name: this push is unsigned,
    // writes no list, and lands.
    const { code, uploaded } = await preReceiveHook(good, { ref: 'refs/heads/main' })
    expect(code).toBe(0)
    expect(uploaded.some((name) => name.endsWith('.pack'))).toBe(true)
  })
})
