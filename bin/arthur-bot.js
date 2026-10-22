#!/usr/bin/env node
'use strict'

const { main } = require('../src/cli/main')

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`Erreur fatale : ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
