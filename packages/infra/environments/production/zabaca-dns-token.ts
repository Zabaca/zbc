import { cloudflareTokenModule } from '../../modules/cloudflare-token'

// The DNS credential for zabaca.com, minted per-apply from CLOUDFLARE_ROOT_TOKEN.
//
// It exists so `zabaca-zone` has a token to read without a second Cloudflare
// secret at rest: cloudflare-token rolls the value on every apply, the value
// lives only in memory for the length of that apply, and it reaches the zone
// module through `imports` rather than through secrets.yaml. Corollary from
// that module's docstring — never copy this token for local use, it dies on
// the next apply.
//
// Scopes are the two the zone module actually calls: "Zone Read" to resolve
// zabaca.com to a zone id, "DNS Write" to converge dns_records.
//
// `zones` is deliberately NOT set, which grants both groups across every zone
// in the account rather than zabaca.com alone. Narrowing it would be better,
// but resolving a zone NAME to an id happens with the ROOT token, and
// root-ryzen-cf holds only "Account API Tokens Write" — so a `zones` entry here
// fails the apply at zone lookup rather than tightening anything. Revisit if
// the root token ever gains "Zone Read".
export default cloudflareTokenModule.instance({
  name: 'zabaca-dns-token',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tokenName: 'zabaca-dns',
    permissions: ['Zone Read', 'DNS Write'],
  },
})
