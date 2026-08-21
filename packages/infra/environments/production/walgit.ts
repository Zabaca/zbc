import { flyModule } from '../../modules/fly'

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
export default flyModule.instance({
  name: 'walgit',
  config: {
    workdir: 'packages/walgit',
    appName: 'zbc-walgit',
    org: 'personal',
    ipv4: 'dedicated',
    flySecrets: ['WALGIT_SSH_HOST_KEY', 'WALGIT_SSH_AUTHORIZED_KEYS', 'WALGIT_HTTP_TOKENS'],
  },
})
