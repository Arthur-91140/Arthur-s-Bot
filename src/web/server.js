'use strict'

const http = require('http')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const { Server } = require('socket.io')
const modes = require('../modes')
const registry = require('../graph/registry')
const { FUNCTION_NAMES } = require('../graph/expression')
const { PLUGIN_INFO } = require('../core/plugins')
const { supportedVersions, latest, oldest } = require('../core/versions')
const { pingServer } = require('../core/ping')
const { runAction, runBulk } = require('../core/actions')
const pkg = require('../../package.json')

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public')
// Polices IBM Plex servies localement : l'interface fonctionne sans Internet.
const FONTSOURCE_DIR = path.dirname(path.dirname(require.resolve('@fontsource/ibm-plex-mono/package.json')))

const BOT_FUNCTIONS = [
  'hasItem(nom, n)', 'countItem(nom)', 'blockAt(x, y, z)', 'blockBelow()', 'distanceTo(x, y, z)',
  'nearestPlayer(dist)', 'nearestEntity(filtre, dist)', 'entityCount(filtre, dist)', 'playerOnline(nom)',
  'players()', 'playerPos(nom)', 'findBlock(nom, dist)', 'inventoryFull()', 'isManaged(nom)', 'botNames()',
  'lastMessage()', 'online()'
]

