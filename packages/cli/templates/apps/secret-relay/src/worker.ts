import { type Channel, type ChannelStore, createRelay } from './relay'

/**
 * Cloudflare Worker entrypoint: all channel traffic is routed to a single
 * Durable Object so channel state is strongly consistent, with DO storage
 * backing so channels survive isolate eviction within their TTL.
 */

interface Env {
  CHANNELS: DurableObjectNamespace
}

export class SecretRelayChannels {
  private relay: ReturnType<typeof createRelay>

  constructor(private ctx: DurableObjectState) {
    const storage = ctx.storage
    const store: ChannelStore = {
      async get(id) {
        return (await storage.get<Channel>(`ch:${id}`)) ?? undefined
      },
      async put(id, channel) {
        await storage.put(`ch:${id}`, channel)
      },
      async delete(id) {
        await storage.delete(`ch:${id}`)
      },
    }
    this.relay = createRelay(store)
  }

  fetch(req: Request): Promise<Response> {
    return this.relay.fetch(req)
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    const id = env.CHANNELS.idFromName('relay')
    return env.CHANNELS.get(id).fetch(req)
  },
}
