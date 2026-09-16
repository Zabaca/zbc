/**
 * The per-source limit, at the seam where it is SPOKEN.
 *
 * The verdict itself is reached in the HTTP handler and tested there
 * (`src/http.test.ts`) — this file covers the other half of the sentence in the
 * ticket: "a refused push says so in the reject line the way size caps do".
 * That is a claim about `pre-receive`, so it is asserted against the real hook
 * process, the way `src/signers.test.ts` asserts the ownership gate: exit 1,
 * the message on stderr where git turns it into `remote:` lines, and nothing
 * written to the log.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ZERO_OID } from '../shared/protocol'

describe('pre-receive speaks a handed-down refusal', () => {
  let work: string
  let quarantine: string
  let tip: string

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-rate-'))
    Bun.spawnSync(['git', 'init', '-q', work])
    fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n')
    Bun.spawnSync(['git', 'add', '.'], { cwd: work })
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], {
      cwd: work,
    })
    tip = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: work }).stdout)
      .trim()
    // A pack sitting where a real push's would be, so the control below has
    // something to upload and the refusal has something to NOT upload.
    quarantine = path.join(work, 'tmp_objdir-incoming')
    fs.mkdirSync(path.join(quarantine, 'pack'), { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.pack'), 'PACKDATA')
  })

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  const preReceiveHook = async (refuse?: string) => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-ratestore-'))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'hook-main.ts'), 'pre-receive'],
      {
        stdin: new TextEncoder().encode(`${ZERO_OID} ${tip} refs/heads/main\n`),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          GIT_DIR: path.join(work, '.git'),
          WALGIT_REPO_ID: 'alpha',
          WALGIT_STORE_DIR: store,
          GIT_QUARANTINE_PATH: quarantine,
          ...(refuse ? { WALGIT_REFUSE: refuse } : {}),
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

  test('with nothing handed down the push proceeds and its pack IS uploaded', async () => {
    // The control: without it the assertion below could pass because this
    // harness never uploads anything at all.
    const { code, uploaded } = await preReceiveHook()
    expect(code).toBe(0)
    expect(uploaded.some((name) => name.endsWith('.pack'))).toBe(true)
  })

  test('a handed-down refusal is printed and nothing is stored', async () => {
    const message = 'walgit: refused — you have already made 2 pushes this hour.'
    const { code, stderr, uploaded } = await preReceiveHook(message)
    expect(code).toBe(1)
    expect(stderr).toContain(message)
    // Not "an orphan collected later" — never written at all, which is what
    // every refusal message in this package promises the pusher.
    expect(uploaded).toEqual([])
  })
})
