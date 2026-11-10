/**
 * Makes, renews and reports the secrets the service's seal and vault stand on. Never prints a key: every secret goes
 * straight into sops (or into .dev.vars) and what is shown is a fingerprint, a subject and a date.
 *
 *   bun scripts/seal-certs.ts --dev          a throwaway master key and seal into .dev.vars, for `bun run dev`
 *   bun scripts/seal-certs.ts --production   the real ones, into the install's sops file, ONCE (refuses if they exist)
 *   bun scripts/seal-certs.ts --renew        a new seal certificate under the existing root, before the current one ends
 *   bun scripts/seal-certs.ts --status       fingerprints and dates from the install's sops file, no secrets
 *
 * What goes into sops (the install's secrets file):
 *   FORMS_DATA_KEY          the vault's master key, base64, 32 bytes
 *   FORMS_SEAL_KEY          the seal certificate's private key, PKCS#8 PEM
 *   FORMS_SEAL_CERT_CHAIN   the seal certificate then the root's certificate, PEM (public)
 *   FORMS_SEAL_ROOT_KEY     the root's private key, PKCS#8 PEM. In sops ONLY: the zbc instance does not push it
 *
 * Which company's seal. `--production` names the certificates for the install's signing service ("<service name> Root" and "<service name> Seal") and gives them who runs it as their organisation, from the install's
 * declaration. The install is the one the environment names, its declaration AND its sops file together (the script refuses with either missing, and never falls back to the invented install the package bundles):
 * SPACE_DECLARATION, with SPACE_SECRETS or the secrets.yaml beside it (packages/workspace/scripts/project-env.ts), or the two named here. `--renew` and `--status` take the sops file alone, and a renewal takes its
 * names from the root certificate in that file, never from a declaration:
 *
 *   SPACE_DECLARATION=/abs/path/workspace.json bun scripts/seal-certs.ts --production
 *   FORMS_DECLARATION=/abs/path/workspace.json FORMS_SOPS_FILE=/abs/path/secrets.yaml bun scripts/seal-certs.ts --production
 *
 * The root lasts 10 years and issues a seal certificate that lasts 3. Renewal (--renew) reads the root key from sops,
 * issues a new seal certificate, replaces FORMS_SEAL_KEY and FORMS_SEAL_CERT_CHAIN, and leaves the root, the master
 * key and every earlier sealed document alone (a document sealed before keeps its seal, and its certificate is inside
 * it). Apply the zbc instance afterwards to push the new pair to the Worker.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../src/bytes'
import { createInstall } from '@space/workspace'
import { projectEnv } from '../../workspace/scripts/project-env'
import { type SealCerts, makeSealCerts, reissueSeal, sealNamesFromRoot, sealNamesOf } from './certs'
import { serviceWordsOf } from '../src/workspace'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The install the script works on: the one the environment names (SPACE_DECLARATION and its secrets file), or FORMS_DECLARATION and FORMS_SOPS_FILE, which name the two directly (test/seal-certs-cli.test.ts runs it
// against a throwaway sops file that way). Nothing here falls back to a company's files.
const project = process.env.FORMS_DECLARATION || process.env.FORMS_SOPS_FILE ? null : projectEnv()
const DECLARATION = process.env.FORMS_DECLARATION || project?.declaration || ''
const SOPS_FILE = process.env.FORMS_SOPS_FILE || project?.secrets || ''
// `--production` names its certificates for the declared install's own signing service and run-by (see the header). Only `--production` reads it:
// a renewal takes its names from the root certificate in sops, so it cannot rename a seal.
const namesForProduction = () => sealNamesOf(serviceWordsOf(createInstall(JSON.parse(readFileSync(DECLARATION, 'utf8')))))
const WHERE = SOPS_FILE
const KEYS = ['FORMS_DATA_KEY', 'FORMS_SEAL_KEY', 'FORMS_SEAL_CERT_CHAIN', 'FORMS_SEAL_ROOT_KEY'] as const

const masterKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

function sopsGet(key: string): string | null {
  const r = spawnSync('sops', ['decrypt', '--extract', `["${key}"]`, SOPS_FILE], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}

/** The value goes in through stdin as a JSON string, so it is never in a process listing or a log. */
function sopsSet(key: string, value: string): void {
  const r = spawnSync('sops', ['set', '--value-stdin', SOPS_FILE, `["${key}"]`], { input: JSON.stringify(value), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sops set ${key} failed: ${r.stderr.replace(value, '[value]')}`)
}

const pemToDer = (p: string) => new Uint8Array(Buffer.from(p.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64'))
const blocks = (chain: string) => chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []

async function describeChain(chain: string) {
  const certs = blocks(chain)
  const pkijs = await import('pkijs')
  const seal = pkijs.Certificate.fromBER(pemToDer(certs[0]!).buffer as ArrayBuffer)
  return { sealFingerprint: await sha256Hex(pemToDer(certs[0]!)), rootFingerprint: await sha256Hex(pemToDer(certs[certs.length - 1]!)), notAfter: seal.notAfter.value.toISOString() }
}

function writeDevVars(certs: SealCerts): void {
  const path = `${ROOT}dev/.dev.vars`
  const keep = (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').filter((l) => l.trim() !== '' && !/^(FORMS_DATA_KEY|FORMS_SEAL_KEY|FORMS_SEAL_CERT_CHAIN)=/.test(l))
  if (!keep.some((l) => l.startsWith('ALLOW_UNAUTHENTICATED='))) keep.unshift('ALLOW_UNAUTHENTICATED=1')
  const esc = (s: string) => s.replace(/\n/g, '\\n')
  keep.push(`FORMS_DATA_KEY="${masterKey()}"`, `FORMS_SEAL_KEY="${esc(certs.seal.keyPem)}"`, `FORMS_SEAL_CERT_CHAIN="${esc(certs.seal.certPem + certs.root.certPem)}"`)
  writeFileSync(path, `${keep.join('\n')}\n`)
}

const mode = process.argv[2]

if (mode === '--dev') {
  const certs = await makeSealCerts(new Date(), 2048)
  writeDevVars(certs)
  console.log(`.dev.vars written: a throwaway master key and seal (seal ${certs.seal.fingerprint.slice(0, 16)}..., root ${certs.root.fingerprint.slice(0, 16)}...). Not for production.`)
} else if (mode === '--production') {
  // The two name one install together: a declaration with no sops file has nowhere to put its keys, and a sops file with no declaration has no company to name its certificates for.
  if (DECLARATION === '' || SOPS_FILE === '') {
    console.error('Refusing: --production needs the install\'s declaration and its sops file, so set both: SPACE_DECLARATION (its secrets.yaml is read from beside it, or from SPACE_SECRETS), or FORMS_DECLARATION and FORMS_SOPS_FILE.')
    process.exit(2)
  }
  const NAMES = namesForProduction()
  const have = KEYS.filter((k) => sopsGet(k) !== null)
  if (have.length > 0) {
    console.error(`Refusing: ${WHERE} already holds ${have.join(', ')}. Replacing the master key would orphan every stored record; use --renew for a new seal certificate.`)
    process.exit(1)
  }
  const certs = await makeSealCerts(new Date(), 4096, NAMES)
  sopsSet('FORMS_DATA_KEY', masterKey())
  sopsSet('FORMS_SEAL_KEY', certs.seal.keyPem)
  sopsSet('FORMS_SEAL_CERT_CHAIN', certs.seal.certPem + certs.root.certPem)
  sopsSet('FORMS_SEAL_ROOT_KEY', certs.root.keyPem)
  const d = await describeChain(certs.seal.certPem + certs.root.certPem)
  console.log(`Wrote ${KEYS.join(', ')} to ${WHERE}.`)
  console.log(`  certificates "${NAMES.root}" and "${NAMES.seal}", organisation "${NAMES.organization}"`)
  console.log(`  root fingerprint (SHA-256) ${d.rootFingerprint}`)
  console.log(`  seal fingerprint (SHA-256) ${d.sealFingerprint}, valid until ${d.notAfter}`)
} else if ((mode === '--renew' || mode === '--status') && SOPS_FILE === '') {
  console.error('Name the install\'s sops file: SPACE_DECLARATION (its secrets.yaml is read from beside it, or from SPACE_SECRETS), or FORMS_SOPS_FILE.')
  process.exit(2)
} else if (mode === '--renew') {
  const rootKey = sopsGet('FORMS_SEAL_ROOT_KEY')
  const chain = sopsGet('FORMS_SEAL_CERT_CHAIN')
  if (!rootKey || !chain) {
    console.error(`${WHERE} holds no FORMS_SEAL_ROOT_KEY or FORMS_SEAL_CERT_CHAIN: run --production first.`)
    process.exit(1)
  }
  const rootCert = blocks(chain).at(-1)!
  const names = sealNamesFromRoot(rootCert)
  const seal = await reissueSeal(rootKey, rootCert, new Date(), names)
  const rootEnds = (await import('pkijs')).Certificate.fromBER(pemToDer(rootCert).buffer as ArrayBuffer).notAfter.value
  sopsSet('FORMS_SEAL_KEY', seal.keyPem)
  sopsSet('FORMS_SEAL_CERT_CHAIN', seal.certPem + rootCert)
  const d = await describeChain(seal.certPem + rootCert)
  console.log(`Renewed the seal certificate under the same root ("${names.seal}", organisation "${names.organization}"). Apply the install's space instance to push it (README, Secrets).`)
  console.log(`  root fingerprint (SHA-256) ${d.rootFingerprint} (unchanged)`)
  console.log(`  seal fingerprint (SHA-256) ${d.sealFingerprint}, valid until ${d.notAfter}`)
  const days = Math.floor((seal.notAfter.getTime() - Date.now()) / 86_400_000)
  if (days < 365) console.log(`WARNING: the root itself ends ${rootEnds.toISOString()}, so this seal certificate lasts only ${days} days. Plan a new root before then: documents sealed under the old one keep their seal, but a new root must be trusted again by any client that trusted this one.`)
} else if (mode === '--status') {
  const chain = sopsGet('FORMS_SEAL_CERT_CHAIN')
  if (!chain) {
    console.log(`${WHERE} holds no seal yet.`)
  } else {
    const d = await describeChain(chain)
    const left = Math.floor((Date.parse(d.notAfter) - Date.now()) / 86_400_000)
    console.log(`root ${d.rootFingerprint}\nseal ${d.sealFingerprint}, valid until ${d.notAfter} (${left} days left)`)
    for (const k of KEYS) console.log(`  ${k}: ${sopsGet(k) ? 'present' : 'MISSING'}`)
  }
} else {
  console.error('Usage: bun scripts/seal-certs.ts --dev | --production | --renew | --status')
  process.exit(2)
}
