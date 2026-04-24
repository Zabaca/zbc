#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { applyCommand } from './commands/apply'
import { destroyCommand } from './commands/destroy'
import { initCommand } from './commands/init'

const main = defineCommand({
  meta: {
    name: 'zbc',
    version: '0.0.1',
    description: 'Zabaca stack CLI',
  },
  subCommands: {
    apply: applyCommand,
    destroy: destroyCommand,
    init: initCommand,
  },
})

runMain(main)
