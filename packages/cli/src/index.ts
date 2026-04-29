#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { addCommand } from './commands/add'
import { applyCommand } from './commands/apply'
import { destroyCommand } from './commands/destroy'
import { initCommand } from './commands/init'

const main = defineCommand({
  meta: {
    name: 'zbc',
    version: '0.1.0',
    description: 'Zabaca stack CLI',
  },
  subCommands: {
    apply: applyCommand,
    destroy: destroyCommand,
    init: initCommand,
    add: addCommand,
  },
})

runMain(main)
