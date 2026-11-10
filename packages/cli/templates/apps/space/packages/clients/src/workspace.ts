/**
 * The company this Worker serves, from the company layer (packages/workspace): who the owners are and which source, if any, the Clients door names. The declaration is bundled into the Worker at build time, the
 * same file the inbox and the space bundle and the deploy reads, so they cannot disagree.
 *
 * `@clients/declaration` is that file: the invented install's for tests and dev (tsconfig.json `paths`, which bun reads), and a company's own when the space is built for it, because the Clients store's Durable Object
 * class is built INTO THE SPACE's Worker, and the space's build says which declaration it serves (packages/space/vite.config.ts, `SPACE_DECLARATION`, which aliases this name too). An install with no source
 * declares no `clientsDoor`, and its store then numbers from 1 and accepts no push.
 */

import { createInstall, type Install } from '@space/workspace'
import declaration from '@clients/declaration'

/** The install this Worker was built for. Tests pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)
