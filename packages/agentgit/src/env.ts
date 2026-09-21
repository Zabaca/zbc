/**
 * The two settings this client reads from the environment, and nothing else.
 *
 * One reading, in one place: `watch` and `accept` present the same header and
 * talk to the same host, and two spellings of "which variable wins" would be
 * two deployments' worth of confusion. The precedence is
 * `AGENTGIT_* ?? WALGIT_*` — the tool's own name first, the service it came
 * from as the compatibility fallback.
 *
 * `HOME` and `SHELL` are deliberately not here. They are the operating system,
 * not this tool's configuration, and whoever reads them should keep reading
 * them where they are.
 */

/**
 * The environment as this client sees it: the four variables it reads, and no
 * promise that any of them is set.
 *
 * Narrowed rather than `process.env` so the readings below are pure — a caller
 * passes what it has, and a test never has to mutate the process.
 */
export interface AgentgitEnv {
  AGENTGIT_HOST?: string | undefined
  WALGIT_HOST?: string | undefined
  AGENTGIT_TOKEN?: string | undefined
  WALGIT_TOKEN?: string | undefined
}

/**
 * The four variables, out of a whole process environment.
 *
 * The narrowing is the point: everything downstream of here holds a value that
 * can only have come from one of these names, and nothing can reach for a
 * variable this client does not read.
 */
export function agentgitEnv(env: Readonly<Record<string, string | undefined>>): AgentgitEnv {
  return {
    AGENTGIT_HOST: env.AGENTGIT_HOST,
    WALGIT_HOST: env.WALGIT_HOST,
    AGENTGIT_TOKEN: env.AGENTGIT_TOKEN,
    WALGIT_TOKEN: env.WALGIT_TOKEN,
  }
}

/**
 * An exported-but-empty variable is unset.
 *
 * `export AGENTGIT_TOKEN=` is how a shell says "I have nothing to say about
 * this", and `??` alone would hand the empty string on as a value — which
 * became a request with a blank credential and a 401 nobody could explain.
 */
function set(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

/** The host to talk to, where no `--host` was given. */
export function envHost(env: AgentgitEnv): string | null {
  return set(env.AGENTGIT_HOST) ?? set(env.WALGIT_HOST)
}

/** The bearer token a gated deployment takes, where no `--token` was given. */
export function envToken(env: AgentgitEnv): string | null {
  return set(env.AGENTGIT_TOKEN) ?? set(env.WALGIT_TOKEN)
}
