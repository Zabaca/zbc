import { cloudflareModule } from '../../modules/cloudflare'

const pr = process.env.PR_NUMBER ?? 'local'

// Preview: same package as production, deployed as a per-PR worker
// (zbc-design-system-viewer-pr-<N>) via the module's `workerName` override, so
// each PR lands on its own isolated *.workers.dev URL. `destroy preview`
// wrangler-deletes it on PR close.
export default cloudflareModule.instance({
  name: 'design-system-viewer',
  config: {
    workdir: 'packages/design-system-viewer',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: `zbc-design-system-viewer-pr-${pr}`,
    build: {
      command: 'bun run build -- --filter=@zbc/design-system-viewer',
      cwd: '.',
    },
  },
})
