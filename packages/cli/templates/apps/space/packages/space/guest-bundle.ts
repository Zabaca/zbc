// The two guest bundles' build, shared (the space's ADR 0018): meet's page (calls at /r/<name>, channel guests at /w/) and forms'
// signer page (/s/<token>), each built from its own package's source and index.html into a folder of the space's assets that the Worker serves with no sign-in, and that is the only place the
// guest pages' files come from.
//
// WHY A BUILD OF THEIR OWN AND NOT ENTRIES OF THE SPACE'S. The team page's files are at /assets/ behind the sign-in, and a guest cannot load them. Two entries of one build would share chunks (react, pdf.js)
// with the team's, and a shared chunk lives in one folder. So each guest bundle is a build of its own with a `base` that is its folder (`/r/_/`, `/s/_/`), emitted into dist/client/r/_/ and dist/client/s/_/ after the
// space's own build has emptied dist/client (package.json `build` runs them in that order). The Worker's content policy allows a guest page to load scripts from its folder and nowhere else of the host
// (src/guests.ts), which is why nothing a guest page needs may be outside it.
//
// Each page is marked with `<meta name="guest-bundle">`, which the Worker requires before serving it: the asset router's answer for a missing file is the TEAM page, and a guest must never be served that.
//
// `vite dev` of the space does not serve them (the guest pages run from their own packages' dev servers, packages/meet and packages/forms); the end-to-end suite builds only the space's own bundle.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite'
import { GUEST_BUNDLE_DIR } from '../workspace/src/guests'
import { declarationFor } from './build-install'

export const SPACE_ROOT = fileURLToPath(new URL('.', import.meta.url))

const mark = (bundle: string): Plugin => ({
  name: 'guest-bundle-mark',
  transformIndexHtml: { order: 'post', handler: () => [{ tag: 'meta', attrs: { name: 'guest-bundle', content: bundle }, injectTo: 'head-prepend' }] },
})

/** The company this build serves is the declaration it bundles, named as vite.config.ts's is (build-install.ts). */
export function guestBundle(opts: { bundle: 'meet' | 'forms'; root: string; prefix: '/r' | '/s'; plugins: PluginOption[]; publicDir: boolean }): (env: ConfigEnv) => UserConfig {
  return ({ command }) => guestBundleFor(declarationFor(command), opts)
}

function guestBundleFor(declaration: string, opts: { bundle: 'meet' | 'forms'; root: string; prefix: '/r' | '/s'; plugins: PluginOption[]; publicDir: boolean }): UserConfig {
  const folder = `${opts.prefix}/${GUEST_BUNDLE_DIR}/`
  return {
    root: resolve(SPACE_ROOT, opts.root),
    base: folder,
    // The package's own public folder rides along where it holds something the page needs (meet's segmentation model); forms' holds only its old `_headers`, which the Worker's policy replaces.
    publicDir: opts.publicDir ? 'public' : false,
    resolve: { alias: { '@meet/declaration': declaration, '@forms/declaration': declaration } },
    plugins: [...opts.plugins, mark(opts.bundle)],
    build: { outDir: resolve(SPACE_ROOT, 'dist/client', `.${folder}`), emptyOutDir: true, sourcemap: false },
  }
}
