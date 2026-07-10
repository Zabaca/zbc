import { Container, getContainer } from '@cloudflare/containers'

export interface Env {
  NATS_CONTAINER: DurableObjectNamespace<NatsContainer>
  /** NATS auth password (worker secret); forwarded into the container env. */
  NATS_PASSWORD?: string
}

/**
 * A single always-warm Container running nats-server (WebSocket on port 8080).
 * The Worker proxies wss traffic straight through to it, so every connected
 * client shares one NATS server and pub/sub fans out across them.
 */
export class NatsContainer extends Container<Env> {
  // nats-server.conf `websocket.port`. The Worker proxies wss here.
  defaultPort = 8080
  // Survive brief idle gaps. DO idle-eviction can still kill the container and
  // drop live subscriptions — the accepted risk in ADR-0001.
  sleepAfter = '30m'
  // Forwarded into the container env at start; nats-server.conf expands
  // $NATS_PASSWORD from it. (Read lazily at start, after this.env is set.)
  envVars = { NATS_PASSWORD: this.env.NATS_PASSWORD ?? '' }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // No id → a single singleton container, so all clients hit the same NATS
    // server (required for cross-tab pub/sub fan-out).
    const container = getContainer(env.NATS_CONTAINER)
    return container.fetch(request)
  },
}
