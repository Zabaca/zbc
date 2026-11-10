// The install's own names, for the screens that say them: the company a teammate's tag reads, the address a guest's invitation comes from, the host a person is told to allow notifications for, and the
// signing service's name. The page is told by GET /api/me (`Me.company`, `Me.origin`, `Me.senders`, `Me.forms`) and provides them once at the top of the shell (App.tsx), as the owner is (owner.ts), so a screen
// asks for them where it is drawn and never carries them through every layer.
import { createContext, useContext } from 'react'
import type { Me } from '../me'

export interface InstallWords {
  /** The company's name: "Northfield Works" in the bundled install. */
  company: string
  /** The space's host, bare: "space.northfield.example". */
  host: string
  /** The address Meet's invitations and notices come from. */
  meetSender: string
  /** The signing service Forms runs: its name, the address its mail comes from, and who runs it. */
  forms: Me['forms']
}

/** What a page says of an install it has not been told about (a bare component with no shell around it: a test of one screen, a preview): nothing of any company's. */
export const GENERIC_INSTALL: InstallWords = {
  company: 'the company',
  host: 'the space',
  meetSender: 'the sender',
  forms: { service: 'the signing service', sender: 'the sender', runBy: 'the company' },
}

export const installWordsOf = (me: Me): InstallWords => ({ company: me.company.name, host: new URL(me.origin).host, meetSender: me.senders.meet, forms: me.forms })

export const InstallContext = createContext<InstallWords>(GENERIC_INSTALL)
export const useInstall = (): InstallWords => useContext(InstallContext)
