'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig } = require('../src/config')
const { Logger } = require('../src/core/Logger')
const { BotManager } = require('../src/core/BotManager')

/** Gestionnaire isolé (dossiers temporaires, sans console) pour les tests. */
function createTestManager () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-bot-test-'))
  const config = loadConfig(path.join(dir, 'absent.json'))
  config.paths.graphs = path.join(dir, 'graphs')
  config.paths.reports = null
  config.paths.data = null
  config.workers = { enabled: false }
  config.paths.campaigns = path.join(dir, 'campaigns')
  const logger = new Logger({ console: 'none', file: null })
  const manager = new BotManager({ config, logger })
  return { manager, logger, dir }
}

/** Bot non connecté dont les messages envoyés sont enregistrés dans `said`. */
function createOfflineBot (manager, username = 'Testeur') {
  const instance = manager.createBot({ username, connect: false })
  instance.said = []
  instance.say = message => instance.said.push(String(message))
  return instance
}

function waitFor (predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeout) {
        clearInterval(timer)
        reject(new Error('Condition non atteinte à temps'))
      }
    }, 10)
  })
}

/** Construit un graphe à partir d'une liste compacte de nœuds et de liens. */
function graph (nodes, links, extra = {}) {
  return {
    id: 'test',
    name: 'Test',
    nodes: nodes.map(([id, type, params = {}]) => ({ id, type, x: 0, y: 0, params })),
    links: links.map(([from, fromPort, to]) => ({ from, fromPort, to, toPort: 'in' })),
    ...extra
  }
}

module.exports = { createTestManager, createOfflineBot, waitFor, graph }
