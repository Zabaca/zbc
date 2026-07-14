'use client'

/**
 * Live cursors — every visitor's pointer, fanned out to every other visitor
 * through the self-hosted NATS server (packages/nats-server), over WebSocket.
 *
 * Protocol (subject `landing.cursors.<id>`, JSON body):
 *   { n: name, c: color, x: fraction of page width, y: document px }
 *   { bye: true }                                         on unload
 *
 * The sender's id is the last subject token — never a field in the body. See
 * the subscribe handler for why that distinction is load-bearing here.
 *
 * x travels as a fraction of page width so a peer on a 1440px screen lands in
 * the right column of a 390px one; y travels as an absolute document offset so
 * cursors stay pinned to the text they're pointing at while everyone scrolls.
 *
 * The credentials come from the Worker's /api/nats-config, which only exists in
 * the deployed Worker — under `next dev` it 404s and we show `unavailable`.
 */

import { useEffect, useRef, useState } from 'react'
import { connect, type NatsConnection } from 'nats.ws'

const SUBJECT_ROOT = 'landing.cursors'
const PUBLISH_INTERVAL_MS = 50 // 20 updates/sec — smooth without flooding
const HEARTBEAT_MS = 2000 // re-announce while idle, comfortably inside the TTL
const PEER_TTL_MS = 5000 // a peer silent for this long is treated as gone
const MAX_PEERS = 50 // a crowd, not a flood — see the subscribe handler

/** Cursor colors, legible on both paper and ink grounds. */
const COLORS = ['#B8410E', '#2F6B3C', '#3A5FA8', '#8A5AA8', '#B07A12', '#0E7B7B']

/**
 * The cursor's outline and its label text. Deliberately theme-INVARIANT: a
 * cursor sits on a saturated peer color that does not flip between themes, so
 * its chrome must not flip either — a token here (`text-paper-0`) would turn
 * near-black in dark mode and disappear against the badge. This is
 * --color-paper-0's light value, pinned on purpose.
 */
const CURSOR_CHROME = '#FBFAF7'

type Status = 'connecting' | 'live' | 'unavailable' | 'error'

type Peer = { id: string; name: string; color: string; x: number; y: number; seen: number }

/** Wire format. The sender's identity is the subject, not a field in here. */
type CursorMsg = {
  n?: string
  c?: string
  x?: number
  y?: number
  bye?: boolean
}

