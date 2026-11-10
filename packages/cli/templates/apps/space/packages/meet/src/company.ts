// The company this Worker serves, from the company layer (packages/workspace).
//
// One declaration says who the people are, who owns the install, and how long a sign-in lasts. The
// deploy reads the same file for Access's allow list (the install kit), so the edge and
// this Worker cannot disagree. It is bundled into the Worker at build time: this is the default install, and another company's
// would bundle its own environment's file here.
//
// `@meet/declaration` is that file: the default install's (tsconfig.json `paths`, which bun and tsc read; vite.config.ts, which aliases it for this package's own build), and another company's
// when the space is built for it, because meet's Durable Object classes and its part are built INTO THE SPACE's Worker,
// whose build says which declaration it serves (packages/space/vite.config.ts, `SPACE_DECLARATION`, which aliases this name too).

import { type Install, createInstall } from '@space/workspace'
import declaration from '@meet/declaration'

export const BUNDLED_INSTALL: Install = createInstall(declaration)
