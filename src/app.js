'use strict'

const { loadConfig } = require('./config')
const { Logger } = require('./core/Logger')
const { BotManager } = require('./core/BotManager')

/**
 * Assemble l'application : configuration, journal, gestionnaire de bots et,
 * optionnellement, interface web et console interactive.
 */
async function createApp ({ configPath, overrides = {}, web = true, repl = true, restore = true } = {}) {
  const config = loadConfig(configPath)
  for (const [section, values] of Object.entries(overrides)) {
    config[section] = { ...config[section], ...values }
  }
  const logger = new Logger(config.logs)
  const manager = new BotManager({ config, logger })
  const app = { config, logger, manager, web: null, repl: null }

  if (web && config.web.enabled !== false) {
    const { startWebServer } = require('./web/server')
    try {
      app.web = await startWebServer({ manager, logger, config })
    } catch (err) {
      logger.log('error', 'web', `Impossible de démarrer l'interface web sur le port ${config.web.port} : ${err.message}`)
    }
  }

  // Bots de la session précédente (data/bots.json), puis ceux de la configuration.
  if (restore) manager.restoreBots()
  for (const entry of config.autostart || []) {
    if (entry.username && manager.get(entry.username)) continue
    try {
      if (entry.count > 1) manager.createSwarm(entry)
      else manager.createBot(entry)
    } catch (err) {
      logger.log('error', 'autostart', err.message)
    }
  }

  if (repl && process.stdin.isTTY) {
    const { startRepl } = require('./cli/repl')
    app.repl = startRepl(app, () => shutdown())
  }

  let stopping = false
  function shutdown (code = 0) {
    if (stopping) return
    stopping = true
    logger.log('info', 'system', 'Arrêt en cours…')
    manager.shutdown()
    if (app.web) app.web.close()
    setTimeout(() => {
      logger.close()
      process.exit(code)
    }, 800)
  }
  // Un outil de test doit survivre aux erreurs imprévues d'un bot ou d'un plugin.
  process.on('uncaughtException', err => logger.log('error', 'system', `Exception non gérée : ${err && err.stack ? err.stack : err}`))
  process.on('unhandledRejection', err => logger.log('error', 'system', `Promesse rejetée non gérée : ${err && err.stack ? err.stack : err}`))
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  app.shutdown = shutdown
  return app
}

module.exports = { createApp }
