/**
 * Which container a request goes to — the one seam every caller of the
 * container uses (the proxy, the browse and raw routes, the sweep, the MCP
 * reads, the ref-event object).
 *
 * Two container applications exist while a deployment moves from the
 * `default` scheduling policy to `durable_object`, each behind its own Durable
 * Object binding, and `WALGIT_CONTAINER_POLICY` picks one
 * (`containerPolicyFrom`, shared/container-lifecycle.ts). Unset is the old one.
 * That default is the point: `wrangler deploy` puts a Worker live before it
 * creates the container application the Worker's new binding needs, so the
 * deploy that introduces `WalgitDurableContainer` must not also route to it.
 * README.md, "Deployment", has the phases.
 *
 * Both are reached the same way — one named object, `fetch` — so a caller holds
 * a `ContainerFetcher` and never learns which application answered.
 */

import { type Container, getContainer } from '@cloudflare/containers'

import { containerPolicyFrom } from '../shared/container-lifecycle'
import { SERVED_HEADER } from '../shared/protocol'
import { containerHost, type WalgitDurableContainer } from './durable-container'

/** The bindings and the switch, as every caller's environment carries them. */
export interface ContainerBindings {
  /**
   * The `default`-policy application's object (`WalgitContainer`). The BASE
   * class rather than the subclass, which is defined in index.ts — and index.ts
   * imports this file. All any caller does with it is `fetch`.
   */
  WALGIT_CONTAINER?: DurableObjectNamespace<Container>
  /**
   * The `durable_object`-policy application's object. Optional so a Worker
   * deployed from a config that predates it still typechecks against reality:
   * without the binding, the switch below has nothing to switch to.
   */
  WALGIT_DURABLE_CONTAINER?: DurableObjectNamespace<WalgitDurableContainer>
  /** `durable_object` to route to the new application. Edge-only. */
  WALGIT_CONTAINER_POLICY?: string
}

export interface ContainerFetcher {
  fetch(request: Request): Promise<Response>
}

/**
 * The container this deployment routes to.
 *
 * A switch set to `durable_object` on a Worker with no such binding is a
 * configuration that cannot be honoured, and the answer is the old container
 * with an error in the log rather than a refusal of every git request: the
 * old application is still the one that exists.
 */
export function containerFor(env: ContainerBindings): ContainerFetcher {
  return retryingReads(pickContainer(env))
}

/**
 * Send a bodiless read once more when the container never answered it.
 *
 * A deploy resets the Durable Object in front of the container, and a request
 * caught mid-start in that moment is answered `500 Failed to start container:
 * Durable Object reset because its code was updated` — by the object, with no
 * `SERVED_HEADER`, because the container never saw it. The object's own retry
 * dies with it, so the one that works is out here, against the NEW object. Only
 * GET/HEAD, which carry no body to have been consumed, and only once.
 */
/** The runtime's words when a deploy resets a Durable Object mid-request. */
const RESET_BY_DEPLOY = 'reset because its code was updated'

function retryingReads(target: ContainerFetcher): ContainerFetcher {
  return {
    async fetch(request) {
      const response = await target.fetch(request)
      const read = request.method === 'GET' || request.method === 'HEAD'
      if (!read || response.status !== 500 || response.headers.has(SERVED_HEADER)) return response
      // Only the reset. A start that genuinely failed already took its budget,
      // and a second attempt would double the wait it was capped to avoid.
      const text = await response.text()
      if (!text.includes(RESET_BY_DEPLOY)) {
        return new Response(text, { status: response.status, headers: response.headers })
      }
      return target.fetch(request)
    },
  }
}

function pickContainer(env: ContainerBindings): ContainerFetcher {
  if (containerPolicyFrom(env) === 'durable_object') {
    if (env.WALGIT_DURABLE_CONTAINER) return containerHost(env.WALGIT_DURABLE_CONTAINER)
    console.error(
      'walgit: WALGIT_CONTAINER_POLICY=durable_object but no WALGIT_DURABLE_CONTAINER binding; ' +
        'routing to the default-policy container',
    )
  }
  // A config that binds only the new class has nothing else to route to, so
  // the switch is moot: this is every deployment after phase 3.
  if (!env.WALGIT_CONTAINER) {
    if (env.WALGIT_DURABLE_CONTAINER) return containerHost(env.WALGIT_DURABLE_CONTAINER)
    throw new Error('walgit: no container binding (WALGIT_DURABLE_CONTAINER) configured')
  }
  return getContainer(env.WALGIT_CONTAINER)
}
