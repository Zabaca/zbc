// The list of the space's open paths (src/guests.ts) is what the edge, the Worker and the build agree on, so it is pinned as literals: adding a prefix is a change to who can reach the host
// with no sign-in, and must show in a diff of this file.
import { describe, expect, test } from 'bun:test'
import { GUEST_PREFIXES, guestAccessDomain, guestPrefixOf } from '../src'

describe('the open paths', () => {
  test('are exactly three prefixes', () => {
    expect([...GUEST_PREFIXES]).toEqual(['/r', '/w', '/s'])
  })

  test('are told apart from every path of the team’s, and from look-alikes', () => {
    expect(guestPrefixOf('/r/k7m2qx9frtn4w6hbc8jd')).toBe('/r')
    expect(guestPrefixOf('/r/api/rooms/x/join')).toBe('/r')
    expect(guestPrefixOf('/w')).toBe('/w')
    expect(guestPrefixOf('/w/')).toBe('/w')
    expect(guestPrefixOf('/w/api/auth/request')).toBe('/w')
    expect(guestPrefixOf('/s/_/assets/index.js')).toBe('/s')
    for (const team of ['/', '/today', '/inbox', '/meet', '/forms', '/forms/api/clients', '/people', '/knowledge', '/sw.js', '/search', '/recover', '/work', '/rooms', '/api/me', '/api/w/socket', '/agent/inbox', '/assets/index.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
      expect(guestPrefixOf(team)).toBeNull()
    }
  })

  test('are protected at the edge by a path that is the prefix’s subtree and nothing a team path could start with', () => {
    expect(GUEST_PREFIXES.map((p) => guestAccessDomain('space.northfield.example', p))).toEqual(['space.northfield.example/r/*', 'space.northfield.example/w/*', 'space.northfield.example/s/*'])
  })
})
