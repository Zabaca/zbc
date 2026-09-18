import { cloudflareZoneModule } from '../../modules/cloudflare-zone'
import zabacaDnsToken from './zabaca-dns-token'

// agentgit.co's DNS, as repo state.
//
// The domain was bought through Cloudflare Registrar on 2026-09-18, so the
// zone already exists on this account with Cloudflare as its authoritative
// nameserver and — unlike `zabaca-zone` — held nothing on the day this file
// was written. Every record below is declared, none transcribed.
//
// Both names are served entirely at the edge by the `walgit-public` Worker:
// `100::` is Cloudflare's documented placeholder origin (the RFC 6666 discard
// prefix) for a proxied name whose only origin is a Worker route, so if the
// route ever goes away the request fails closed. The routes themselves are
// declared on `walgit-public`, which imports this instance for ORDER: the
// record has to exist before the route is claimed.
//
// `agentgit.zabaca.com` and `walgit.zabaca.com` stay routed in `zabaca-zone`:
// a git remote is configuration on somebody else's disk, and retiring a
// hostname breaks it silently on their next push.
//
// The token is `zabaca-dns-token`, reused rather than minted again: its "Zone
// Read" + "DNS Write" grant is account-wide (`zones` deliberately unset there),
// so it reaches this zone exactly as it reaches zabaca.com.
//
// `always_use_https` is declared because a bare `http://agentgit.co` in a
// README is the first thing a stranger types, and a git remote over plain HTTP
// would push in the clear.
export default cloudflareZoneModule.instance({
  name: 'agentgit-zone',
  imports: [zabacaDnsToken],
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    zone: 'agentgit.co',
    apiToken: { from: 'zabaca-dns-token', output: 'tokenValue' },
    settings: { always_use_https: 'on' },
    records: [
      { type: 'AAAA', name: 'agentgit.co', content: '100::', proxied: true },
      { type: 'AAAA', name: 'www.agentgit.co', content: '100::', proxied: true },
      // PostHog's managed reverse proxy for the landing page's analytics
      // (`WALGIT_POSTHOG_HOST` on `walgit-public`), so the browser talks to a
      // first-party name. Unproxied because PostHog terminates TLS for the
      // hostname itself, the same shape as `m.zabaca.com`. Added by hand in
      // the PostHog UI on 2026-09-18 and transcribed here the same day, so the
      // zone module stops reading it as drift.
      {
        type: 'CNAME',
        name: 'd.agentgit.co',
        content: '7ed5f6068ed021d42d44.cf-prod-us-proxy.proxyhog.com',
        proxied: false,
      },
    ],
  },
})
