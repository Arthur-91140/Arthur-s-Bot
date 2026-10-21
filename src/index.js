'use strict'

/**
 * Point d'entrée pour une utilisation programmatique :
 *   const { createApp } = require('arthur-s-bot')
 *   const app = await createApp({ web: false, repl: false })
 *   app.manager.createBot({ username: 'Testeur', mode: 'wander' })
 */
module.exports = {
  ...require('./app'),
  ...require('./config'),
  ...require('./core/BotManager'),
  ...require('./core/BotInstance'),
  ...require('./core/Logger'),
  ...require('./core/ping'),
  ...require('./graph/GraphRuntime'),
  modes: require('./modes'),
  nodes: require('./graph/registry'),
  expression: require('./graph/expression')
}
