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
const { snapshot } = require('../core/view')
const pkg = require('../../package.json')

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public')
// Polices IBM Plex servies localement : l'interface fonctionne sans Internet.
const FONTSOURCE_DIR = path.dirname(path.dirname(require.resolve('@fontsource/ibm-plex-mono/package.json')))
// three.js (vue 3D), servi localement lui aussi.
const THREE_DIR = path.dirname(require.resolve('three'))

const BOT_FUNCTIONS = [
  'hasItem(nom, n)', 'countItem(nom)', 'blockAt(x, y, z)', 'blockBelow()', 'distanceTo(x, y, z)',
  'nearestPlayer(dist)', 'nearestEntity(filtre, dist)', 'entityCount(filtre, dist)', 'playerOnline(nom)',
  'players()', 'playerPos(nom)', 'findBlock(nom, dist)', 'inventoryFull()', 'isManaged(nom)', 'botNames()',
  'lastMessage()', 'online()', 'serverPlayers()', 'seenByServer(nom)',
  'dialog()', 'serverLinks()', 'reportDetails()', 'codeOfConduct()'
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
  app.use('/vendor/three', express.static(THREE_DIR, { maxAge: '7d' }))

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

  app.get('/api/bots/:id', route(async req => {
    const b = manager.get(req.params.id)
    if (!b) throw notFound('Bot introuvable')
    return { ...b.getState(), chat: await b.getChat(150) }
  }))

  app.delete('/api/bots/:id', route(req => {
    if (!manager.removeBot(req.params.id)) throw notFound('Bot introuvable')
  }))

  app.get('/api/bots/:id/chat', route(req => manager.require(req.params.id).getChat(Number(req.query.limit || 150))))
  app.get('/api/bots/:id/inventory', route(req => manager.require(req.params.id).getInventory()))
  app.get('/api/bots/:id/protocol', route(req => {
    const b = manager.require(req.params.id)
    return b.remote ? b.call('protocol') : b.protocolInfo()
  }))
  app.get('/api/bots/:id/window', route(req => manager.require(req.params.id).getWindow()))
  // --- Outils du serveur : RCON et protocole de gestion (1.21.9+) -------------------
  app.get('/api/server-tools', route(() => manager.server.state()))
  app.put('/api/server-tools', route(req => manager.server.update(req.body || {})))
  app.post('/api/rcon', route(async req => {
    const command = String((req.body && req.body.command) || '').trim()
    if (!command) throw new Error('Commande vide')
    return { command, response: await manager.server.runRcon(command) }
  }))
  app.post('/api/management/call', route(async req => {
    const { method, params } = req.body || {}
    if (!method) throw new Error('Méthode manquante')
    return { result: await manager.server.manage(String(method), params === undefined ? [] : params) }
  }))

  // --- Campagnes ----------------------------------------------------------------
  const campaigns = manager.campaigns
  app.get('/api/campaigns', route(() => campaigns.store.list()))
  app.get('/api/campaigns/active', route(() => campaigns.state()))
  app.get('/api/campaigns/:id', route(req => {
    const c = campaigns.store.get(req.params.id)
    if (!c) throw notFound('Campagne introuvable')
    return c
  }))
  const saveCampaign = req => {
    const body = { ...(req.body || {}) }
    if (req.params.id) body.id = req.params.id
    const saved = campaigns.store.save(body)
    io.emit('campaigns')
    return saved
  }
  app.post('/api/campaigns', route(saveCampaign))
  app.put('/api/campaigns/:id', route(saveCampaign))
  app.delete('/api/campaigns/:id', route(req => {
    if (!campaigns.store.remove(req.params.id)) throw notFound('Campagne introuvable')
    io.emit('campaigns')
  }))
  app.post('/api/campaigns/:id/run', route(req => campaigns.start(req.params.id, { server: (req.body || {}).server }).public()))
  app.post('/api/campaigns/stop', route(() => ({ stopped: campaigns.stop() })))

  // --- Traces des déplacements ----------------------------------------------------
  app.get('/api/trails', route(req => ({
    keepMinutes: manager.trails.keepMinutes,
    trails: manager.trails.snapshot({
      minutes: Number(req.query.minutes) || null,
      ids: req.query.bots ? String(req.query.bots).split(',') : null
    }),
    markers: manager.trails.markersSince(Number(req.query.minutes) || null)
  })))
  app.delete('/api/trails', route(req => {
    manager.clearTrails(req.query.bots ? String(req.query.bots).split(',') : null)
  }))

  app.get('/api/bots/:id/view', route(req => {
    const b = manager.require(req.params.id)
    const opts = { radius: req.query.radius, height: req.query.height, blocks: req.query.blocks !== '0' }
    return b.remote ? b.call('view', [opts]) : snapshot(b, opts)
  }))

  // --- Santé du programme et processus ouvriers --------------------------------------
  app.get('/api/health', route(() => ({
    health: manager.health,
    workers: manager.pool ? { enabled: manager.pool.enabled, botsPerProcess: manager.pool.botsPerProcess, maxProcesses: manager.pool.maxProcesses, processes: manager.pool.info() } : null
  })))

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
  app.post('/api/runtimes/:id/stop', route(async req => {
    if (!(await manager.stopRuntime(req.params.id))) throw notFound('Exécution introuvable')
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
  const batches = { logs: [], chats: [], traces: [], serverEvents: [], markers: [] }
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
  const onTrails = changes => { if (io.engine.clientsCount) io.emit('trails', changes) }
  const onTrailsCleared = ids => io.emit('trailsCleared', ids)
  let serverStateTimer = null
  const onServerState = () => {
    // regroupé : le protocole de gestion peut envoyer beaucoup de notifications d'un coup
    if (serverStateTimer) return
    serverStateTimer = setTimeout(() => {
      serverStateTimer = null
      io.emit('serverTools', manager.server.state())
    }, 300)
  }
  const onServerNotification = n => { if (n.t) push('serverEvents', n, 200) }
  const onHealth = h => { if (io.engine.clientsCount) io.emit('health', h) }
  const onCampaign = c => io.emit('campaign', c)
  const onMarker = m => push('markers', m, 200)
  const onBots = () => { dirty = true }
  let dirty = true
  logger.on('line', onLine)
  manager.on('chat', onChat)
  manager.on('trace', onTrace)
  manager.reports.on('update', onReport)
  manager.reports.on('cleared', () => io.emit('reportsCleared'))
  manager.on('runtime', onRuntime)
  manager.on('trails', onTrails)
  manager.on('trailsCleared', onTrailsCleared)
  manager.server.on('state', onServerState)
  manager.server.on('notification', onServerNotification)
  manager.on('health', onHealth)
  manager.on('marker', onMarker)
  manager.campaigns.on('update', onCampaign)
  manager.on('botAdded', onBots)
  manager.on('botRemoved', onBots)
  manager.on('botChanged', onBots)

  const fast = setInterval(() => {
    if (!io.engine.clientsCount) {
      batches.logs = []
      batches.chats = []
      batches.traces = []
      batches.serverEvents = []
      batches.markers = []
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
    socket.emit('serverTools', manager.server.state())
    if (manager.health) socket.emit('health', manager.health)
    socket.emit('campaign', manager.campaigns.state())
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
          manager.removeListener('trails', onTrails)
          manager.removeListener('trailsCleared', onTrailsCleared)
          manager.server.removeListener('state', onServerState)
          manager.server.removeListener('notification', onServerNotification)
          manager.removeListener('health', onHealth)
          manager.removeListener('marker', onMarker)
          manager.campaigns.removeListener('update', onCampaign)
          clearTimeout(serverStateTimer)
          io.close()
          server.close()
        }
      })
    })
  })
}

module.exports = { startWebServer }
