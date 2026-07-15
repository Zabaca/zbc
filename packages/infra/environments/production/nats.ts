import { cloudflareModule } from '../../modules/cloudflare'

// Self-hosted NATS (WebSocket) as a DO-bound Cloudflare Container
// (packages/nats-server). No local build — wrangler bundles the worker and
// builds the container from the package's Dockerfile (Docker must be running at
// apply time, on a Workers Paid plan with Containers enabled).
//
// Its stable URL wss://zbc-nats.<subdomain>.workers.dev (or a later custom
// domain) is what landing's NATS_URL var points at. Production-only — there is
// no preview nats instance (landing preview reuses this prod worker).
export default cloudflareModule.instance({
  name: 'nats',
  config: {
    workdir: 'packages/nats-server',
    accountId: '99a19e584439be0568f33aad0477372b',
    // No worker secret: auth is decentralized (NKeys + JWT). The operator and
    // account JWTs are baked into nats-server.conf; the only secret — the account
    // signing seed that mints user tokens — lives in the landing worker, not here.
    // Single always-warm DO-bound container; the gradual default never drains
    // it, so a redeployed image would silently never take effect. Roll now.
    immediateContainerRollout: true,
  },
})
