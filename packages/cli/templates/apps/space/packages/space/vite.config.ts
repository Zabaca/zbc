import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Plugin, defineConfig } from 'vite'
import { pdfjsWasm } from '../forms/pdfjs-wasm'
import { readMailboxContent } from '../inbox/src/mailbox-content'
import { parseInstallFile } from '../../kit/install-file'
import { spaceWorkerSettings } from '../../kit/worker-settings'
import { createInstall } from '../workspace/src/install'
import { declarationFor } from './build-install'
import { RECOVER_SCRIPT } from './src/recover'

// The company this build serves is the declaration it bundles (src/workspace.ts), which SPACE_DECLARATION names (build-install.ts): a build that names none stops, and `vite dev` and `vite preview` with none
// serve the invented install.
//
// The inbox's mailbox content (each mailbox's assistant persona and spam questions) is the file beside the declaration (`workspace-content.json`), bundled the same way (packages/inbox/src/mailbox-content.ts). SPACE_CONTENT names
// another; a company whose declaration has none beside it has no personas and no spam questions (an empty file), so no mailbox of it gets an assistant or a spam check.
const contentFor = (declaration: string) => {
  const contentBeside = resolve(dirname(declaration), 'workspace-content.json')
  return process.env.SPACE_CONTENT
    ? resolve(process.env.SPACE_CONTENT)
    : existsSync(contentBeside)
      ? contentBeside
      : fileURLToPath(new URL('../inbox/src/no-content.json', import.meta.url))
}

// The install file (`workspace-install.json`, beside the declaration, always) names what this install is made of in its own account: the Worker, its stores, its Access applications and its secrets' names
// (kit/install-file.ts). The Worker's settings are not a hand-kept file: this build writes them for the install, from the pair (kit/worker-settings.ts), into
// wrangler.json here (gitignored), and the Cloudflare plugin below reads that as it read the hand-kept file and writes dist/space/wrangler.json, the file the deploy ships. It is named wrangler.json so that wrangler finds it
// as the user config for every command zbc's apply runs in this folder, not only the deploy: `d1 migrations apply` and `secret put` look for a config in the folder and fail without one (packages/space/test/wrangler-commands.test.ts).
// A file and not the plugin's inline
// `config`, because with no config file the plugin starts from wrangler's defaults for a Worker with none (Workers Logs on, an empty `define`, a build watch directory), which would deploy settings nobody wrote.
//
// So the build is where an install's three files are read against each other, for EVERY install and not only at the Worker's start: a declaration that is not whole, an install file that does not name what the
// declaration's features need, and a content file that disagrees with the declaration (a persona for an address no business has, questions for a mailbox that is not declared, a spam check on with no questions) each
// stop the build with every problem named, and nothing is deployed.
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const settingsPath = fileURLToPath(new URL('./wrangler.json', import.meta.url))
function writeSettingsFor(declaration: string, content: string) {
  const installFileBeside = resolve(dirname(declaration), 'workspace-install.json')
  if (!existsSync(installFileBeside)) throw new Error(`${installFileBeside} is missing: an install's declaration has its install file beside it (kit/install-file.ts says what it holds)`)
  const install = createInstall(readJson(declaration))
  const installFile = parseInstallFile(readJson(installFileBeside), install)
  readMailboxContent(readJson(content), install)

  // Written only when it differs: the plugin watches its settings file in `vite dev`, and a rewrite of the same text would restart the dev server on every load.
  const settingsText = `${JSON.stringify(spaceWorkerSettings(install, installFile), null, 2)}\n`
  if (!existsSync(settingsPath) || readFileSync(settingsPath, 'utf8') !== settingsText) writeFileSync(settingsPath, settingsText)
}

// The recovery script rides in the page ahead of its files (src/recover.ts), as exactly the text the Worker's content security policy hashes.
const recovery = (): Plugin => ({
  name: 'space-recovery',
  transformIndexHtml: { order: 'post', handler: () => [{ tag: 'script', children: RECOVER_SCRIPT, injectTo: 'head-prepend' }] },
})

/** The service worker's source, and the one address it is served at (its scope is the folder it is in: the root). */
const SW_SOURCE = fileURLToPath(new URL('./src/client/sw.ts', import.meta.url))
const SW_FILE = 'sw.js'

/**
 * The service worker of the installed app (src/client/sw.ts), built as an entry of its own at the fixed address /sw.js. In a build it is emitted beside the page as ONE
 * file that imports nothing (a module the page's bundle also uses would be split into a chunk the two share, and a worker that imports a chunk is a worker Access can
 * refuse: test/sw-build.test.ts reads dist/ for it). In `vite dev` /sw.js is answered here, before the Worker, as the transformed source module, registered as a module
 * worker (notify.ts); dev has no Access in front of it, so a module worker's missing cookies do not matter there.
 */
function serviceWorker(): Plugin {
  let building = false
  return {
    name: 'space-service-worker',
    configResolved(config) {
      building = config.command === 'build'
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== `/${SW_FILE}`) return next()
        try {
          const result = await server.environments.client.transformRequest(SW_SOURCE)
          if (!result) throw new Error(`Vite could not transform ${SW_SOURCE}`)
          res.setHeader('Content-Type', 'text/javascript')
          res.setHeader('Cache-Control', 'no-store')
          res.end(result.code)
        } catch (error) {
          next(error)
        }
      })
    },
    buildStart() {
      // `vite dev` calls this too, where nothing is emitted: /sw.js is answered above.
      if (!building || this.environment.name !== 'client') return
      this.emitFile({ type: 'chunk', id: SW_SOURCE, fileName: SW_FILE })
    },
  }
}

// The Workers AI binding (the inbox's spam check) is a remote one, which `vite dev` and `vite preview` can reach only with a Cloudflare login or API token; a worktree has neither, so
// `SPACE_DEV_LOCAL=1` leaves remote bindings off (the end-to-end tests set it), and mail files not judged, which is the spam check's no-binding path.

export default defineConfig(({ command }) => {
  const declaration = declarationFor(command)
  const content = contentFor(declaration)
  writeSettingsFor(declaration, content)
  return {
    // `@forms/declaration`, `@knowledge/declaration`, `@meet/declaration`, `@inbox/declaration`, `@calendar/declaration` and `@clients/declaration` are forms', the knowledge app's, meet's, the inbox's, the calendar's and the Clients part's own names for the same file: all six run in this Worker (src/parts.ts), so a build for another company
    // (SPACE_DECLARATION) gives them that company's people and businesses, the knowledge store's object, meet's Workspace object, the inbox's owner, the calendar's owners and time zone and the Clients part's owners and source included.
    resolve: { alias: { '@space/declaration': declaration, '@forms/declaration': declaration, '@knowledge/declaration': declaration, '@meet/declaration': declaration, '@inbox/declaration': declaration, '@inbox/content': content, '@calendar/declaration': declaration, '@clients/declaration': declaration } },
    plugins: [serviceWorker(), react(), tailwindcss(), pdfjsWasm(), recovery(), cloudflare({ configPath: settingsPath, remoteBindings: process.env.SPACE_DEV_LOCAL !== '1' })],
  }
})
