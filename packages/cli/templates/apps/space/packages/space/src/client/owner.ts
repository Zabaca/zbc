// The install's owner, for the screens that name them: "Claude, on <name>'s word", the address Claude's send goes out from, and who "you" is in a history. The page is told by GET /api/me (`Me.owner`) and
// provides it once at the top of the shell (App.tsx), so a screen asks for it where it is drawn and never carries it through every layer.
import { createContext, useContext } from 'react'
import type { Me } from '../me'

export type OwnerView = Me['owner']

/** A bare component (a test of one screen, a preview) with no shell around it reads the owner generically: nobody's name, no address. */
export const OwnerContext = createContext<OwnerView>({ name: 'the owner', address: '' })
export const useOwner = (): OwnerView => useContext(OwnerContext)
