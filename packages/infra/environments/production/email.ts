import { cloudflareEmailModule } from '../../modules/cloudflare-email'
import inbox from './inbox'

// Cloudflare Email Service for mail.cedarpad.com: outbound sending
// (SPF/DKIM/DMARC/bounce-MX on the subdomain) plus inbound routing with a
// catch-all → the zbc-inbox worker, so agents can invent addresses at
// anything@mail.cedarpad.com on the fly. `imports: [inbox]` is for topo order
// only — the worker must be deployed before the catch-all rule names it.
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
    catchAll: { action: 'worker', workerName: 'zbc-inbox' },
  },
})
