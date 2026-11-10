// /r/<name>: look at the call, show the lobby, then the call. A name that was
// never started says so instead of opening an empty call.

import { useEffect, useState } from 'react'
import type { RoomInfo } from '../model'
import { ApiError, type PausedInfo, api, memberToken } from './api'
import Call from './Call'
import type { JoinPlan } from './Lobby'
import Lobby from './Lobby'
import type { Route } from './route'
import { Wordmark } from './ui'

type Stage =
  | { s: 'loading' }
  | { s: 'missing' }
  | { s: 'error'; message: string }
  | { s: 'lobby'; info: RoomInfo & PausedInfo }
  | { s: 'call'; plan: JoinPlan }

export default function Room({ route }: { route: Extract<Route, { view: 'call' }> }) {
  const [stage, setStage] = useState<Stage>({ s: 'loading' })
  const token = memberToken(route.name)

  useEffect(() => {
    let live = true
    api
      .lobby(route.name)
      .then((info) => live && setStage({ s: 'lobby', info }))
      .catch((e: unknown) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 404) setStage({ s: 'missing' })
        else setStage({ s: 'error', message: e instanceof Error ? e.message : 'Could not reach the call.' })
      })
    return () => {
      live = false
    }
  }, [route.name])

  if (stage.s === 'call') {
    return <Call plan={stage.plan} room={route.name} token={token} forceRelay={route.forceRelay} debug={route.debug} />
  }
  if (stage.s === 'lobby') {
    return <Lobby room={route.name} info={stage.info} blurPath={route.blurPath} debug={route.debug} onJoin={(plan) => setStage({ s: 'call', plan })} />
  }
  return (
    <main className="page page-center">
      <Wordmark />
      {stage.s === 'loading' && <p className="lede">Looking for the call.</p>}
      {stage.s === 'missing' && (
        <>
          <h1 className="title">This is not a call.</h1>
          <p className="lede">The link may have been copied wrong. Ask the person who sent it for a new one.</p>
        </>
      )}
      {stage.s === 'error' && (
        <>
          <h1 className="title">Could not reach the call.</h1>
          <p className="lede">{stage.message}</p>
        </>
      )}
    </main>
  )
}
