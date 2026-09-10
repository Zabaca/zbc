import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse as parseYamlDoc } from 'yaml'

/**
 * Command-level tests for `zbc secret …` (spec: Zabaca/zbc#18).
 *
 * The CLI runs as a real subprocess against a throwaway project directory, so
 * everything is exercised through the public interface: argv in, exit code +
 * stdout out, secrets.yaml on disk. The relay, when needed, is the REAL relay
 * handler running in-process via Bun.serve — only the browser is simulated.
 */

import { createRelay } from '../../templates/apps/secret-relay/src/relay'
import { cleanupProjects, makeProject, runCli, spawnCli } from './fixtures'
import {
  decryptWithDocumentKey,
  encryptForChannel,
  encryptWithDocumentKey,
  generateChannelKeypair,
  pairingCode,
} from '../../templates/apps/secret-relay/src/crypto'

afterEach(() => {
  cleanupProjects()
})

describe('zbc add secret-relay', () => {
  test('scaffolds the app, vendors the cloudflare module, and generates the instance file', async () => {
    const root = makeProject()
    const result = await runCli(root, [
      'add',
      'secret-relay',
      '--account-id',
      'cf-acct-123',
      '--no-prompt',
    ])
    expect(result.exitCode).toBe(0)

    // app package scaffolded
    expect(fs.existsSync(path.join(root, 'packages/secret-relay/package.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'packages/secret-relay/src/relay.ts'))).toBe(true)
    // module dependency vendored
    expect(fs.existsSync(path.join(root, 'packages/infra/modules/cloudflare/registry.json'))).toBe(
      true,
    )
    // instance file generated — committed declarative state, not an imperative deploy
    const instancePath = path.join(root, 'packages/infra/environments/production/secret-relay.ts')
    const instance = fs.readFileSync(instancePath, 'utf8')
    expect(instance).toContain("name: 'secret-relay'")
    expect(instance).toContain("accountId: 'cf-acct-123'")
    expect(instance).toContain('cloudflareModule.instance')
    // convergence stays in the graph: the command points at apply, not deploys itself
    expect(result.stdout).toContain('zbc apply production secret-relay')
  })
})

describe('zbc add auto-requests missing secrets', () => {
  test('after add, missing registry-declared secrets are collected via the relay', async () => {
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const root = makeProject()
      // module already vendored (no network), declaring one secret
      const modDir = path.join(root, 'packages/infra/modules/turso')
      fs.mkdirSync(modDir, { recursive: true })
      fs.writeFileSync(
        path.join(modDir, 'registry.json'),
        JSON.stringify({ name: 'turso', secrets: ['TURSO_API_TOKEN'] }),
      )
      // project has a relay instance the graph can converge
      fs.writeFileSync(
        path.join(root, 'packages/infra/environments/production/secret-relay.ts'),
        `const id = { parse: (x) => x }
export default {
  name: 'secret-relay', moduleName: 'cloudflare', imports: [], config: {},
  _definition: { configSchema: id, outputsSchema: id,
    apply: async () => ({ deployUrl: 'http://localhost:${server.port}', workerName: 'secret-relay' }) },
}
`,
      )

      const cli = spawnCli(root, ['add', 'turso'])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const meta = (await (await fetch(`${url.origin}${url.pathname}/meta`)).json()) as {
        keys: string[]
      }
      expect(meta.keys).toEqual(['TURSO_API_TOKEN'])
      await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(
            url.hash.slice(1),
            JSON.stringify({ TURSO_API_TOKEN: 'tok-from-add' }),
          ),
        ),
      })
      const result = await cli.result
      expect(result.exitCode).toBe(0)
      const written = fs.readFileSync(
        path.join(root, 'packages/infra/environments/production/secrets.yaml'),
        'utf8',
      )
      expect(parseYamlDoc(written).TURSO_API_TOKEN).toBe('tok-from-add')
    } finally {
      server.stop(true)
    }
  })

  test('--no-prompt skips the request and just prints what is missing', async () => {
    const root = makeProject()
    const modDir = path.join(root, 'packages/infra/modules/turso')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(
      path.join(modDir, 'registry.json'),
      JSON.stringify({ name: 'turso', secrets: ['TURSO_API_TOKEN'] }),
    )
    const result = await runCli(root, ['add', 'turso', '--no-prompt'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('TURSO_API_TOKEN')
    expect(
      fs.existsSync(path.join(root, 'packages/infra/environments/production/secrets.yaml')),
    ).toBe(false)
  })
})

describe('zbc secret edit', () => {
  test('full sops round-trip: browser edits the decrypted YAML, sops re-encrypts on save', async () => {
    const { execSync } = await import('node:child_process')
    const keyOut = execSync('age-keygen 2>/dev/null').toString()
    const ageSecretKey = keyOut.match(/AGE-SECRET-KEY-\S+/)![0]
    const agePublicKey = keyOut.match(/public key: (\S+)/)![1]

    const root = makeProject()
    fs.writeFileSync(path.join(root, '.sops.yaml'), `creation_rules:\n  - age: ${agePublicKey}\n`)
    const secretsPath = path.join(root, 'packages/infra/environments/production/secrets.yaml')
    execSync(
      `sops --config ${root}/.sops.yaml --filename-override ${secretsPath} -e --input-type yaml --output-type yaml /dev/stdin > ${secretsPath}`,
      { input: 'OLD_KEY: old-value\n', env: { ...process.env } },
    )

    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(
        root,
        ['secret', 'edit', 'production', '--relay', `http://localhost:${server.port}`],
        { SOPS_AGE_KEY: ageSecretKey },
      )
      // editor prints channel URL with a symmetric document key in the fragment
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const docKey = url.hash.slice(1)
      const base = `${url.origin}${url.pathname}`

      // simulated browser: fetch + decrypt the document, edit it, submit back
      const doc = (await (await fetch(`${base}/document`)).json()) as { iv: string; ct: string }
      const plaintext = await decryptWithDocumentKey(docKey, doc)
      expect(plaintext).toContain('OLD_KEY: old-value')

      const edited = plaintext + 'NEW_KEY: new-value\n'
      await fetch(`${base}/submission`, {
        method: 'POST',
        body: JSON.stringify({ document: await encryptWithDocumentKey(docKey, edited) }),
      })

      const result = await cli.result
      expect(result.exitCode).toBe(0)

      const onDisk = fs.readFileSync(secretsPath, 'utf8')
      expect(onDisk).not.toContain('new-value')
      expect(onDisk).toContain('ENC[')
      const decrypted = execSync(`sops -d ${secretsPath}`, {
        env: { ...process.env, SOPS_AGE_KEY: ageSecretKey },
      }).toString()
      expect(decrypted).toContain('OLD_KEY: old-value')
      expect(decrypted).toContain('NEW_KEY: new-value')
    } finally {
      server.stop(true)
    }
  }, 20000)
})

