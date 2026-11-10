// Claude's door on the space: which requests are on it, and where in the inbox they go. The Telegram bridge's door is the same rule on another path (`telegramRoute`,
// docs/adr/0002 amended): one function decides both, so neither can answer for the other's path.
//
// One path of the space's host, `agent.path` of the declaration ("/agent/inbox"), is behind an Access application of its own that admits Claude's service token
// and no person (docs/adr/0002). The space answers that path before its person check, and the stand-ins that test the inbox's half use the same
// function, so the path Claude's script is pointed at and the path the inbox answers cannot drift apart.

import type { AgentDoor, Install } from './install'

/** What a path of the space is to Claude's door. */
export type AgentRoute =
  /** Not on the door: the space answers it as it always did, for people. */
  | { on: false }
  /** On the door. `forward` is the inbox's own path (`/api/...`) to hand the request to, or null for a path under the door that is no API of the inbox's (a 404). */
  | { on: true; forward: string | null }

/**
 * Whether `pathname` (as the URL parser gives it, dot segments already resolved) is on Claude's door, and the inbox path it stands for.
 *
 * The door matches without regard to case, as Access matches a path (so `/AGENT/inbox` is the same application), and what follows it is handed on as it is
 * written. Only an `/api/` path of the inbox is forwarded: the inbox's page and files are not Claude's, and `/agent/inboxx` is not under the door at all.
 */
export function agentRoute(install: Install, pathname: string): AgentRoute {
  return doorRoute(install.agentDoor(), pathname)
}

/** The Telegram bridge's door, by the same rule as Claude's (its own path, its own Access application; `Install.telegramDoor`). */
export function telegramRoute(install: Install, pathname: string): AgentRoute {
  return doorRoute(install.telegramDoor(), pathname)
}

/** The Clients door, by the same rule again (its own path, its own Access application; `Install.clientsDoor`). `forward` is the `/api/...` path under the door, which the space itself answers (packages/space/src/clients-door.ts). */
export function clientsRoute(install: Install, pathname: string): AgentRoute {
  return doorRoute(install.clientsDoor(), pathname)
}

function doorRoute(door: AgentDoor | null, pathname: string): AgentRoute {
  if (door === null) return { on: false }
  const at = door.path.length
  const head = pathname.slice(0, at).toLowerCase()
  if (head !== door.path.toLowerCase()) return { on: false }
  const rest = pathname.slice(at)
  if (rest !== '' && !rest.startsWith('/')) return { on: false }
  return { on: true, forward: rest.startsWith('/api/') ? rest : null }
}
