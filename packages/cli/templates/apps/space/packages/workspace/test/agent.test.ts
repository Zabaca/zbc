import { describe, expect, test } from 'bun:test'
import { agentRoute, clientsRoute, createInstall, DeclarationError, parseDeclaration, refusalStatus, telegramRoute } from '../src'
import { lane, PINECREST_FILE, readJson, NORTHFIELD_FILE, northfield } from './helpers'

const raw = () => structuredClone(readJson(NORTHFIELD_FILE)) as Record<string, any>

function problems(input: unknown): string[] {
  try {
    parseDeclaration(input)
  } catch (e) {
    if (e instanceof DeclarationError) return e.problems
    throw e
  }
  return []
}

describe('Claude’s door on the space, as declared', () => {
  test('Northfield’s is /agent/inbox on the space’s host, admitting the inbox’s one token', () => {
    expect(northfield().agentDoor()).toEqual({
      path: '/agent/inbox',
      domain: 'space.northfield.example/agent/inbox',
      url: 'https://space.northfield.example/agent/inbox',
    })
  })

  test('an install that declares none has none, and a client’s never has one', () => {
    const r = raw()
    delete r.agent
    r.switches.claudeScript = false
    expect(createInstall(r).agentDoor()).toBeNull()
    expect(lane().agentDoor()).toBeNull()
  })

  test('the door is on the space’s host', () => {
    expect(northfield().agentDoor()?.domain).toBe('space.northfield.example/agent/inbox')
  })

  test('it needs the claudeScript switch, and the name of its token is the install file’s, not the declaration’s', () => {
    const r = raw()
    r.agent.serviceToken = 'northfield-web inbox agent'
    expect(problems(r).join()).toContain('unknown field "serviceToken"')
    const off = raw()
    off.switches.claudeScript = false
    expect(problems(off).join()).toContain('agent: the claudeScript switch must be on')
    const none = raw()
    delete none.agent
    expect(problems(none).join()).toContain('agent: the claudeScript switch is on')
    const client = structuredClone(readJson(PINECREST_FILE)) as Record<string, any>
    client.agent = { path: '/agent/inbox' }
    expect(problems(client).join()).toContain('agent')
  })

  test('it is never a path of the space’s own: the API, a tab, or the root', () => {
    for (const path of ['/api', '/api/inbox', '/forms', '/forms/agent', '/inbox', '/meet/phone', '/today', '/calendar', '/people', '/knowledge']) {
      const r = raw()
      r.agent.path = path
      expect(problems(r).join(), path).toContain('agent.path')
    }
    for (const path of ['/', '', '/agent/inbox/', 'agent/inbox', '/Agent/Inbox', 7]) {
      const r = raw()
      r.agent.path = path
      expect(problems(r).join(), String(path)).toContain('agent.path')
    }
  })
})

describe('the status a refusal is answered with, one split for the space and the inbox', () => {
  test('no proof or a proof that does not verify is 401; a verified one that is not let in is 403', () => {
    expect((['no-assertion', 'invalid'] as const).map(refusalStatus)).toEqual([401, 401])
    expect((['ambiguous', 'service-token', 'not-a-person-here'] as const).map(refusalStatus)).toEqual([403, 403, 403])
  })
})

describe('which requests are on Claude’s door', () => {
  const route = (path: string) => agentRoute(northfield(), path)

  test('the inbox’s API under the door is handed on at its own path', () => {
    expect(route('/agent/inbox/api/queue')).toEqual({ on: true, forward: '/api/queue' })
    expect(route('/agent/inbox/api/drafts/abc/send')).toEqual({ on: true, forward: '/api/drafts/abc/send' })
    expect(route('/agent/inbox/api/search')).toEqual({ on: true, forward: '/api/search' })
  })

  test('the door matches without regard to case, as Access does, and what follows it is kept as written', () => {
    expect(route('/AGENT/Inbox/api/Queue')).toEqual({ on: true, forward: '/api/Queue' })
  })

  test('under the door but not the inbox’s API is on the door and goes nowhere', () => {
    for (const path of ['/agent/inbox', '/agent/inbox/', '/agent/inbox/index.html', '/agent/inbox/assets/x.js', '/agent/inbox/apix', '/agent/inbox/api']) {
      expect(route(path), path).toEqual({ on: true, forward: null })
    }
  })

  test('every other path of the space is not on it, the near misses included', () => {
    for (const path of ['/', '/api/me', '/api/inbox/queue', '/conversations', '/forms/api/x', '/agent', '/agent/', '/agent/inboxx/api/queue', '/agent/other/api/queue', '/x/agent/inbox/api/queue']) {
      expect(route(path), path).toEqual({ on: false })
    }
  })

  test('an install with no door has no path on it', () => {
    expect(agentRoute(lane(), '/agent/inbox/api/queue')).toEqual({ on: false })
  })
})

