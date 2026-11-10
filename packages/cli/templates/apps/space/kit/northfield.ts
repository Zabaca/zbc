// The invented install's pair (Northfield Works, packages/workspace/northfield) read through the kit: the install, its install file and the Worker's settings a build of it writes. What the packages' tests compare the
// bundled install's settings against; it imports no zbc module, so a test can ask what the space would be deployed with without compiling the deploy's modules.
import { NORTHFIELD_DECLARATION, NORTHFIELD_INSTALL_FILE } from '../packages/workspace/northfield'
import { createInstall } from '../packages/workspace/src/install'
import { parseInstallFile } from './install-file'
import { spaceWorkerSettings } from './worker-settings'

export const northfieldInstall = createInstall(NORTHFIELD_DECLARATION)
export const northfieldInstallFile = parseInstallFile(NORTHFIELD_INSTALL_FILE, northfieldInstall)
export const northfieldSettings = spaceWorkerSettings(northfieldInstall, northfieldInstallFile)