function makeIdentity() {
  const id = Math.random().toString(16).slice(2, 8)
  return {
    id,
    name: `anon-${id.slice(0, 3)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] as string,
  }
}

export function LiveCursors() {
  const [status, setStatus] = useState<Status>('connecting')
  const [peers, setPeers] = useState<Peer[]>([])
  const [scrollY, setScrollY] = useState(0)
  const [pageWidth, setPageWidth] = useState(0)

  const ncRef = useRef<NatsConnection | null>(null)
  // Lazily: useRef(makeIdentity()) would re-roll a fresh identity on every
  // render and throw it away.
  const meRef = useRef<ReturnType<typeof makeIdentity> | null>(null)
  if (meRef.current === null) meRef.current = makeIdentity()
  const me = meRef.current
  const peersRef = useRef<Map<string, Peer>>(new Map())
  const lastSentRef = useRef(0)
  const myPosRef = useRef<{ x: number; y: number } | null>(null)
  /** Set when a peer message lands; the rAF loop reads and clears it. */
  const dirtyRef = useRef(false)

  // ---- connect + subscribe -------------------------------------------------
  useEffect(() => {
    let cancelled = false

    async function run() {
      let cfg: { url: string; user: string; password: string }
      try {
        const res = await fetch('/api/nats-config')
        if (!res.ok) {
          // 503 (env unset) or 404 (running under `next dev`, where the Worker
          // route doesn't exist). Either way: no realtime, page still works.
          if (!cancelled) setStatus('unavailable')
          return
        }
        cfg = await res.json()
      } catch {
        if (!cancelled) setStatus('unavailable')
        return
      }

      try {
        const nc = await connect({
          servers: [cfg.url],
          user: cfg.user,
          pass: cfg.password,
          noEcho: true, // don't echo our own cursor back to us
          name: `landing-${me.id}`,
        })
        if (cancelled) {
          await nc.close()
          return
        }
        ncRef.current = nc
        setStatus('live')

        const sub = nc.subscribe(`${SUBJECT_ROOT}.*`)
        ;(async () => {
          for await (const msg of sub) {
            // Identity comes from the SUBJECT, never from the payload. The NATS
            // credential is public (the page hands it to every visitor), so any
            // client can publish anything — but nats-server pins each message to
            // the subject it was published on. Trusting a payload `id` instead
            // would let anyone evict a peer, hijack their cursor, or invent
            // thousands of fake ones.
            const id = msg.subject.slice(SUBJECT_ROOT.length + 1)
            if (!id || id === me.id) continue

            let data: CursorMsg
            try {
              data = msg.json<CursorMsg>()
            } catch {
              continue // not our shape — ignore it
            }

            if (data?.bye) {
              peersRef.current.delete(id)
              dirtyRef.current = true
              continue
            }

            // Finite check, not just typeof: a peer sending Infinity or NaN
            // would otherwise translate a cursor to an unrenderable offset.
            if (
              typeof data?.x !== 'number' ||
              typeof data?.y !== 'number' ||
              !Number.isFinite(data.x) ||
              !Number.isFinite(data.y)
            ) {
              continue
            }

            // Bound the map. Without this, one client publishing on thousands of
            // subjects would grow it without limit and we'd render a cursor for
            // every one, locking up the tab.
            if (peersRef.current.size >= MAX_PEERS && !peersRef.current.has(id)) continue

            dirtyRef.current = true
            peersRef.current.set(id, {
              id,
              name: typeof data.n === 'string' ? data.n.slice(0, 16) : 'anon',
              color:
                typeof data.c === 'string' && /^#[0-9a-f]{6}$/i.test(data.c) ? data.c : '#5A584C',
              x: data.x,
              y: data.y,
              seen: Date.now(),
            })
          }
        })()

        // A dropped connection should read as degraded, not as a live page
        // with a frozen cursor field.
        ;(async () => {
          for await (const s of nc.status()) {
            if (cancelled) return
            if (s.type === 'disconnect') setStatus('error')
            if (s.type === 'reconnect') setStatus('live')
          }
        })()
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    run()

    return () => {
      cancelled = true
      const nc = ncRef.current
      ncRef.current = null
      nc?.close()
    }
  }, [me])

  // ---- publish our own cursor ---------------------------------------------
  useEffect(() => {
    function publish(body: CursorMsg) {
      const nc = ncRef.current
      if (!nc || nc.isClosed()) return
      nc.publish(`${SUBJECT_ROOT}.${me.id}`, JSON.stringify(body))
    }

    function send(force = false) {
      const pos = myPosRef.current
      if (!pos) return
      const now = Date.now()
      if (!force && now - lastSentRef.current < PUBLISH_INTERVAL_MS) return
      lastSentRef.current = now
      const width = document.documentElement.clientWidth || 1
      publish({ n: me.name, c: me.color, x: pos.x / width, y: pos.y })
    }

    function onMove(e: PointerEvent) {
      myPosRef.current = { x: e.clientX, y: e.clientY + window.scrollY }
      send()
    }
    function onLeave() {
      publish({ bye: true })
    }

    // A reader who stops moving is still here. Without this heartbeat they go
    // silent, everyone else reaps them at PEER_TTL_MS, and the count drops to
    // zero while the page is full of people.
    const beat = setInterval(() => send(true), HEARTBEAT_MS)

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pagehide', onLeave)
    return () => {
      clearInterval(beat)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pagehide', onLeave)
      // No farewell publish here: effect cleanups run in declaration order, so
      // the connect effect above has already closed the socket by now. `pagehide`
      // is what covers a real departure; peers also expire on PEER_TTL_MS.
    }
  }, [me])

  // ---- render loop: expire stale peers, follow the scroll ------------------
  useEffect(() => {
    // Only worth running when there's a live connection — under `next dev`, or
    // any 503, no cursor can ever arrive and this would spin forever for nothing.
    if (status !== 'live') return

    // One rAF loop drives everything. Peer updates land in a ref (not state),
    // so React only re-renders on a frame where something actually changed —
    // not 60 times a second for a page nobody is moving on.
    let raf = 0
    let lastScroll = -1
    let lastWidth = -1

    function frame() {
      const now = Date.now()
      const cutoff = now - PEER_TTL_MS
      let changed = false

      for (const [id, p] of peersRef.current) {
        if (p.seen < cutoff) {
          peersRef.current.delete(id)
          changed = true
        }
      }
      if (dirtyRef.current) {
        dirtyRef.current = false
        changed = true
      }
      if (changed) setPeers([...peersRef.current.values()])

      const y = window.scrollY
      const w = document.documentElement.clientWidth
      if (y !== lastScroll) {
        lastScroll = y
        setScrollY(y)
      }
      if (w !== lastWidth) {
        lastWidth = w
        setPageWidth(w)
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => cancelAnimationFrame(raf)
  }, [status])

  return (
    <>
      <CursorLayer peers={peers} scrollY={scrollY} pageWidth={pageWidth} />
      <PresenceBadge status={status} count={peers.length} />
    </>
  )
}

// ---- the cursors themselves -----------------------------------------------

function CursorLayer({
  peers,
  scrollY,
  pageWidth,
}: {
  peers: Peer[]
  scrollY: number
  pageWidth: number
}) {
  if (peers.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden="true">
      {peers.map((p) => (
        <div
          key={p.id}
          className="absolute top-0 left-0 will-change-transform"
          style={{ transform: `translate3d(${p.x * pageWidth}px, ${p.y - scrollY}px, 0)` }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <title>{p.name}</title>
            <path
              d="M2 1.5 L2 14 L5.2 10.9 L7.4 15.6 L9.8 14.5 L7.6 9.9 L12 9.6 Z"
              fill={p.color}
              stroke={CURSOR_CHROME}
              strokeWidth="1"
            />
          </svg>
          <span
            className="relative left-[10px] inline-block max-w-[12ch] truncate rounded-1 px-[6px] py-[2px] font-mono text-3xs"
            style={{ backgroundColor: p.color, color: CURSOR_CHROME }}
          >
            {p.name}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---- the "who else is here" line ------------------------------------------

const STATUS_COPY: Record<Status, string> = {
  connecting: 'connecting…',
  live: '', // replaced by the peer count
  unavailable: 'realtime unavailable here — it runs on the deployed Worker',
  error: 'lost the connection — retrying',
}

function PresenceBadge({ status, count }: { status: Status; count: number }) {
  const dotClass =
    status === 'live'
      ? 'bg-positive'
      : status === 'error'
        ? 'bg-critical'
        : status === 'connecting'
          ? 'bg-ink-3'
          : 'bg-ink-4'

  const label =
    status === 'live'
      ? count === 0
        ? "you're the only one here right now"
        : `${count} ${count === 1 ? 'other person' : 'other people'} here`
      : STATUS_COPY[status]

  return (
    <p className="label-mono m-0 flex items-center gap-3" role="status" aria-live="polite">
      <span className={`inline-block size-2 shrink-0 rounded-full ${dotClass}`} />
      {label}
    </p>
  )
}