describe('the Telegram bridge’s door on the space, as declared', () => {
  test('Northfield’s is /agent/telegram on the space’s host, admitting a token of its own', () => {
    expect(northfield().telegramDoor()).toEqual({
      path: '/agent/telegram',
      domain: 'space.northfield.example/agent/telegram',
      url: 'https://space.northfield.example/agent/telegram',
    })
  })

  test('an install that declares none has none, and a client’s never has one', () => {
    const r = raw()
    delete r.telegram
    r.switches.telegram = false
    expect(createInstall(r).telegramDoor()).toBeNull()
    expect(lane().telegramDoor()).toBeNull()
  })

  test('it needs the telegram switch, and the switch needs it', () => {
    const off = raw()
    off.switches.telegram = false
    expect(problems(off).join()).toContain('telegram: only where the telegram switch is on')
    const none = raw()
    delete none.telegram
    expect(problems(none).join()).toContain('telegram: the telegram switch is on')
    const client = structuredClone(readJson(PINECREST_FILE)) as Record<string, any>
    client.telegram = { path: '/agent/telegram' }
    expect(problems(client).join()).toContain('telegram')
  })

  test('it needs a path of the space, and no token name (the install file’s)', () => {
    const withToken = raw()
    withToken.telegram.serviceToken = 'telegram bridge'
    expect(problems(withToken).join()).toContain('unknown field "serviceToken"')
    const noPath = raw()
    delete noPath.telegram.path
    expect(problems(noPath).join()).toContain('telegram.path')
  })

  test('it is never a path of the space’s own', () => {
    for (const path of ['/api', '/api/telegram', '/forms', '/inbox', '/meet/phone', '/today', '/calendar', '/people', '/knowledge']) {
      const r = raw()
      r.telegram.path = path
      expect(problems(r).join(), path).toContain('telegram.path')
    }
    for (const path of ['/', '', '/agent/telegram/', 'agent/telegram', '/Agent/Telegram', 7]) {
      const r = raw()
      r.telegram.path = path
      expect(problems(r).join(), String(path)).toContain('telegram.path')
    }
  })

  test('each machine has a path of its own: the bridge’s is never Claude’s, inside it or around it', () => {
    for (const path of ['/agent/inbox', '/agent/inbox/telegram']) {
      const r = raw()
      r.telegram.path = path
      expect(problems(r).join(), path).toContain('telegram.path')
    }
    const around = raw()
    around.agent.path = '/agent/telegram/inbox'
    expect(problems(around).join()).toContain('telegram.path')
  })
})

describe('which requests are on the Telegram bridge’s door', () => {
  const route = (path: string) => telegramRoute(northfield(), path)

  test('only its own path, and only its /api/ is forwarded', () => {
    expect(route('/agent/telegram/api/push')).toEqual({ on: true, forward: '/api/push' })
    expect(route('/AGENT/Telegram/api/push')).toEqual({ on: true, forward: '/api/push' })
    expect(route('/agent/telegram')).toEqual({ on: true, forward: null })
    expect(route('/agent/telegram/index.html')).toEqual({ on: true, forward: null })
    expect(route('/agent/telegramx/api/push')).toEqual({ on: false })
    expect(route('/agent/inbox/api/queue')).toEqual({ on: false })
    expect(route('/api/push')).toEqual({ on: false })
  })

  test('Claude’s door does not answer for it, and it does not answer for Claude’s', () => {
    expect(agentRoute(northfield(), '/agent/telegram/api/push')).toEqual({ on: false })
    expect(telegramRoute(northfield(), '/agent/inbox/api/queue')).toEqual({ on: false })
  })

  test('a client has no such door', () => {
    expect(telegramRoute(lane(), '/agent/telegram/api/push')).toEqual({ on: false })
  })
})

describe('which requests are on the Clients door', () => {
  const route = (path: string) => clientsRoute(northfield(), path)

  test('only its own path, and only its /api/ is forwarded', () => {
    expect(route('/agent/clients/api/clients')).toEqual({ on: true, forward: '/api/clients' })
    expect(route('/AGENT/Clients/api/clients/7/gone')).toEqual({ on: true, forward: '/api/clients/7/gone' })
    expect(route('/agent/clients')).toEqual({ on: true, forward: null })
    expect(route('/agent/clientsx/api/clients')).toEqual({ on: false })
    expect(route('/api/clients')).toEqual({ on: false })
  })

  test('the other two doors do not answer for it, and it does not answer for theirs', () => {
    expect(agentRoute(northfield(), '/agent/clients/api/clients')).toEqual({ on: false })
    expect(telegramRoute(northfield(), '/agent/clients/api/clients')).toEqual({ on: false })
    expect(route('/agent/inbox/api/queue')).toEqual({ on: false })
    expect(route('/agent/telegram/api/push')).toEqual({ on: false })
  })

  test('a client has no such door', () => {
    expect(clientsRoute(lane(), '/agent/clients/api/clients')).toEqual({ on: false })
  })
})
