/**
 * The company this Worker serves, from the company layer (packages/workspace).
 *
 * An install is a company's declaration (its workspace.json), bundled into the Worker at build time. The same file gives
 * Access its allow list at deploy (the install kit), so the door and the Worker cannot disagree about who may come in.
 *
 * `@space/declaration` is the declaration file: the one the build names (vite.config.ts, `SPACE_DECLARATION`), and the
 * invented install's for tests and dev (tsconfig.json).
 */
import { createInstall, type Install } from '@space/workspace'
import declaration from '@space/declaration'

/** The install this Worker was built for. Tests and a client's build pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)
