/**
 * Browser analytics on the landing page (`shared/analytics.ts`): off unless an
 * instance set a key, and then exactly one script, carrying that key.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_UI_HOST,
  POSTHOG_DEFAULTS,
  analyticsFrom,
  analyticsScript,
  type AnalyticsEnv,
} from '../shared/analytics'
import { capabilitiesFrom } from '../shared/capabilities'
import { renderLanding } from '../shared/landing'

const HOST = 'agentgit.co'
const caps = capabilitiesFrom({ WALGIT_PUBLIC: '1' })

describe('reading the environment', () => {
  test('no key is no analytics', () => {
    expect(analyticsFrom({})).toBeNull()
    expect(analyticsFrom({ WALGIT_POSTHOG_KEY: '  ' })).toBeNull()
    // A host with no key configures nothing: there is nothing to send.
    expect(analyticsFrom({ WALGIT_POSTHOG_HOST: 'https://eu.i.posthog.com' })).toBeNull()
  })

  test('a key alone means PostHog Cloud US', () => {
    const env: AnalyticsEnv = { WALGIT_POSTHOG_KEY: 'phc_test' }
    expect(analyticsFrom(env)).toEqual({
      key: 'phc_test',
      host: DEFAULT_POSTHOG_HOST,
      uiHost: DEFAULT_POSTHOG_UI_HOST,
    })
  })

  test('a proxy host keeps the app host separate', () => {
    const env: AnalyticsEnv = {
      WALGIT_POSTHOG_KEY: 'phc_test',
      WALGIT_POSTHOG_HOST: 'https://d.example.com',
    }
    const script = analyticsScript(analyticsFrom(env))
    expect(script).toContain('api_host:"https://d.example.com"')
    expect(script).toContain(`ui_host:"${DEFAULT_POSTHOG_UI_HOST}"`)
  })

  test('the host is the instance’s to set', () => {
    const env: AnalyticsEnv = {
      WALGIT_POSTHOG_KEY: 'phc_test',
      WALGIT_POSTHOG_HOST: ' https://eu.i.posthog.com ',
    }
    expect(analyticsFrom(env)?.host).toBe('https://eu.i.posthog.com')
  })
})

describe('the page', () => {
  test('carries no script when nothing is configured', () => {
    const html = renderLanding(HOST, caps)
    expect(html).not.toContain('posthog')
    expect(html).not.toContain('{{ANALYTICS}}')
  })

  test('carries the loader and the init with the key when configured', () => {
    const html = renderLanding(HOST, caps, null, analyticsFrom({ WALGIT_POSTHOG_KEY: 'phc_test' }))
    expect(html).toContain('window.posthog=e')
    expect(html).toContain(
      `posthog.init("phc_test",{api_host:"${DEFAULT_POSTHOG_HOST}",ui_host:"${DEFAULT_POSTHOG_UI_HOST}",defaults:"${POSTHOG_DEFAULTS}"`,
    )
    // No profile for an anonymous reader. Session replay is the project's
    // setting, not the page's, so the snippet says nothing about it.
    expect(html).toContain('person_profiles:"identified_only"')
    expect(html).not.toContain('disable_session_recording')
    // In the head, before the page's own script.
    expect(html.indexOf('posthog.init')).toBeLessThan(html.indexOf('</head>'))
  })

  test('a quote in the key cannot escape the literal', () => {
    const script = analyticsScript({
      key: 'phc_"x',
      host: DEFAULT_POSTHOG_HOST,
      uiHost: DEFAULT_POSTHOG_UI_HOST,
    })
    expect(script).toContain('posthog.init("phc_\\"x"')
  })
})
