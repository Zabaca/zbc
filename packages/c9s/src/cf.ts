// Cloudflare REST client. Read-only for now: c9s lists and watches, it does not
// mutate. Mutation is `zbc apply`'s job, deliberately.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const BASE = 'https://api.cloudflare.com/client/v4'

export type Cf = { token: string; accountId: string }

/** What makes a directory a zbc project. */
const MARKER = 'zbc.config.ts'

/** Nearest ancestor of `from` holding a zbc.config.ts. Undefined outside a zbc project. */
export function findProjectRoot(from: string = process.cwd()): string | undefined {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Where to look for a sops-encrypted secrets file holding CLOUDFLARE_API_TOKEN.
 *
 * Resolved from the working directory rather than from this module's own path,
 * so one global install serves every zbc project: they all keep secrets at
 * `packages/infra/environments/<env>/secrets.yaml`, and walking up from the cwd
 * gets you the credentials of the project you are actually standing in.
 * `C9S_ENV` picks the environment, `C9S_SOPS_FILE` overrides the lot.
 */
export function sopsPath(from: string = process.cwd()): string | undefined {
  const explicit = process.env.C9S_SOPS_FILE
  if (explicit) return explicit
  const root = findProjectRoot(from)
  if (!root) return undefined
  const env = process.env.C9S_ENV ?? 'production'
  const secrets = join(root, 'packages', 'infra', 'environments', env, 'secrets.yaml')
  return existsSync(secrets) ? secrets : undefined
}

/**
 * Token from the environment, else decrypted from a sops file. Never a flag, so
 * it stays out of shell history and process listings.
 */
export function resolveToken(): string {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN
  if (fromEnv) return fromEnv

  const secrets = sopsPath()
  if (!secrets) {
    const root = findProjectRoot()
    const env = process.env.C9S_ENV ?? 'production'
    throw new Error(
      root
        ? `no CLOUDFLARE_API_TOKEN, and ${root} has no ${env} secrets at\n` +
            `packages/infra/environments/${env}/secrets.yaml.\n` +
            'Set C9S_ENV to another environment, or C9S_SOPS_FILE to a specific file.'
        : 'no CLOUDFLARE_API_TOKEN, and this is not a zbc project (no zbc.config.ts above the\n' +
            'working directory). Export a token with read on Workers, D1, R2, KV, Queues and\n' +
            'Analytics, or point C9S_SOPS_FILE at a sops file containing one.',
    )
  }
  const sops = Bun.spawnSync(['sops', '-d', secrets])
  if (sops.exitCode !== 0) {
    throw new Error(`sops could not decrypt ${secrets}: ${sops.stderr.toString().trim()}`)
  }
  const token = sops.stdout.toString().match(/^CLOUDFLARE_API_TOKEN:\s*(\S+)/m)?.[1]
  if (!token) throw new Error(`CLOUDFLARE_API_TOKEN not found in ${secrets}`)
  return token
}

/** Envelopes vary across products, so unwrap once here rather than at each call site. */
export async function get<T>(cf: Cf, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${cf.token}` } })
  const text = await res.text()
  let body: { success?: boolean; result?: unknown; errors?: { message?: string }[] }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`CF ${path} returned ${res.status}, non-JSON: ${text.slice(0, 200)}`)
  }
  if (!res.ok || body.success === false) {
    const why = body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`
    throw new Error(why)
  }
  return body.result as T
}

/** GraphQL Analytics lives on a different endpoint and envelope from the REST API. */
export async function graphql<T>(
  cf: Cf,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const text = await res.text()
  let body: { data?: unknown; errors?: { message?: string }[] }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`CF graphql returned ${res.status}, non-JSON: ${text.slice(0, 200)}`)
  }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data as T
}

export async function resolveAccountId(token: string): Promise<string> {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID
  if (fromEnv) return fromEnv
  const accounts = await get<{ id: string; name: string }[]>({ token, accountId: '' }, '/accounts')
  const first = accounts[0]
  if (!first) throw new Error('token has no accounts; set CLOUDFLARE_ACCOUNT_ID')
  return first.id
}

/** "3d" / "4h" / "12m": k9s-style compact age, since a full ISO date wastes a column. */
export function age(iso: string | undefined): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return '-'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function bytes(n: number | undefined): string {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`
}
