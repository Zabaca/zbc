import { flyModule } from '../../modules/fly'
import walgitWal from './walgit-wal'
import zabacaZone from './zabaca-zone'

// walgit — a git host served over SSH (:22) and smart-HTTP (:443) from a Fly
// machine that stops when idle and autostarts on the next connection (~1.35 s,
// measured in the M0 spike). packages/walgit is a symlink into the generic
// app template at packages/cli/templates/apps/walgit; everything
// project-specific is here.
//
// `ipv4: "dedicated"` is NOT optional: a shared IPv4 serves ports 80/443 only,
// so SSH on :22 would be silently unreachable and `fly deploy` would report
// success. It bills $2/mo — one IP for every repository, since SSH has no SNI
// and the repo is named in the client's command (`git@host:<repo_id>.git`).
//
// Secrets, all in this environment's secrets.yaml:
//   WALGIT_SSH_HOST_KEY         an ed25519 PRIVATE key (`ssh-keygen -t ed25519`).
//                               Must outlive the machine — the container
//                               filesystem does not, and a regenerated host key
//                               makes every client cry man-in-the-middle.
//   WALGIT_SSH_AUTHORIZED_KEYS  newline-separated PUBLIC keys allowed to push.
//   WALGIT_HTTP_TOKENS          comma-separated bearer tokens for smart-HTTP
//                               (git sends them as the Basic-auth password).
//
// The log's own credentials are NOT walgit-specific and deliberately so.
// Cloudflare derives exactly one S3 credential per API token (access key id =
// the token's id, secret = sha256 of its value), and R2's permission group is
// account-scoped — there is no per-bucket API token to mint. A second token
// would therefore reach every bucket this one does while adding a credential to
// rotate, so walgit reads the account's existing pair under its own names.
// `git.zabaca.com` is the public name for both transports:
//
//   git clone git@git.zabaca.com:myrepo.git                  # SSH, port 22
//   git clone https://walgit:$TOKEN@git.zabaca.com/myrepo.git # smart-HTTP
//
// The A/AAAA records live in `zabaca-zone`, unproxied — Cloudflare's proxy
// carries only HTTP(S) ports, so a proxied record would break SSH while
// leaving smart-HTTP working, which is the confusing half of that failure.
// `zabaca-zone` is imported for ORDER, not for a value: Fly validates a
// certificate against DNS that already resolves to this app, so the record has
// to exist before `certs add` runs. The import is what makes one `zbc apply`
// do them in that order.
export default flyModule.instance({
  name: 'walgit',
  imports: [walgitWal, zabacaZone],
  config: {
    workdir: 'packages/walgit',
    appName: 'zbc-walgit',
    org: 'personal',
    ipv4: 'dedicated',
    certs: ['git.zabaca.com'],
    // Two machines, which is the first time this design has been asked to be
    // what it claims. The disk is a cache and `index.json` is compare-and-swap,
    // so there is no primary to elect and no routing table to keep: any machine
    // can take any push, and `sync.ts` runs its conditional GET on every access
    // precisely so a node never serves refs another node published over. The
    // one election is per-repository compaction, via the lease that compact.ts
    // says exists "to let replicas arrive later".
    //
    // It also stops a single machine's death from being downtime. NOTE: this
    // does not yet mean two failure domains — the module cannot pin regions, so
    // Fly may place both in sjc.
    highAvailability: true,
    flySecrets: [
      'WALGIT_SSH_HOST_KEY',
      'WALGIT_SSH_AUTHORIZED_KEYS',
      'WALGIT_HTTP_TOKENS',
      // Without these four the host serves reads off its local cache and
      // REFUSES every push — `requireStore()` throws in `pre-receive` rather
      // than acknowledge something it cannot persist.
      { name: 'WALGIT_S3_BUCKET', from: 'walgit-wal', output: 'bucketName' },
      {
        name: 'WALGIT_S3_ENDPOINT',
        value: 'https://99a19e584439be0568f33aad0477372b.r2.cloudflarestorage.com',
      },
      { name: 'WALGIT_S3_ACCESS_KEY_ID', secret: 'WAREHOUSE_R2_ACCESS_KEY_ID' },
      { name: 'WALGIT_S3_SECRET_ACCESS_KEY', secret: 'WAREHOUSE_R2_SECRET_ACCESS_KEY' },
    ],
  },
})
