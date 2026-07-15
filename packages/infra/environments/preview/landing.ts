import { cloudflareModule } from '../../modules/cloudflare'

const pr = process.env.PR_NUMBER ?? 'local'

// Preview: same package as production, deployed as a per-PR worker
// (zbc-landing-pr-<N>) via the module's `workerName` override. NATS_URL (in
// wrangler.jsonc) points at the prod nats worker, so preview must mint tokens
// that server accepts: its NATS_ACCOUNT_SIGNING_SEED is the SAME account signing
// key as production, from this environment's secrets.yaml (if unset the
// live-cursor layer degrades to `unavailable`). `destroy preview`
// wrangler-deletes the per-PR worker on close.
export default cloudflareModule.instance({
  name: 'landing',
  config: {
    workdir: 'packages/landing',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: `zbc-landing-pr-${pr}`,
    build: {
      command: 'bun run build -- --filter=@zbc/landing',
      cwd: '.',
    },
    workerSecrets: ['NATS_ACCOUNT_SIGNING_SEED'],
  },
})