describe('zbc secret list', () => {
  test('reports set vs missing for registry-declared keys, names only — never values', async () => {
    const root = makeProject({ secrets: 'TURSO_API_TOKEN: tok-secret-77\nEXTRA_KEY: extra-val\n' })
    // a vendored module declaring its required secrets
    const modDir = path.join(root, 'packages/infra/modules/turso')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(
      path.join(modDir, 'registry.json'),
      JSON.stringify({ name: 'turso', secrets: ['TURSO_API_TOKEN', 'TURSO_ORG'] }),
    )

    const result = await runCli(root, ['secret', 'list'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/TURSO_API_TOKEN\s+set/)
    expect(result.stdout).toMatch(/TURSO_ORG\s+missing/)
    expect(result.stdout).toMatch(/EXTRA_KEY\s+set/)
    expect(result.stdout).not.toContain('tok-secret-77')
    expect(result.stdout).not.toContain('extra-val')
  })
})

describe('zbc secret request', () => {
  test('collects a missing key through the relay: browser submits E2E-encrypted, CLI writes secrets.yaml', async () => {
    const root = makeProject({ secrets: 'EXISTING: keep-me\n' })
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'TURSO_API_TOKEN',
        '--relay',
        `http://localhost:${server.port}`,
      ])

      // CLI prints the channel URL with the public key in the fragment
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const channelPublicKey = url.hash.slice(1)

      // Simulated browser: fetch channel meta, then submit encrypted values
      const meta = (await (await fetch(`${url.origin}${url.pathname}/meta`)).json()) as {
        keys: string[]
      }
      expect(meta.keys).toEqual(['TURSO_API_TOKEN'])

      const payload = await encryptForChannel(
        channelPublicKey,
        JSON.stringify({ TURSO_API_TOKEN: 'tok-new-secret-42' }),
      )
      const submit = await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(submit.ok).toBe(true)

      const result = await cli.result
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('✓ TURSO_API_TOKEN written to production/secrets.yaml')
      // the value never surfaces anywhere observable
      expect(result.stdout).not.toContain('tok-new-secret-42')
      expect(result.stderr).not.toContain('tok-new-secret-42')

      const written = fs.readFileSync(
        path.join(root, 'packages/infra/environments/production/secrets.yaml'),
        'utf8',
      )
      expect(written).toContain('TURSO_API_TOKEN: tok-new-secret-42')
      expect(written).toContain('EXISTING: keep-me')
    } finally {
      server.stop(true)
    }
  })

  test('the channel URL serves the request page to the human', async () => {
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const root = makeProject()
      const cli = spawnCli(root, [
        'secret',
        'request',
        'PAGE_KEY',
        '--relay',
        `http://localhost:${server.port}`,
        '--timeout',
        '1',
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const res = await fetch(`${url.origin}${url.pathname}`)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html.toLowerCase()).toContain('pairing code')
      await cli.result
    } finally {
      server.stop(true)
    }
  })

  test('channels are single-use: a second submission is rejected and a consumed channel is gone', async () => {
    const root = makeProject()
    const relay = createRelay()

    // The CLI polls GET /submission, and that read DELETES the channel — single-use
    // is the property, not an accident. So a poll landing between the two POSTs below
    // makes the second one 404 "no such channel" instead of the 409 this test is about,
    // roughly one run in seven. Hold the CLI off the collection until the second
    // submission has been answered, by giving it the relay's own pre-submission reply
    // (404 "not yet submitted"), which its poll loop already treats as "keep waiting".
    let collectable = false
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (!collectable && req.method === 'GET' && pathname.endsWith('/submission')) {
          return new Response(JSON.stringify({ error: 'not yet submitted' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        return relay.fetch(req)
      },
    })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'ONE_SHOT',
        '--relay',
        `http://localhost:${server.port}`,
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const base = `${url.origin}${url.pathname}`

      const payload = await encryptForChannel(
        url.hash.slice(1),
        JSON.stringify({ ONE_SHOT: 'first-value' }),
      )
      expect(
        (await fetch(`${base}/submission`, { method: 'POST', body: JSON.stringify(payload) })).ok,
      ).toBe(true)

      // second submission: rejected
      const second = await fetch(`${base}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(url.hash.slice(1), JSON.stringify({ ONE_SHOT: 'attacker' })),
        ),
      })
      expect(second.status).toBe(409)

      collectable = true
      const result = await cli.result
      expect(result.exitCode).toBe(0)
      const written = fs.readFileSync(
        path.join(root, 'packages/infra/environments/production/secrets.yaml'),
        'utf8',
      )
      expect(written).toContain('ONE_SHOT: first-value')

      // consumed channel is deleted entirely
      expect((await fetch(`${base}/meta`)).status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('channels expire with the request timeout: a late submission is rejected server-side', async () => {
    const root = makeProject()
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'TOO_LATE',
        '--relay',
        `http://localhost:${server.port}`,
        '--timeout',
        '1',
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      const publicKey = url.hash.slice(1)
      await cli.result // CLI has given up; channel TTL has passed

      const late = await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(await encryptForChannel(publicKey, JSON.stringify({ TOO_LATE: 'x' }))),
      })
      expect(late.ok).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('a submission that fails decryption fails the request loudly and writes nothing', async () => {
    const root = makeProject()
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'TAMPERED',
        '--relay',
        `http://localhost:${server.port}`,
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)

      // encrypt to the WRONG key — as an interloper without the fragment would
      const { publicKeyB64: wrongKey } = await generateChannelKeypair()
      await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(wrongKey, JSON.stringify({ TAMPERED: 'evil' })),
        ),
      })

      const result = await cli.result
      expect(result.exitCode).not.toBe(0)
      expect((result.stdout + result.stderr).toLowerCase()).toMatch(/decrypt|tamper/)
      expect(
        fs.existsSync(path.join(root, 'packages/infra/environments/production/secrets.yaml')),
      ).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('CLI prints a pairing code derived from the channel public key in the URL fragment', async () => {
    const root = makeProject()
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'PAIRED',
        '--relay',
        `http://localhost:${server.port}`,
        '--timeout',
        '1',
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const fragmentKey = new URL(channelUrl).hash.slice(1)

      // the code the browser page would derive from the fragment must be printed by the CLI
      const expected = await pairingCode(fragmentKey)
      expect(expected).toMatch(/^[A-Z2-9]{2}-[A-Z2-9]{2}$/)
      const printed = await cli.waitForStdout(/[Pp]airing code:\s+(\S+)/)
      expect(printed).toBe(expected)
      await cli.result
    } finally {
      server.stop(true)
    }
  })

  test('with .sops.yaml present, auto-creates secrets.yaml encrypted — value never lands in plaintext', async () => {
    const root = makeProject() // no secrets.yaml yet
    const { execSync } = await import('node:child_process')
    const keyOut = execSync('age-keygen 2>/dev/null').toString()
    const ageSecretKey = keyOut.match(/AGE-SECRET-KEY-\S+/)![0]
    const agePublicKey = keyOut.match(/public key: (\S+)/)![1]
    fs.writeFileSync(path.join(root, '.sops.yaml'), `creation_rules:\n  - age: ${agePublicKey}\n`)

    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const cli = spawnCli(root, [
        'secret',
        'request',
        'ENCRYPTED_KEY',
        '--relay',
        `http://localhost:${server.port}`,
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(
            url.hash.slice(1),
            JSON.stringify({ ENCRYPTED_KEY: 'sekrit-99' }),
          ),
        ),
      })
      const result = await cli.result
      expect(result.exitCode).toBe(0)

      const secretsPath = path.join(root, 'packages/infra/environments/production/secrets.yaml')
      const onDisk = fs.readFileSync(secretsPath, 'utf8')
      expect(onDisk).not.toContain('sekrit-99')
      expect(onDisk).toContain('sops')
      expect(onDisk).toContain('ENC[')

      const decrypted = execSync(`sops -d ${secretsPath}`, {
        env: { ...process.env, SOPS_AGE_KEY: ageSecretKey },
      }).toString()
      expect(decrypted).toContain('ENCRYPTED_KEY: sekrit-99')
    } finally {
      server.stop(true)
    }
  })

  test('trims pasted whitespace; an all-whitespace value fails the request and writes nothing', async () => {
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      // trailing newline (the classic paste bug) is trimmed
      const root = makeProject()
      const cli = spawnCli(root, [
        'secret',
        'request',
        'PADDED',
        '--relay',
        `http://localhost:${server.port}`,
      ])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(url.hash.slice(1), JSON.stringify({ PADDED: '  tok-pad\n' })),
        ),
      })
      expect((await cli.result).exitCode).toBe(0)
      const written = fs.readFileSync(
        path.join(root, 'packages/infra/environments/production/secrets.yaml'),
        'utf8',
      )
      expect(parseYamlDoc(written).PADDED).toBe('tok-pad')

      // all-whitespace value: request fails, nothing written
      const root2 = makeProject()
      const cli2 = spawnCli(root2, [
        'secret',
        'request',
        'BLANK',
        '--relay',
        `http://localhost:${server.port}`,
      ])
      const channelUrl2 = await cli2.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url2 = new URL(channelUrl2)
      await fetch(`${url2.origin}${url2.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(url2.hash.slice(1), JSON.stringify({ BLANK: '   \n' })),
        ),
      })
      const result2 = await cli2.result
      expect(result2.exitCode).not.toBe(0)
      expect(
        fs.existsSync(path.join(root2, 'packages/infra/environments/production/secrets.yaml')),
      ).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('without --relay and no secret-relay instance, errors telling you to run zbc add secret-relay', async () => {
    const root = makeProject()
    const result = await runCli(root, ['secret', 'request', 'SOME_KEY'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('zbc add secret-relay')
  })

  test('resolves the relay by converging the secret-relay instance and reading its deployUrl output', async () => {
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const root = makeProject()
      // A minimal instance the engine can discover and apply: its `apply`
      // "deploys" nothing and emits the in-process relay's URL as deployUrl.
      fs.writeFileSync(
        path.join(root, 'packages/infra/environments/production/secret-relay.ts'),
        `const id = { parse: (x) => x }
export default {
  name: 'secret-relay',
  moduleName: 'cloudflare',
  imports: [],
  config: {},
  _definition: {
    configSchema: id,
    outputsSchema: id,
    apply: async () => ({ deployUrl: 'http://localhost:${server.port}', workerName: 'secret-relay' }),
  },
}
`,
      )

      const cli = spawnCli(root, ['secret', 'request', 'VIA_GRAPH'])
      const channelUrl = await cli.waitForStdout(/(http:\/\/\S+\/channels\/\S+#\S+)/)
      const url = new URL(channelUrl)
      await fetch(`${url.origin}${url.pathname}/submission`, {
        method: 'POST',
        body: JSON.stringify(
          await encryptForChannel(url.hash.slice(1), JSON.stringify({ VIA_GRAPH: 'graph-val' })),
        ),
      })
      const result = await cli.result
      expect(result.exitCode).toBe(0)
      const written = fs.readFileSync(
        path.join(root, 'packages/infra/environments/production/secrets.yaml'),
        'utf8',
      )
      expect(parseYamlDoc(written).VIA_GRAPH).toBe('graph-val')
    } finally {
      server.stop(true)
    }
  })

  test('times out when nobody submits: non-zero exit, names the still-missing keys', async () => {
    const root = makeProject()
    const relay = createRelay()
    const server = Bun.serve({ port: 0, fetch: relay.fetch })
    try {
      const result = await runCli(root, [
        'secret',
        'request',
        'NEVER_ARRIVES',
        '--relay',
        `http://localhost:${server.port}`,
        '--timeout',
        '1',
      ])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout + result.stderr).toContain('still missing: NEVER_ARRIVES')
    } finally {
      server.stop(true)
    }
  })

  test('skips keys that are already set: exit 0, reports "already set", never needs a relay', async () => {
    const root = makeProject({ secrets: 'TURSO_API_TOKEN: tok-abc123\n' })

    const result = await runCli(root, ['secret', 'request', 'TURSO_API_TOKEN'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('TURSO_API_TOKEN')
    expect(result.stdout.toLowerCase()).toContain('already set')
    // the value must never surface on stdout/stderr
    expect(result.stdout).not.toContain('tok-abc123')
    expect(result.stderr).not.toContain('tok-abc123')
  })
})

