// The install's switches, for the screens that draw a part only where the install has it: no call button where `calls` is off, no phone, no Gmail connection or Calendars section where `gmail` is off. The page is told by GET /api/me
// (`Me.switches`) and provides it once at the top of the shell (App.tsx), so a screen asks for it where it is drawn and never carries it through every layer; the Worker refuses the same parts' paths and each part reads its own switch, so
// hiding is never the only guard.
import { SWITCHES, type Switch } from '@space/workspace'
import { createContext, useContext } from 'react'

export type SwitchesView = Record<Switch, boolean>

/** A bare component (a test of one screen, a preview) with no shell around it is drawn with everything on, as the bundled install has it: what a screen does with a switch off is proved by giving it the shell's value. */
export const EVERYTHING_ON: SwitchesView = Object.fromEntries(SWITCHES.map((s) => [s, true])) as SwitchesView

export const SwitchesContext = createContext<SwitchesView>(EVERYTHING_ON)
export const useSwitches = (): SwitchesView => useContext(SwitchesContext)
