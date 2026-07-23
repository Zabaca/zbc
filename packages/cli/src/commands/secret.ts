import * as path from 'node:path'
import { defineCommand } from 'citty'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  decryptSubmission,
  decryptWithDocumentKey,
  type EncryptedDocument,
  encryptWithDocumentKey,
  generateChannelKeypair,
  generateDocumentKey,
  pairingCode,
  type SubmissionPayload,
} from '../../templates/apps/secret-relay/src/crypto'
import { applyEnvironment } from '../engine/apply'
import { discoverInstances } from '../engine/discover'
import { loadSecrets } from '../engine/secrets'
import { findProjectRoot } from '../utils/find-project-root'

const POLL_INTERVAL_MS = 250

/**
 * Best-effort browser open, only when a human is plausibly at this terminal
 * (TTY). Remote/CI/agent sessions just get the printed URL. Never fails the
 * request: the URL is always printed first.
 */
function tryOpenBrowser(url: string): void {
  if (!process.stdout.isTTY) return
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    Bun.spawn([cmd, url], { stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // printed URL is the fallback
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Merge `values` into the environment's secrets.yaml. With a `.sops.yaml` at
 * the project root, writes go through sops so plaintext never lands on disk:
 * `sops set` per key into an existing encrypted file, or a stdin-piped
 * `sops -e` (with --filename-override so creation rules match) to create one.
 * Without `.sops.yaml`, falls back to plain YAML (development mode, mirroring
 * loadSecrets).
 */
async function writeSecrets(
  projectRoot: string,
  envDir: string,
  values: Record<string, string>,
): Promise<void> {
  const secretsPath = path.join(envDir, 'secrets.yaml')
  const file = Bun.file(secretsPath)
  const exists = await file.exists()
  const hasSopsConfig = await Bun.file(path.join(projectRoot, '.sops.yaml')).exists()

  if (!hasSopsConfig) {
    const existing = exists ? (parseYaml(await file.text()) ?? {}) : {}
    await Bun.write(secretsPath, stringifyYaml({ ...existing, ...values }))
    return
  }

  const alreadyEncrypted = exists && parseYaml(await file.text())?.sops
  if (alreadyEncrypted) {
    for (const [key, value] of Object.entries(values)) {
      const proc = Bun.spawnSync(
        ['sops', 'set', secretsPath, `["${key}"]`, JSON.stringify(value)],
        { cwd: projectRoot, stderr: 'pipe' },
      )
      if (proc.exitCode !== 0) {
        throw new Error(`sops set failed for ${key}: ${proc.stderr.toString()}`)
      }
    }
    return
  }

  // Missing (or plain, pre-sops) file: merge in memory, encrypt via stdin so
  // plaintext never touches the filesystem.
  const existing = exists ? (parseYaml(await file.text()) ?? {}) : {}
  const plaintext = stringifyYaml({ ...existing, ...values })
  const proc = Bun.spawnSync(
    [
      'sops',
      '--config',
      path.join(projectRoot, '.sops.yaml'),
      '--filename-override',
      secretsPath,
      '-e',
      '--input-type',
      'yaml',
      '--output-type',
      'yaml',
      '/dev/stdin',
    ],
    { cwd: projectRoot, stdin: new TextEncoder().encode(plaintext), stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    throw new Error(`sops encrypt failed: ${proc.stderr.toString()}`)
  }
  await Bun.write(secretsPath, proc.stdout)
}

/**
 * Find the project's Secret Relay and converge it through the normal apply
 * graph (outputs are per-run, not persisted — ADR-0003), returning its
 * deployUrl. Prefers a `secret-relay` instance in production, then any env.
 */
async function resolveRelayUrl(projectRoot: string): Promise<string> {
  const environmentsDir = path.join(projectRoot, 'packages/infra/environments')
  const envDirs = Array.from(
    new Bun.Glob('*/').scanSync({ cwd: environmentsDir, onlyFiles: false }),
  )
    .map((d) => d.replace(/\/$/, ''))
    .sort((a, b) => (a === 'production' ? -1 : b === 'production' ? 1 : a.localeCompare(b)))

  for (const env of envDirs) {
    const envDir = path.join(environmentsDir, env)
    const instances = await discoverInstances(envDir)
    if (!instances.some((i) => i.name === 'secret-relay')) continue
    const outputs = await applyEnvironment(projectRoot, envDir, 'secret-relay')
    const relayOutputs = outputs.get('secret-relay') as { deployUrl?: string } | undefined
    if (!relayOutputs?.deployUrl) {
      throw new Error(`secret-relay instance in ${env} did not emit a deployUrl output`)
    }
    return relayOutputs.deployUrl
  }

  throw new Error(
    'no Secret Relay found — run `zbc add secret-relay` to scaffold and deploy one, or pass --relay <url>',
  )
}

async function requestViaRelay(opts: {
  relayUrl: string
  keys: string[]
  env: string
  reason?: string
  timeoutMs: number
}): Promise<Record<string, string>> {
  const { publicKeyB64, privateKey } = await generateChannelKeypair()

  const created = await fetch(`${opts.relayUrl}/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      keys: opts.keys,
      env: opts.env,
      reason: opts.reason,
      ttlSeconds: Math.ceil(opts.timeoutMs / 1000),
    }),
  })
  if (!created.ok) throw new Error(`relay refused to open a channel (${created.status})`)
  const { id } = (await created.json()) as { id: string }

  const channelUrl = `${opts.relayUrl}/channels/${id}#${publicKeyB64}`
  console.log(`Waiting for ${opts.keys.join(', ')} (${opts.env}) — open:`)
  console.log(`  ${channelUrl}`)
  console.log(`Pairing code: ${await pairingCode(publicKeyB64)} — confirm it matches the page.`)
  tryOpenBrowser(channelUrl)

  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${opts.relayUrl}/channels/${id}/submission`)
    if (res.ok) {
      const payload = (await res.json()) as SubmissionPayload
      try {
        return JSON.parse(await decryptSubmission(privateKey, payload)) as Record<string, string>
      } catch {
        throw new Error(
          'submission failed to decrypt — possibly tampered or sent to the wrong channel; nothing was written',
        )
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`timed out — still missing: ${opts.keys.join(', ')}`)
}

const requestCommand = defineCommand({
  meta: {
    name: 'request',
    description:
      'Ask a human for secret values via the browser; writes them into the environment secrets.yaml',
  },
  args: {
    keys: {
      type: 'positional',
      description: 'Secret key names to request',
      required: true,
    },
    env: {
      type: 'string',
      description: 'Target environment (default: production)',
      default: 'production',
    },
    relay: {
      type: 'string',
      description: 'Secret Relay URL (default: resolved from the secret-relay instance)',
    },
    reason: {
      type: 'string',
      description: 'Shown to the human on the request page',
    },
    timeout: {
      type: 'string',
      description: 'Seconds to wait for the submission (default: 300)',
      default: '300',
    },
  },
  async run({ args }) {
    const keys = [
      ...new Set([args.keys, ...args._].filter((k): k is string => typeof k === 'string')),
    ]
    await collectSecrets({
      projectRoot: await findProjectRoot(),
      env: args.env,
      keys,
      relayUrl: args.relay,
      reason: args.reason,
      timeoutSeconds: Number(args.timeout),
    })
  },
})

/**
 * The Secret Request flow, programmatically: skip set keys, collect the rest
 * through the relay, write via sops. Used by `zbc secret request` and by
 * `zbc add`'s post-install secret collection.
 */
export async function collectSecrets(opts: {
  projectRoot: string
  env: string
  keys: string[]
  relayUrl?: string
  reason?: string
  timeoutSeconds?: number
}): Promise<void> {
  const envDir = path.join(opts.projectRoot, 'packages/infra/environments', opts.env)
  const existing = await loadSecrets(envDir)

  const missing: string[] = []
  for (const key of opts.keys) {
    if (key in existing) {
      console.log(`✓ ${key} already set in ${opts.env}/secrets.yaml — skipping`)
    } else {
      missing.push(key)
    }
  }
  if (missing.length === 0) return

  const relayUrl = opts.relayUrl ?? (await resolveRelayUrl(opts.projectRoot))

  const submitted = await requestViaRelay({
    relayUrl,
    keys: missing,
    env: opts.env,
    reason: opts.reason,
    timeoutMs: (opts.timeoutSeconds ?? 300) * 1000,
  })

  const values: Record<string, string> = {}
  for (const key of missing) {
    const value = submitted[key]?.trim()
    if (!value) throw new Error(`submission is missing a value for ${key}`)
    values[key] = value
  }

  await writeSecrets(opts.projectRoot, envDir, values)
  for (const key of missing) {
    console.log(`✓ ${key} written to ${opts.env}/secrets.yaml`)
  }
}

/** Registry-declared secret keys across all vendored modules/apps. */
async function declaredSecretKeys(projectRoot: string): Promise<Set<string>> {
  const declared = new Set<string>()
  const modulesDir = path.join(projectRoot, 'packages/infra/modules')
  for (const file of new Bun.Glob('*/registry.json').scanSync({ cwd: modulesDir })) {
    const registry = (await Bun.file(path.join(modulesDir, file)).json()) as {
      secrets?: string[]
    }
    for (const key of registry.secrets ?? []) declared.add(key)
  }
  return declared
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'Show which registry-declared secrets are set vs missing (names only, no values)',
  },
  args: {
    env: {
      type: 'string',
      description: 'Target environment (default: production)',
      default: 'production',
    },
  },
  async run({ args }) {
    const projectRoot = await findProjectRoot()
    const envDir = path.join(projectRoot, 'packages/infra/environments', args.env)
    const existing = await loadSecrets(envDir)
    const declared = await declaredSecretKeys(projectRoot)

    const keys = [...new Set([...declared, ...Object.keys(existing)])].sort()
    for (const key of keys) {
      const status = key in existing ? 'set' : 'missing'
      const note = declared.has(key) ? '' : '  (not declared by any module)'
      console.log(`${key.padEnd(32)} ${status}${note}`)
    }
  },
})

const editCommand = defineCommand({
  meta: {
    name: 'edit',
    description: 'Edit an environment secrets.yaml in the browser (sops decrypts/re-encrypts)',
  },
  args: {
    env: {
      type: 'positional',
      description: 'Target environment (default: production)',
      required: false,
    },
    relay: {
      type: 'string',
      description: 'Secret Relay URL (default: resolved from the secret-relay instance)',
    },
    timeout: {
      type: 'string',
      description: 'Seconds to wait for the browser save (default: 600)',
      default: '600',
    },
  },
  async run({ args }) {
    const env = args.env ?? 'production'
    const projectRoot = await findProjectRoot()
    const secretsPath = path.join(projectRoot, 'packages/infra/environments', env, 'secrets.yaml')
    if (!(await Bun.file(secretsPath).exists())) {
      throw new Error(`${env}/secrets.yaml does not exist — nothing to edit`)
    }
    const relayUrl = args.relay ?? (await resolveRelayUrl(projectRoot))

    // sops decrypts to a temp file and invokes us back as the "editor"
    // (`secret _editor`), which ships the plaintext to the browser through the
    // relay and writes the edited result; sops then re-encrypts.
    const proc = Bun.spawn(['sops', secretsPath], {
      cwd: projectRoot,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: {
        ...process.env,
        SOPS_EDITOR: `${process.execPath} ${process.argv[1]} secret _editor`,
        ZBC_RELAY_URL: relayUrl,
        ZBC_EDIT_ENV: env,
        ZBC_EDIT_TIMEOUT: args.timeout,
      },
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`sops exited with code ${code} — secrets.yaml unchanged`)
    console.log(`✓ ${env}/secrets.yaml updated`)
  },
})

/** Invoked BY sops as $SOPS_EDITOR with the decrypted temp file. Hidden. */
const editorCommand = defineCommand({
  meta: { name: '_editor', description: 'internal: browser editor invoked by sops' },
  args: {
    file: { type: 'positional', description: 'Decrypted temp file from sops', required: true },
  },
  async run({ args }) {
    const relayUrl = process.env.ZBC_RELAY_URL
    if (!relayUrl) throw new Error('_editor must be invoked via `zbc secret edit`')
    const timeoutMs = Number(process.env.ZBC_EDIT_TIMEOUT ?? '600') * 1000
    const plaintext = await Bun.file(args.file).text()

    const documentKey = await generateDocumentKey()
    const created = await fetch(`${relayUrl}/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'editor',
        env: process.env.ZBC_EDIT_ENV,
        document: await encryptWithDocumentKey(documentKey, plaintext),
        ttlSeconds: Math.ceil(timeoutMs / 1000),
      }),
    })
    if (!created.ok) throw new Error(`relay refused to open a channel (${created.status})`)
    const { id } = (await created.json()) as { id: string }

    const channelUrl = `${relayUrl}/channels/${id}#${documentKey}`
    console.log(`Editing ${process.env.ZBC_EDIT_ENV}/secrets.yaml — open:`)
    console.log(`  ${channelUrl}`)
    console.log(`Pairing code: ${await pairingCode(documentKey)} — confirm it matches the page.`)
    tryOpenBrowser(channelUrl)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await fetch(`${relayUrl}/channels/${id}/submission`)
      if (res.ok) {
        const { document } = (await res.json()) as { document: EncryptedDocument }
        let edited: string
        try {
          edited = await decryptWithDocumentKey(documentKey, document)
        } catch {
          throw new Error('edited document failed to decrypt — nothing was written')
        }
        await Bun.write(args.file, edited)
        return
      }
      await sleep(POLL_INTERVAL_MS)
    }
    throw new Error('timed out waiting for the browser save — secrets.yaml unchanged')
  },
})

export const secretCommand = defineCommand({
  meta: {
    name: 'secret',
    description: 'Manage environment secrets (request, list, edit)',
  },
  subCommands: {
    request: requestCommand,
    list: listCommand,
    edit: editCommand,
    _editor: editorCommand,
  },
})
