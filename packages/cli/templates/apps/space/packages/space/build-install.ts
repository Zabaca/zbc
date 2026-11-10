// Which install a build of the space is for: the declaration it bundles, with the install file and the content file beside it.
//
// A build that will be deployed is for one company, and it says which: SPACE_DECLARATION names the declaration's file (absolute, or relative to this folder). Nothing falls back to a real company's files, so a
// build with nothing named stops here rather than bundle somebody's people into another company's Worker. The invented company (Northfield Works, packages/workspace/northfield) is what `vite dev` and
// `vite preview` serve when nothing is named, and what a test build names explicitly by its file.
import { resolve } from 'node:path'
import { NORTHFIELD_DECLARATION_FILE } from '../workspace/northfield/paths'

export { NORTHFIELD_DECLARATION_FILE }

export class NoDeclarationNamed extends Error {
  constructor() {
    super(
      'No install named for this build: set SPACE_DECLARATION to the path of the install\'s declaration (workspace.json, with its workspace-install.json and workspace-content.json beside it). ' +
        `A dev or test build of the invented install names its file: SPACE_DECLARATION=${NORTHFIELD_DECLARATION_FILE}`,
    )
    this.name = 'NoDeclarationNamed'
  }
}

/** The declaration's file for a build (`command` is Vite's): the one SPACE_DECLARATION names, or the invented install's when serving; a build with none named throws. */
export function declarationFor(command: 'build' | 'serve'): string {
  const named = process.env.SPACE_DECLARATION?.trim()
  if (named) return resolve(named)
  if (command === 'serve') return NORTHFIELD_DECLARATION_FILE
  throw new NoDeclarationNamed()
}
