/**
 * Where Northfield Works' three files are on disk, for what reads files rather than imports them: a dev build's alias, a test that copies the pair into a scratch folder, a script run for the invented install.
 * Node only; the parsed files are `./index`.
 */
import { fileURLToPath } from 'node:url'

export const NORTHFIELD_DIR = fileURLToPath(new URL('./', import.meta.url))
export const NORTHFIELD_DECLARATION_FILE = fileURLToPath(new URL('./workspace.json', import.meta.url))
export const NORTHFIELD_INSTALL_FILE_PATH = fileURLToPath(new URL('./workspace-install.json', import.meta.url))
export const NORTHFIELD_CONTENT_FILE = fileURLToPath(new URL('./workspace-content.json', import.meta.url))
