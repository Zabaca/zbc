// The shell a screen is drawn in when a test draws one screen alone: the install's words (company, senders, signing service) and its owner, as the real shell provides them from GET /api/me (src/client/App.tsx). A bare
// component reads them generically (nobody's name), so the suites that pin Northfield's words draw their screens in this, Northfield's own, and the suites on another company draw them in that company's (owner.test.tsx).
import { type ReactNode, createElement } from 'react'
import { createInstall } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { meOf } from '../src/app'
import { InstallContext, installWordsOf } from '../src/client/install'
import { OwnerContext } from '../src/client/owner'

/** What the page is told in Northfield's install. */
export const NORTHFIELD_ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, createInstall(declaration))

/** The shell for `me`: the install's words and the owner. */
export const shellOf = (me: ReturnType<typeof meOf>, children: ReactNode) =>
  createElement(InstallContext.Provider, { value: installWordsOf(me) }, createElement(OwnerContext.Provider, { value: me.owner }, children))

/** Northfield's shell. */
export const inNorthfield = (children: ReactNode) => shellOf(NORTHFIELD_ME, children)
