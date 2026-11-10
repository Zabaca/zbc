// The Forms tab's sections: one line each. Drawn twice, as the tree under Forms in the rail and as a row across the top of the screen on a phone. Its own file, with no screen in
// it, so the rail can draw the tree without loading the screens (the tab is loaded when it is first opened: App.tsx).

export interface NavItem {
  to: string
  label: string
  /** The section is current for any path this matches. */
  active: RegExp
}

export const NAV: NavItem[] = [
  { to: '/clients', label: 'Clients', active: /^\/(clients.*)?$/ },
  { to: '/envelopes', label: 'Envelopes', active: /^\/(envelopes.*|send)$/ },
  { to: '/forms', label: 'Forms', active: /^\/forms/ },
  { to: '/documents', label: 'Documents', active: /^\/documents/ },
  { to: '/seal', label: 'Seal', active: /^\/seal$/ },
  { to: '/history', label: 'History', active: /^\/history$/ },
]

/** Whether the section is current for a place in the tab (`/envelopes?x=1` is on Envelopes). */
export const isOn = (n: NavItem, place: string): boolean => n.active.test(place.split('?')[0] ?? '/')
