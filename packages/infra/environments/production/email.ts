import { cloudflareEmailModule } from '../../modules/cloudflare-email'

// Cloudflare Email Service for mail.cedarpad.com: outbound sending
// (SPF/DKIM/DMARC/bounce-MX on the subdomain). Inbound routing stays on with a
// catch-all that drops: the Worker that used to read mail sent to
// anything@mail.cedarpad.com (the `inbox` app template) is gone, and a
// catch-all left naming a Worker that no longer exists would fail every
// delivery instead of discarding it. Omitting `catchAll` would leave that rule
// as it was, which is why it is stated.
export default cloudflareEmailModule.instance({
  name: 'email',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    // cedarpad.com zone (looked up via the CF API, 2026-07-15)
    zoneId: '64f220756e063fd23dbd41de8cdd6be4',
    domain: 'mail.cedarpad.com',
    enableSending: true,
    enableRouting: true,
    catchAll: { action: 'drop' },
  },
})
