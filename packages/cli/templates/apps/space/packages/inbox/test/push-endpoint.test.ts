import { expect, test } from 'bun:test'
import { northfieldSettings } from '../../../kit/northfield'
import { PUSH_PATH, pushSettings } from '../src/gmail/push'
import { bundledInstall } from '../src/workspace'
import { PUSH_ENDPOINT } from '../test-support/harness'

/**
 * The push hostname and path are written in places that must agree: the Worker's declared host (so it refuses everything on that hostname even with its settings missing), the space Worker's routes (the
 * install kit's settings, which make wrangler create the hostname), and the endpoint the tests push to. A deployed install's Google subscription is the third, held equal to its own declaration beside its
 * environment.
 */

const settings = northfieldSettings as { routes: unknown[] }

test('the install’s push host, its routes and the harness’s push endpoint name the same endpoint', () => {
  const PUSH_HOST = bundledInstall.gmailPushHost() as string
  const endpoint = `https://${PUSH_HOST}${PUSH_PATH}`
  expect(PUSH_ENDPOINT).toBe(endpoint)
  expect(settings.routes).toContainEqual({
    pattern: PUSH_HOST,
    custom_domain: true,
  })
  expect(
    pushSettings({ GMAIL_PUSH_ENDPOINT: endpoint, GMAIL_PUSH_SERVICE_ACCOUNT: 'a@project.iam.gserviceaccount.com' }),
  ).toMatchObject({
    ok: true,
    host: PUSH_HOST,
    path: PUSH_PATH,
  })
})