function safeEqual (a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

/** Démarre l'interface web (fichiers statiques), l'API REST et le canal temps réel. */
function startWebServer ({ manager, logger, config }) {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server, { serveClient: true })
  const token = config.web.token
  const log = logger.child('web')

  app.disable('x-powered-by')
  app.use(express.json({ limit: '5mb' }))

  const checkToken = t => !token || (t && safeEqual(t, token))
  app.use('/api', (req, res, next) => {
    const header = req.get('authorization') || ''
    const t = header.startsWith('Bearer ') ? header.slice(7) : req.query.token
    if (checkToken(t)) return next()
    res.status(401).json({ error: 'Jeton d\'accès invalide' })
  })
  io.use((socket, next) => (checkToken(socket.handshake.auth && socket.handshake.auth.token) ? next() : next(new Error('unauthorized'))))

  app.use(express.static(PUBLIC_DIR))
  app.use('/vendor/fonts', express.static(FONTSOURCE_DIR, { maxAge: '7d' }))

  // Exécute un gestionnaire et renvoie son résultat en JSON (erreurs → 400).
  const route = fn => async (req, res) => {
    try {
      const result = await fn(req, res)
      if (!res.headersSent) res.json(result === undefined ? { ok: true } : result)
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 400).json({ error: err.message })
    }
  }
  const notFound = message => Object.assign(new Error(message), { status: 404 })

  // --- Informations ---------------------------------------------------------
  app.get('/api/info', route(() => ({
    name: 'Arthur\'s Bot',
    version: pkg.version,
    minecraft: { versions: supportedVersions(), latest, oldest },
    defaults: { server: config.server, swarm: config.swarm, bot: { ...config.bot, plugins: config.bot.plugins } },
    modes: modes.list(),
    nodes: registry.list(),
    categories: registry.CATEGORIES,
    plugins: PLUGIN_INFO,
    functions: { builtins: FUNCTION_NAMES, bot: BOT_FUNCTIONS }
  })))

  app.get('/api/ping', route(req => pingServer({
    host: req.query.host || config.server.host,
    port: Number(req.query.port || config.server.port)
  })))

  // --- Bots -------------------------------------------------------------------
  app.get('/api/bots', route(() => manager.states()))

  app.post('/api/bots', route(req => {
    const body = req.body || {}
    const count = Math.max(1, Math.min(500, Number(body.count) || 1))
    if (count > 1 || (body.namePattern && body.namePattern.includes('{i}'))) {
      return manager.createSwarm({ ...body, count, namePattern: body.namePattern || body.username })
    }
    const b = manager.createBot(body)
    return { created: [b.id], errors: [] }
  }))

  app.get('/api/bots/:id', route(req => {
    const b = manager.get(req.params.id)
    if (!b) throw notFound('Bot introuvable')
    return { ...b.getState(), chat: b.chatHistory.slice(-150) }
  }))

  app.delete('/api/bots/:id', route(req => {
    if (!manager.removeBot(req.params.id)) throw notFound('Bot introuvable')
  }))

  app.get('/api/bots/:id/chat', route(req => manager.require(req.params.id).chatHistory.slice(-Number(req.query.limit || 150))))
  app.get('/api/bots/:id/inventory', route(req => manager.require(req.params.id).getInventory()))
  app.get('/api/bots/:id/window', route(req => manager.require(req.params.id).getWindow()))

  app.post('/api/bots/:id/:action', route(req => {
    const b = manager.get(req.params.id)
    if (!b) throw notFound('Bot introuvable')
    return runAction(b, req.params.action, req.body || {})
  }))

  app.post('/api/bulk', route(req => {
    const { targets, action, ...payload } = req.body || {}
    if (action === 'remove') {
      const ids = manager.resolve(targets).map(b => b.id)
      for (const id of ids) manager.removeBot(id)
      return { count: ids.length }
    }
    return runBulk(manager, targets, action, payload)
  }))

  // --- Graphes ----------------------------------------------------------------
  app.get('/api/graphs', route(() => manager.graphs.list()))
  app.get('/api/graphs/:id', route(req => {
    const g = manager.graphs.get(req.params.id)
    if (!g) throw notFound('Graphe introuvable')
    return g
  }))
  const saveGraph = req => {
    const graph = { ...(req.body || {}) }
    if (req.params.id) graph.id = req.params.id
    const saved = manager.graphs.save(graph)
    io.emit('graphs')
    return { ...saved, validation: registry.validate(saved) }
  }
  app.post('/api/graphs', route(saveGraph))
  app.put('/api/graphs/:id', route(saveGraph))
  app.delete('/api/graphs/:id', route(req => {
    if (!manager.graphs.remove(req.params.id)) throw notFound('Graphe introuvable')
    io.emit('graphs')
  }))
  app.post('/api/validate', route(req => registry.validate(req.body)))

  app.post('/api/run', route(req => {
    const { graph, graphId, targets } = req.body || {}
    const runtimes = manager.runGraph(graph || graphId, targets)
    return runtimes.map(r => r.summary())
  }))
  app.get('/api/runtimes', route(() => manager.listRuntimes()))
  app.post('/api/runtimes/stop', route(req => ({ stopped: manager.stopRuntimes(req.body || {}) })))
  app.post('/api/runtimes/:id/stop', route(req => {
    if (!manager.stopRuntime(req.params.id)) throw notFound('Exécution introuvable')
  }))
  app.post('/api/trigger', route(req => {
    const { name, data, targets } = req.body || {}
    if (!name) throw new Error('Nom du signal requis')
    return { count: manager.trigger(name, data, targets) }
  }))
  app.get('/api/shared', route(() => manager.shared))
  app.delete('/api/shared', route(() => {
    for (const k of Object.keys(manager.shared)) delete manager.shared[k]
  }))

  // --- Rapports et logs -------------------------------------------------------
  app.get('/api/reports', route(() => manager.reports.list()))
  app.get('/api/reports/:id', route(req => {
    const r = manager.reports.get(req.params.id)
    if (!r) throw notFound('Rapport introuvable')
    return r.toJSON()
  }))
  app.delete('/api/reports', route(() => manager.reports.clear()))
  app.delete('/api/reports/:id', route(req => {
    manager.reports.remove(req.params.id)
  }))
  app.get('/api/logs', route(req => logger.getLines({
    source: req.query.source || undefined,
    level: req.query.level || undefined,
    limit: Math.min(3000, Number(req.query.limit || 500)),
    since: Number(req.query.since || 0)
  })))

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }))

  // --- Temps réel ---------------------------------------------------------------
  // Les évènements fréquents sont regroupés pour ne pas saturer le navigateur.
  const batches = { logs: [], chats: [], traces: [] }
  const push = (key, item, max = 500) => {
    const list = batches[key]
    list.push(item)
    if (list.length > max) list.shift()
  }
  const onLine = line => push('logs', line)
  const onChat = c => push('chats', c)
  const onTrace = t => push('traces', t, 300)
  const onReport = r => io.emit('report', r)
  const onRuntime = r => io.emit('runtime', r)
  const onBots = () => { dirty = true }
  let dirty = true
  logger.on('line', onLine)
  manager.on('chat', onChat)
  manager.on('trace', onTrace)
  manager.reports.on('update', onReport)
  manager.reports.on('cleared', () => io.emit('reportsCleared'))
  manager.on('runtime', onRuntime)
  manager.on('botAdded', onBots)
  manager.on('botRemoved', onBots)
  manager.on('botChanged', onBots)

  const fast = setInterval(() => {
    if (!io.engine.clientsCount) {
      batches.logs = []
      batches.chats = []
      batches.traces = []
      return
    }
    for (const key of Object.keys(batches)) {
      if (batches[key].length) {
        io.emit(key, batches[key])
        batches[key] = []
      }
    }
  }, 150)
  let lastFull = 0
  const slow = setInterval(() => {
    if (!io.engine.clientsCount) return
    const now = Date.now()
    if (dirty || now - lastFull >= 1000) {
      dirty = false
      lastFull = now
      io.emit('bots', manager.states())
    }
  }, 250)

  io.on('connection', socket => {
    socket.emit('bots', manager.states())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.web.port, config.web.host, () => {
      const address = server.address()
      const host = config.web.host === '0.0.0.0' ? 'localhost' : config.web.host
      const url = `http://${host}:${address.port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`
      log.info(`Interface web : ${url}`)
      if (config.web.host !== '127.0.0.1' && config.web.host !== 'localhost' && !token) {
        log.warn('L\'interface est accessible depuis le réseau sans jeton : définissez web.token dans la configuration.')
      }
      resolve({
        url,
        port: address.port,
        close () {
          clearInterval(fast)
          clearInterval(slow)
          logger.removeListener('line', onLine)
          manager.removeListener('chat', onChat)
          manager.removeListener('trace', onTrace)
          manager.removeListener('runtime', onRuntime)
          io.close()
          server.close()
        }
      })
    })
  })
}

module.exports = { startWebServer }
