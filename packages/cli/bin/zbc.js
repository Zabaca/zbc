#!/usr/bin/env bun
import('../src/index.ts').catch((e) => {
  console.error(e)
  process.exit(1)
})