/**
 * `zbc secret get` — the one value a local script needs.
 *
 * Eight sites across two consumers re-implemented this as `sops -d … | grep`
 * against plaintext, so the assertions are what a shell substitution needs: the
 * value alone on stdout, and a failure that says nothing rather than the word
 * "undefined".
 */
describe('zbc secret get', () => {
  test('prints one value and nothing else', async () => {
    const root = makeProject({ secrets: 'TURSO_API_TOKEN: tok-abc123\nOTHER: nope\n' })

    const result = await runCli(root, ['secret', 'get', 'production', 'TURSO_API_TOKEN'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('tok-abc123\n')
  })

  test('reads the environment it was given, not the default', async () => {
    const root = makeProject({ env: 'preview', secrets: 'API: preview-value\n' })

    const result = await runCli(root, ['secret', 'get', 'preview', 'API'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('preview-value\n')
  })

  test('a key that is not there fails, names the key, and writes nothing to stdout', async () => {
    const root = makeProject({ secrets: 'PRESENT: yes\n' })

    const result = await runCli(root, ['secret', 'get', 'production', 'ABSENT'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('ABSENT')
  })

  test('a blank value fails unless --allow-blank says a placeholder is expected', async () => {
    const root = makeProject({ secrets: 'PLACEHOLDER:\n' })

    const refused = await runCli(root, ['secret', 'get', 'production', 'PLACEHOLDER'])
    expect(refused.exitCode).not.toBe(0)

    const allowed = await runCli(root, [
      'secret',
      'get',
      'production',
      'PLACEHOLDER',
      '--allow-blank',
    ])
    expect(allowed.exitCode).toBe(0)
    expect(allowed.stdout).toBe('\n')
  })

  test('an environment the project does not declare is refused by name', async () => {
    const root = makeProject({ secrets: 'A: b\n' })

    const result = await runCli(root, ['secret', 'get', 'staging', 'A'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('staging')
  })
})
