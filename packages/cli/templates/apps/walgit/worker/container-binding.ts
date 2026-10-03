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
import { containerHost, type WalgitDurableContainer } from './durable-container'

/** The bindings and the switch, as every caller's environment carries them. */
export interface ContainerBindings {
  /**
   * The `default`-policy application's object (`WalgitContainer`). The BASE
   * class rather than the subclass, which is defined in index.ts — and index.ts
   * imports this file. All any caller does with it is `fetch`.
   */
  WALGIT_CONTAINER: DurableObjectNamespace<Container>
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
  if (containerPolicyFrom(env) === 'durable_object') {
    if (env.WALGIT_DURABLE_CONTAINER) return containerHost(env.WALGIT_DURABLE_CONTAINER)
    console.error(
      'walgit: WALGIT_CONTAINER_POLICY=durable_object but no WALGIT_DURABLE_CONTAINER binding; ' +
        'routing to the default-policy container',
    )
  }
  return getContainer(env.WALGIT_CONTAINER)
}
