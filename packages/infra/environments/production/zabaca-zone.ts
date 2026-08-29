import { cloudflareZoneModule } from '../../modules/cloudflare-zone'
import zabacaDnsToken from './zabaca-dns-token'

// zabaca.com's DNS, as repo state.
//
// The zone already exists and Cloudflare is already its authoritative
// nameserver; this instance converges the records inside it. It does not create
// or move the zone, and the module has no `destroy` that could remove it.
//
// The reason it exists now is `git.zabaca.com` — walgit's front door. That
// record is the only new one here; everything else is what Cloudflare was
// already serving on the day the zone was adopted, transcribed so the next
// change to this domain is a diff rather than a dashboard visit.
//
// ── git.zabaca.com ────────────────────────────────────────────────────────
//
// `proxied: false` is NOT a default that happened to be left alone. walgit
// serves SSH on port 22, and Cloudflare's proxy carries only its documented
// HTTP(S) port list — a proxied record would leave `git clone git@…` hanging
// with nothing in any log to say why, while smart-HTTP over the same name kept
// working. It is the same wall that put walgit on Fly instead of Cloudflare
// (docs/adr/0006). Grey-cloud also means the Fly IP is visible in DNS, which it
// already is: clients have been cloning from 37.16.14.20 directly.
//
// Both address families point at the same machine. The v4 is a DEDICATED Fly
// IP ($2/mo) because shared IPv4 covers 80/443 only; see the walgit instance.
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
      // walgit — the only new records in this file.
      { type: 'A', name: 'git.zabaca.com', content: '37.16.14.20', proxied: false },
      { type: 'AAAA', name: 'git.zabaca.com', content: '2a09:8280:1::179:baa8:0', proxied: false },
      // Fly's ACME DNS challenge, and it is REQUIRED here rather than optional.
      //
      // Fly's documented default is HTTP-01: it serves the challenge at
      // `/.well-known/acme-challenge/…` on port 80 once A/AAAA point at the
      // app, which they do above. But walgit's fly.toml sets
      // `force_https = true` on port 80, so that path answers `301 ->
      // https://…` — including for the challenge. Validation then needs the
      // certificate that validation is trying to issue, and the certificate
      // sits at "Not verified" forever with nothing failing loudly.
      //
      // The DNS challenge has no such dependency: it proves control of the name
      // through this zone rather than through the app, which also means it does
      // not care that the machine stops whenever it is idle.
      {
        type: 'CNAME',
        name: '_acme-challenge.git.zabaca.com',
        content: 'git.zabaca.com.nwy3m9d.flydns.net',
        proxied: false,
      },

      // Worker-served hostnames. `100::` is Cloudflare's documented placeholder
      // origin for a name served entirely at the edge — the RFC 6666 discard
      // prefix, unroutable by construction, so if the Worker route in front of
      // one ever goes away the request fails closed instead of leaking to
      // whatever answers at a real address. Proxying is what makes these usable
      // at all: Cloudflare answers with its own anycast A and AAAA regardless of
      // the origin's address family, so v4 visitors are unaffected.
      { type: 'AAAA', name: 'zabaca.com', content: '100::', proxied: true },
      { type: 'AAAA', name: 'www.zabaca.com', content: '100::', proxied: true },
      // zbc's own site. Proxied, unlike git.zabaca.com — this one is plain
      // HTTPS with no port-22 problem, so the placeholder origin and a Worker
      // route are all it needs. The route itself is declared on the `landing`
      // instance, not here and not in wrangler.jsonc.
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
