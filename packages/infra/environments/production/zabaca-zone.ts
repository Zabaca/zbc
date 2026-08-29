import { cloudflareZoneModule } from '../../modules/cloudflare-zone'
import zabacaDnsToken from './zabaca-dns-token'

// zabaca.com's DNS, as repo state.
//
// The zone already exists and Cloudflare is already its authoritative
// nameserver; this instance converges the records inside it. It does not create
// or move the zone, and the module has no `destroy` that could remove it.
//
// It was adopted for `git.zabaca.com` — walgit's front door on Fly. That name
// is retired: walgit dropped SSH and moved onto a Cloudflare Container
// (docs/adr/0008), which removed the raw-TCP requirement that needed an
// unproxied record pointing at a dedicated Fly IP, and the Container
// deployment answers on its own hostname instead. The A, AAAA and ACME-challenge records
// were deleted from the zone along with the Fly app that owned the address.
// What remains here is what Cloudflare was already serving on the day the zone
// was adopted, transcribed so the next change to this domain is a diff rather
// than a dashboard visit.
//
// ── mail ──────────────────────────────────────────────────────────────────
//
// Thirteen live records are absent from this list on purpose: every SPF, DKIM,
// DMARC and Cloudflare bounce-MX on the domain. `cloudflare-zone` classifies
// those STRUCTURALLY (`emailPurpose`) and excludes them from both deletion and
// pairing, because they are provisioned server-side when a domain is onboarded
// for sending — rewriting one in place breaks mail exactly as deleting it
// would, and two SPF records do not merge, they fail. Declaring them here would
// buy nothing and would put a hand-copied DKIM public key in the repo, one
// rotation away from being wrong.
//
// What IS declared is the mail routing that the module does not treat as
// special: the Google Workspace MX at the apex, the two Amazon SES bounce MXes
// under `send.`, and the `google-site-verification` TXT (which is not an email
// policy record and would otherwise read as undeclared drift forever).
//
// ── allowDelete ───────────────────────────────────────────────────────────
//
// Left at its default of false. This is the first apply that has ever looked at
// this zone, and the honest first move is to have it print whatever it does not
// recognise rather than delete it sight unseen. Flip it once an apply reports
// nothing.
export default cloudflareZoneModule.instance({
  name: 'zabaca-zone',
  imports: [zabacaDnsToken],
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    zone: 'zabaca.com',
    apiToken: { from: 'zabaca-dns-token', output: 'tokenValue' },
    records: [
      // Worker-served hostnames. `100::` is Cloudflare's documented placeholder
      // origin for a name served entirely at the edge — the RFC 6666 discard
      // prefix, unroutable by construction, so if the Worker route in front of
      // one ever goes away the request fails closed instead of leaking to
      // whatever answers at a real address. Proxying is what makes these usable
      // at all: Cloudflare answers with its own anycast A and AAAA regardless of
      // the origin's address family, so v4 visitors are unaffected.
      { type: 'AAAA', name: 'zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'www.zabaca.com', content: '100::', proxied: true },
      // zbc's own site. The route itself is declared on the `landing` instance,
      // not here and not in wrangler.jsonc.
      { type: 'AAAA', name: 'zbc.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'ceo.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'crux.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'ledger.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'leeandco.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'qom.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'recon.zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'stiqr.zabaca.com', content: '100::', proxied: true },

      // Cloudflare Tunnel origins. `agent` and `agent-stage` share one tunnel.
      {
        type: 'CNAME',
        name: 'agent.zabaca.com',
        content: '83974ca3-bbd0-4b7b-a025-dee1dd616b00.cfargotunnel.com',
        proxied: true,
      },
      {
        type: 'CNAME',
        name: 'agent-stage.zabaca.com',
        content: '83974ca3-bbd0-4b7b-a025-dee1dd616b00.cfargotunnel.com',
        proxied: true,
      },
      {
        type: 'CNAME',
        name: 'agent-host.zabaca.com',
        content: 'db58907c-c2c2-4852-9e1c-93d957b962b0.cfargotunnel.com',
        proxied: true,
      },

      // Third-party origins, unproxied because each vendor terminates its own
      // TLS for the hostname.
      {
        type: 'CNAME',
        name: 'health.zabaca.com',
        content: '092cefca4a6ad05d.vercel-dns-017.com',
        proxied: false,
      },
      {
        type: 'CNAME',
        name: 'm.zabaca.com',
        content: 'fa7ae13af6ba6d5cd35f.cf-prod-us-proxy.proxyhog.com',
        proxied: false,
      },

      // Dynamic-DNS subtree, delegated away from Cloudflare entirely.
      { type: 'NS', name: 'ddns.zabaca.com', content: 'ns1.dynip.dev' },
      { type: 'NS', name: 'ddns.zabaca.com', content: 'ns2.dynip.dev' },

      // Mail routing the module does not classify as email-provisioned.
      { type: 'MX', name: 'zabaca.com', content: 'smtp.google.com', priority: 1 },
      {
        type: 'MX',
        name: 'send.zabaca.com',
        content: 'feedback-smtp.us-east-1.amazonses.com',
        priority: 10,
      },
      {
        type: 'MX',
        name: 'send.send.zabaca.com',
        content: 'feedback-smtp.us-east-1.amazonses.com',
        priority: 10,
      },
      {
        type: 'TXT',
        name: 'zabaca.com',
        content: 'google-site-verification=tgCds1AZvjcumSPHM1c_uzYa6weRGbtLvUVNO-Ldut0',
      },
    ],
  },
})
