/**
 * Northfield Works, the invented company every package of the space bundles when nothing names another install: in tests, in dev builds and in the stand-in data. Its three files mirror a full install
 * thing for thing (every switch on, a Gmail account, a mailbox on its own mail server, three shared business mailboxes with personas and spam questions, a source of Clients, the phone) under names nobody
 * owns: reserved example domains, invented people and obviously fake ids. A production build never falls back to it: it names its own declaration.
 *
 * The parsed files are here; their paths on disk, for a build or a script that reads files, are `./paths`.
 */
import content from './workspace-content.json'
import installFile from './workspace-install.json'
import declaration from './workspace.json'

/** The company's declaration, as parsed JSON (read it with `createInstall`). */
export const NORTHFIELD_DECLARATION = declaration
/** Its install file: the names of its Worker, stores, Access applications and secrets in its own (invented) account. */
export const NORTHFIELD_INSTALL_FILE = installFile
/** Its mailbox content: each business mailbox's assistant persona and spam questions. */
export const NORTHFIELD_CONTENT = content
