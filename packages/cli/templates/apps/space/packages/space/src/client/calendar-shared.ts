// What the Calendar tab's parts (Calendar.tsx, CalendarViews.tsx) draw alike: how a link is followed in the page, and an account's colour slot.
import type { MouseEvent } from 'react'

export type Go = (path: string) => void

/** A plain click on a link goes through the page's own `go` (no reload); a modified click or another button is left to the browser. */
export function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

/** The account's colour slot, as the style sheet names it. */
export const hueClass = (hue: number): string => `hue-${((hue % 6) + 6) % 6}`
