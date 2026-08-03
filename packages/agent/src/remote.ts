// The remote tier: the same agent, in a container on an agent-host instead of
// a clone on this machine.
//
// An agent-host is a box running sessions as containers (the reference
// implementation lives on foundry's ryzen-9; see the "Running somewhere else"
// section of the README). The container is the boundary there, so
// sandbox-runtime does not apply — and sleep is `incus stop`, so there is no
// snapshot pipeline and nothing to restore: ADR 0004's measured 1.3s/3.1s
// snapshot/restore steps do not exist on this tier.
//
// This module is deliberately a thin wire client. Profiles, traits and option
// composition stay host-side concerns; what travels is a profile NAME, and the
// host decides what it means (review = Read/Grep/Glob/Bash, no Write/Edit).
//
// Two structural differences from `runSandboxed`, both consequences of the
// work living on another machine:
//
//   - `repo` is a clone URL, not a local path. The host clones it inside the
//     session; a private repo needs `gitToken` (forwarded per-invocation via
//     git http.extraheader, never written to the session's .git/config).
//   - Credentials are per-request inputs, not session state. The host never
//     persists them and the guest holds them only for the turn — which is why
//     token rotation on this tier is "send the new token on the next turn"
//     rather than a refresh mechanism (verified on the reference host; see
//     issue #25).
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the agent-host is and how to be allowed in. */
export type RemoteConfig = {
  /** e.g. http://100.67.134.53:8794 — reachable over the operator's tailnet. */
  host: string
  /** The host's bearer (AGENT_HOST_TOKEN on the host side). */
  token: string
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type RemoteRunOptions = {
  /** Clone URL of the repository the session works on. */
  repo: string
  /** CLAUDE_CODE_OAUTH_TOKEN (or API key) the turn runs with. */
  claudeToken: string
  /** For private repos. Forwarded per-invocation, never stored. */
  gitToken?: string
  model?: string
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: Fetch
}

export type RemoteTurnOptions = {
  claudeToken: string
  model?: string
  fetch?: Fetch
}

/** A session on the host. `id` is the handle everything else takes. */
export type RemoteRun = {
  id: string
  /** Claude session id — the host resumes it on every later turn. */
  sessionId: string
  text: string
  turns: number
  totalCostUsd: number
}

const shape = (body: {
  id: string
  claudeSessionId: string
  text: string
  turns: number
  totalCostUsd: number
}): RemoteRun => ({
  id: body.id,
  sessionId: body.claudeSessionId,
  text: body.text,
  turns: body.turns,
  totalCostUsd: body.totalCostUsd,
})

async function call(
  config: RemoteConfig,
  fetchImpl: Fetch | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const f = fetchImpl ?? (globalThis.fetch as Fetch)
  const res = await f(`${config.host}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { error?: string }).error)
      .catch(() => undefined)
    throw new Error(`agent-host ${method} ${path}: ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  return res
}

/** Start a session on the host and run its first turn. */
export async function runRemote(
  profile: 'coding' | 'review',
  input: string,
  config: RemoteConfig,
  options: RemoteRunOptions,
): Promise<RemoteRun> {
  const res = await call(config, options.fetch, 'POST', '/api/sessions', {
    repo: options.repo,
    prompt: input,
    profile,
    claudeToken: options.claudeToken,
    ...(options.gitToken === undefined ? {} : { gitToken: options.gitToken }),
    ...(options.model === undefined ? {} : { model: options.model }),
  })
  return shape((await res.json()) as Parameters<typeof shape>[0])
}

/**
 * Continue a session. The host wakes a sleeping container first — from the
 * caller's side there is no difference between a warm and a slept session
 * beyond a couple of seconds.
 */
export async function continueRemote(
  run: Pick<RemoteRun, 'id'>,
  input: string,
  config: RemoteConfig,
  options: RemoteTurnOptions,
): Promise<RemoteRun> {
  const res = await call(config, options.fetch, 'POST', `/api/sessions/${run.id}/turns`, {
    prompt: input,
    claudeToken: options.claudeToken,
    ...(options.model === undefined ? {} : { model: options.model }),
  })
  return shape((await res.json()) as Parameters<typeof shape>[0])
}

export type RemoteCollected = {
  /** The branch the session commits to: agent/<id>. */
  branch: string
  /** Local path of the downloaded bundle (all refs). */
  bundle: string
}

/**
 * Fetch the session's git history as a bundle.
 *
 * The remote analogue of `collect()`: host-initiated, nothing merged. Bring
 * the branch into a local repository with
 * `git fetch <bundle> <branch>:<branch>` and review it there.
 */
export async function collectRemote(
  run: Pick<RemoteRun, 'id'>,
  config: RemoteConfig,
  options: { fetch?: Fetch } = {},
): Promise<RemoteCollected> {
  const res = await call(config, options.fetch, 'POST', `/api/sessions/${run.id}/collect`)
  const dir = await mkdtemp(join(tmpdir(), 'zbc-remote-'))
  const bundle = join(dir, `${run.id}.bundle`)
  await writeFile(bundle, Buffer.from(await res.arrayBuffer()))
  return { branch: `agent/${run.id}`, bundle }
}

/** Destroy the session's container. Idempotent on the host side. */
export async function destroyRemote(
  run: Pick<RemoteRun, 'id'>,
  config: RemoteConfig,
  options: { fetch?: Fetch } = {},
): Promise<void> {
  await call(config, options.fetch, 'DELETE', `/api/sessions/${run.id}`)
}
