import { cloudflareEmailModule } from '../../modules/cloudflare-email'
import inbox from './inbox'

// Cloudflare Email Service for mail.cedarpad.com: outbound sending
// (SPF/DKIM/DMARC/bounce-MX on the subdomain) plus inbound routing with a
// catch-all → the zbc-inbox worker, so agents can invent addresses at
// anything@mail.cedarpad.com on the fly. `imports: [inbox]` gives topo order
// (the worker deploys before the catch-all rule binds to it) AND carries the
// deployed worker's name: catchAll.workerName is a `{ from, output }`
// reference into the inbox instance's outputs, so a rename in
// packages/inbox/wrangler.jsonc flows through without touching this file.
export default cloudflareEmailModule.instance({
  name: 'email',
  imports: [inbox],
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    // cedarpad.com zone (looked up via the CF API, 2026-07-15)
    zoneId: '64f220756e063fd23dbd41de8cdd6be4',
    domain: 'mail.cedarpad.com',
    enableSending: true,
    enableRouting: true,
    catchAll: { action: 'worker', workerName: { from: 'inbox', output: 'workerName' } },
  },
})
