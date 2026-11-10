/**
 * Which install a command-line script works on. A script that reads or changes a deployed install is told which one, never guessing a company's files:
 *
 *   SPACE_DECLARATION   the path of the install's declaration (workspace.json)
 *   SPACE_SECRETS       the path of its sops secrets file; left out, `secrets.yaml` beside the declaration
 *
 * The project that holds the install sets both where it runs a script (a wrapper of its own, or its shell). Not imported by the Worker.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ProjectEnv {
  /** The declaration's file, absolute. */
  declaration: string
  /** The sops secrets file, absolute. It may not exist: a script that needs it says so when it reads it. */
  secrets: string
}

export const HOW_TO_NAME_THE_INSTALL =
  'Name the install this works on: set SPACE_DECLARATION to the path of its workspace.json (its sops file is SPACE_SECRETS, or secrets.yaml beside the declaration).'

/** The install the environment names, or null when it names none. Throws when the declaration it names is not there. */
export function projectEnv(env: Record<string, string | undefined> = process.env): ProjectEnv | null {
  const named = env.SPACE_DECLARATION?.trim()
  if (!named) return null
  const declaration = resolve(named)
  if (!existsSync(declaration)) throw new Error(`SPACE_DECLARATION names ${declaration}, which is not there`)
  const secrets = env.SPACE_SECRETS?.trim()
  return { declaration, secrets: secrets ? resolve(secrets) : join(dirname(declaration), 'secrets.yaml') }
}

/** The install the environment names; a script that cannot run without one stops with the sentence that says how to name it. */
export function requireProjectEnv(env: Record<string, string | undefined> = process.env): ProjectEnv {
  const found = projectEnv(env)
  if (found === null) throw new Error(HOW_TO_NAME_THE_INSTALL)
  return found
}

/** The declaration's JSON, for `createInstall`. */
export const readDeclaration = (project: ProjectEnv): unknown => JSON.parse(readFileSync(project.declaration, 'utf8'))
