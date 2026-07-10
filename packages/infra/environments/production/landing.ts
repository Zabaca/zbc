import { cloudflareModule } from '../../modules/cloudflare'

// Static Next export + a tiny Worker for the two /api routes (worker/index.ts).
// The module builds out/ locally (turbo) then `wrangler deploy` ships the worker
// + assets (topology in packages/landing/wrangler.jsonc).
//
// NATS config is sourced directly, NOT via `imports: [nats]` — the generic
// cloudflare module can't emit nats's url/user/password as structured outputs.
// NATS_URL / NATS_USER are wrangler vars; NATS_PASSWORD is a worker secret from
// this environment's secrets.yaml.
export default cloudflareModule.instance({
  name: 'landing',
  config: {
    workdir: 'packages/landing',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: {
      command: 'bun run build -- --filter=@zbc/landing',
      cwd: '.',
    },
    workerSecrets: ['NATS_PASSWORD'],
  },
})
