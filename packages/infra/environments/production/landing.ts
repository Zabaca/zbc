import { cloudflareModule } from '../../modules/cloudflare'
import zabacaZone from './zabaca-zone'

// Static Next export + a tiny Worker for the two /api routes (worker/index.ts).
// The module builds out/ locally (turbo) then `wrangler deploy` ships the worker
// + assets (topology in packages/landing/wrangler.jsonc).
//
// NATS config is sourced directly, NOT via `imports: [nats]` — the generic
// cloudflare module can't emit nats's structured outputs. NATS_URL /
// NATS_ACCOUNT_ID are wrangler vars; NATS_ACCOUNT_SIGNING_SEED is a worker secret
// from this environment's secrets.yaml, the key the worker signs per-session
// user JWTs with. It never reaches the browser.
// `zbc.zabaca.com` is the site's real home; the *.workers.dev URL keeps
// working alongside it. The AAAA record lives in `zabaca-zone`, which this
// imports for ORDER, not for a value — the record has to exist before the route
// is claimed.
//
// The route is HERE rather than in wrangler.jsonc on purpose. Preview PRs
// deploy the same wrangler.jsonc under a per-PR `workerName`, and a Cloudflare
// route is unique per zone, so a route in that file would have the most
// recently deployed PR quietly take production's traffic.
export default cloudflareModule.instance({
  name: 'landing',
  imports: [zabacaZone],
  config: {
    routes: ['zbc.zabaca.com/*'],
    workdir: 'packages/landing',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: {
      command: 'bun run build -- --filter=@zbc/landing',
      cwd: '.',
    },
    workerSecrets: ['NATS_ACCOUNT_SIGNING_SEED'],
  },
})
