#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import pkg from '../package.json' with { type: 'json' }
import { addCommand } from './commands/add'
import { applyCommand } from './commands/apply'
import { destroyCommand } from './commands/destroy'
import { initCommand } from './commands/init'
import { listCommand } from './commands/list'
import { secretCommand } from './commands/secret'
import { updateCommand } from './commands/update'

const main = defineCommand({
  meta: {
    name: 'zbc',
    version: pkg.version,
    description: 'Zabaca stack CLI',
  },
  subCommands: {
    apply: applyCommand,
    destroy: destroyCommand,
    init: initCommand,
    add: addCommand,
    list: listCommand,
    secret: secretCommand,
    update: updateCommand,
  },
})

runMain(main)
