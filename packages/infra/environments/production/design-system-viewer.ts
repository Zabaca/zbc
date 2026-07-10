import { cloudflareModule } from '../../modules/cloudflare'

// Static Astro build → Cloudflare Workers static assets. The module builds
// dist/ locally (turbo) then `wrangler deploy` ships it as an assets-only
// worker (topology in packages/design-system-viewer/wrangler.jsonc). Lands on
// zbc-design-system-viewer.<subdomain>.workers.dev — no custom domain.
export default cloudflareModule.instance({
  name: 'design-system-viewer',
  config: {
    workdir: 'packages/design-system-viewer',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: {
      command: 'bun run build -- --filter=@zbc/design-system-viewer',
      cwd: '.',
    },
  },
})
