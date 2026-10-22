'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { BotInstance } = require('./BotInstance')
const { ReportStore } = require('./ReportStore')
const { TrailStore } = require('./TrailStore')
const { ServerTools } = require('./ServerTools')
const { HealthProbe, summarize } = require('./health')
const { CampaignRunner } = require('./campaigns')
const { GraphStore } = require('../graph/GraphStore')
const { GraphRuntime } = require('../graph/GraphRuntime')
const modes = require('../modes')
const { fillPlaceholders } = require('./utils')

const OFFLINE_NAME = /^[A-Za-z0-9_]{1,16}$/
const ACTIVE = new Set(['starting', 'running', 'idle'])

/**
 * Répartit `count` places entre des groupes pondérés (plus grands restes), puis
 * entrelace les groupes pour que l'ordre de connexion mélange les comportements.
 */
function mixOrder (count, groups) {
  const total = groups.reduce((n, g) => n + Math.max(0, Number(g.weight) || 0), 0)
  if (!total) return []
  const exact = groups.map(g => (Math.max(0, Number(g.weight) || 0) / total) * count)
  const counts = exact.map(Math.floor)
  const order = exact.map((v, i) => [v - counts[i], i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; counts.reduce((a, b) => a + b, 0) < count; k++) counts[order[k % order.length][1]]++
  const assigned = counts.map(() => 0)
  const out = []
  for (let i = 0; i < count; i++) {
    let best = -1
    let bestDeficit = -Infinity
    counts.forEach((c, g) => {
      if (assigned[g] >= c) return
      const deficit = (c * (i + 1)) / count - assigned[g]
      if (deficit > bestDeficit) {
        bestDeficit = deficit
        best = g
      }
    })
    assigned[best]++
    out.push(best)
  }
  return out
}

/**
 * Gestionnaire central : crée les bots (seuls ou en essaim), lance les graphes,
 * centralise les rapports, les variables partagées et les évènements pour l'UI.
 *
 * Au-delà de `workers.botsPerProcess` bots, les suivants sont hébergés par des
 * processus ouvriers (voir workers/WorkerPool) ; ils apparaissent ici comme des
 * RemoteBot qui exposent la même interface.
 */
class BotManager extends EventEmitter {
  constructor ({ config, logger, worker = false, serverTools = null }) {
    super()
    this.setMaxListeners(100)
    this.config = config
    this.logger = logger
    this.log = logger.child('manager')
    this.isWorker = worker
    this.bots = new Map()
    this.runtimes = new Map()
    this.shared = {}
    this.externalNames = new Set() // bots des autres processus (vu depuis un ouvrier)
    this.reports = new ReportStore({ dir: config.paths.reports })
    this.graphs = new GraphStore(config.paths.graphs)
    const dataFile = name => (config.paths.data ? path.join(config.paths.data, name) : null)

    // RCON et protocole de gestion du serveur testé (dans un ouvrier : relais vers le principal)
    this.server = serverTools || new ServerTools({ config, logger, file: dataFile('server-tools.json') })

    // Traces des déplacements et repères (morts, blocages, expulsions) pour la carte.
    const trails = config.trails || {}
    this.trails = new TrailStore({
      keepMinutes: trails.keepMinutes,
      file: !worker && trails.persist !== false ? dataFile('trails.json') : null
    })
    this.timers = []
    this._trailPrunedAt = 0
    this.pool = null
    this.health = null
    this.botsFile = null
    this.campaigns = null

    if (!worker) {
      this.timers.push(setInterval(() => this.sampleTrails(), 1000))
      this.timers.push(setInterval(() => this.saveTrails(), 30000))

      // Processus ouvriers pour les gros essaims.
      const workersConfig = config.workers || {}
      if (workersConfig.enabled !== false) {
        const { WorkerPool } = require('./workers/WorkerPool')
        this.pool = new WorkerPool(this, workersConfig)
        this.server.on('state', s => this.pool.broadcastServer('state', s))
        this.server.on('notification', n => this.pool.broadcastServer('notification', n))
        let namesTimer = null
        const shareNames = () => {
          if (namesTimer) return
          namesTimer = setTimeout(() => {
            namesTimer = null
            for (const w of this.pool.live()) w.send({ type: 'names', names: [...this.bots.keys()] })
          }, 500)
        }
        this.on('botAdded', shareNames)
        this.on('botRemoved', shareNames)
      }

      // Campagnes de test relançables (campaigns/*.json).
      this.campaigns = new CampaignRunner(this, config.paths.campaigns || null)

      // Santé du programme (processus principal + ouvriers).
      this.probe = new HealthProbe()
      this.timers.push(setInterval(() => {
        const main = { ...this.probe.sample({ bots: this.localCount() }), process: 'P0' }
        this.health = summarize([main, ...(this.pool ? this.pool.health() : [])])
        this.emit('health', this.health)
      }, 2000))

      // Bots conservés d'un redémarrage à l'autre.
      if ((config.session || {}).restoreBots !== false) this.botsFile = dataFile('bots.json')
      if (this.botsFile) {
        const scheduleSave = () => {
          if (this._botsSaveTimer || this._closed) return
          this._botsSaveTimer = setTimeout(() => {
            this._botsSaveTimer = null
            this.saveBots()
          }, 3000)
          this._botsSaveTimer.unref()
        }
        this.on('botAdded', scheduleSave)
        this.on('botRemoved', scheduleSave)
        this.on('botChanged', scheduleSave)
      }
    }
    for (const t of this.timers) t.unref()
  }

  /** Options complètes d'un bot : valeurs par défaut de la config + options fournies. */
  normalizeOptions (opts = {}) {
    const server = this.config.server
    const defaults = this.config.bot
    const plugins = {
      ...defaults.plugins,
      ...(opts.plugins || {}),
      authme: { ...(defaults.plugins.authme || {}), ...((opts.plugins || {}).authme || {}) }
    }
    return {
      username: String(opts.username || '').trim(),
      host: opts.host || server.host,
      port: Number(opts.port || server.port),
      version: opts.version || server.version || 'auto',
      auth: opts.auth || defaults.auth,
      password: opts.password || undefined,
      autoReconnect: opts.autoReconnect ?? defaults.autoReconnect,
      reconnectDelay: Number(opts.reconnectDelay ?? defaults.reconnectDelay),
      maxReconnectAttempts: Number(opts.maxReconnectAttempts ?? defaults.maxReconnectAttempts),
      checkTimeoutInterval: Number(opts.checkTimeoutInterval ?? defaults.checkTimeoutInterval),
      viewDistance: opts.viewDistance || defaults.viewDistance,
      profilesFolder: this.config.paths.profiles,
      mode: opts.mode || 'idle',
      modeOptions: opts.modeOptions || {},
      plugins,
      temporary: !!opts.temporary
    }
  }

  /**
   * Crée un bot. `opts.process` : 'auto' (défaut : dans un ouvrier au-delà du seuil),
   * 'main' (toujours dans ce processus) ou 'worker' (toujours dans un ouvrier).
   */
  createBot (opts = {}) {
    const options = this.normalizeOptions(opts)
    if (!options.username) throw new Error('Pseudo requis')
    if (options.auth === 'offline' && !OFFLINE_NAME.test(options.username)) {
      throw new Error(`Pseudo invalide "${options.username}" : 1 à 16 caractères parmi A-Z, a-z, 0-9 et _`)
    }
    if (this.bots.has(options.username)) throw new Error(`Un bot nommé ${options.username} existe déjà`)
    if (!modes.get(options.mode)) throw new Error(`Mode inconnu : ${options.mode}`)
    const forced = opts.process === 'main' ? false : opts.process === 'worker' ? true : null
    let instance
    if (this.pool && this.pool.shouldPlace(forced)) {
      instance = this.pool.createBot(options, { connect: opts.connect !== false, connectDelay: opts.connectDelay || 0 })
      this.bots.set(instance.id, instance)
      this.log.info(`Bot créé : ${instance.id} → ${options.host}:${options.port} (processus ${instance.worker.label})`)
      this.emit('botAdded', instance.id)
    } else {
      instance = new BotInstance(this, options)
      instance.mode.options = modes.normalizeOptions(modes.get(options.mode), options.modeOptions)
      this.bots.set(instance.id, instance)
      this.log.info(`Bot créé : ${instance.id} → ${options.host}:${options.port}`)
      this.emit('botAdded', instance.id)
      if (opts.connect !== false) {
        if (opts.connectDelay > 0) {
          instance._joinTimer = setTimeout(() => {
            instance._joinTimer = null
            if (this.bots.get(instance.id) === instance) instance.connect()
          }, opts.connectDelay)
        } else {
          instance.connect()
        }
      }
    }
    if (opts.graph) {
      try {
        this.runGraph(opts.graph, [instance.id])
      } catch (err) {
        this.logger.log('error', instance.id, `Graphe "${opts.graph}" : ${err.message}`)
      }
    }
    return instance
  }

  /**
   * Crée plusieurs bots avec un motif de nom ("Bot_{i}") et un délai entre chaque
   * connexion pour ne pas déclencher l'anti-flood du serveur.
   *
   * `mix` : population mixte, liste de groupes { weight, mode, modeOptions, graph }
   * répartis proportionnellement à leur poids (ex. 60 % promeneurs, 40 % mineurs).
   */
  createSwarm ({ count = 1, namePattern, startIndex = 1, joinDelay, joinOffset = 0, mix, ...opts } = {}) {
    const pattern = namePattern || this.config.swarm.namePattern
    const delay = Number(joinDelay ?? this.config.swarm.joinDelay)
    const groups = Array.isArray(mix) ? mix.filter(g => g && Number(g.weight) > 0) : []
    for (const g of groups) if (g.mode && !modes.get(g.mode)) throw new Error(`Mode inconnu : ${g.mode}`)
    const plan = groups.length ? mixOrder(count, groups) : []
    const created = []
    const errors = []
    let index = Number(startIndex) || 1
    let attempts = 0
    while (created.length < count && attempts < count + 1000) {
      attempts++
      const username = fillPlaceholders(pattern.includes('{i}') || count === 1 ? pattern : `${pattern}{i}`, { i: index++ })
      if (this.bots.has(username)) continue
      const group = groups.length ? groups[plan[created.length]] : null
      const groupOpts = group
        ? { mode: group.mode || opts.mode, modeOptions: group.modeOptions || {}, graph: group.graph || opts.graph }
        : {}
      try {
        created.push(this.createBot({ ...opts, ...groupOpts, username, connectDelay: (Number(joinOffset) || 0) + created.length * delay }))
      } catch (err) {
        errors.push(err.message)
        if (errors.length > 3) break
      }
    }
    if (created.length > 1) {
      const mixText = groups.length
        ? ` — ${groups.map((g, i) => `${plan.filter(p => p === i).length} ${g.mode || opts.mode || 'idle'}`).join(', ')}`
        : ''
      this.log.info(`Essaim de ${created.length} bots (un toutes les ${delay} ms)${mixText}`)
    }
    return { created: created.map(b => b.id), errors }
  }

  removeBot (id) {
    const instance = this.bots.get(id)
    if (!instance) return false
    if (instance.remote) {
      this.pool.removeBot(instance)
    } else {
      clearTimeout(instance._joinTimer)
      for (const rt of [...instance.runtimes]) rt.stop('Bot supprimé')
      instance.disconnect('Bot supprimé')
    }
    this.bots.delete(id)
    this.trails.remove(id)
    this.emit('botRemoved', id)
    this.emit('trailsCleared', [id])
    this.log.info(`Bot supprimé : ${id}`)
    return true
  }

  get (id) {
    return this.bots.get(id) || null
  }

  require (id) {
    const bot = this.get(id)
    if (!bot) throw new Error(`Bot introuvable : ${id}`)
    return bot
  }

  list () {
    return [...this.bots.values()]
  }

  localCount () {
    let n = 0
    for (const b of this.bots.values()) if (!b.remote) n++
    return n
  }

  states () {
    return this.list().map(b => b.getState())
  }

  isManaged (username) {
    return !!username && (this.bots.has(username) || this.externalNames.has(username))
  }

  /** "all", un id, une liste d'ids ou un motif avec * → instances. */
  resolve (target) {
    if (target === undefined || target === null || target === 'all' || target === '*') return this.list()
    const list = Array.isArray(target) ? target : String(target).split(',').map(s => s.trim()).filter(Boolean)
    const out = new Set()
    for (const t of list) {
      if (t === 'all' || t === '*') return this.list()
      if (t.includes('*')) {
        const re = new RegExp('^' + t.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
        for (const b of this.list()) if (re.test(b.id)) out.add(b)
      } else if (this.bots.has(t)) {
        out.add(this.bots.get(t))
      }
    }
    return [...out]
  }

  // --- Bots conservés d'un redémarrage à l'autre ---------------------------------

  /** Description des bots à recréer au prochain démarrage (hors bots temporaires des campagnes). */
  exportBots () {
    return this.list()
      .filter(b => !b.options.temporary)
      .map(b => {
        const { profilesFolder, temporary, ...options } = b.options
        return {
          ...options,
          mode: b.mode.name,
          modeOptions: b.mode.options,
          plugins: b.plugins,
          online: b.remote ? b.wantsOnline : !b.manualStop
        }
      })
  }

  saveBots () {
    // après l'arrêt, les bots se déconnectent : il ne faut pas enregistrer cet état-là
    if (!this.botsFile || this._closed) return
    try {
      const bots = this.exportBots()
      const text = JSON.stringify(bots)
      if (text === this._lastBotsText) return
      this._lastBotsText = text
      fs.mkdirSync(path.dirname(this.botsFile), { recursive: true })
      fs.writeFileSync(this.botsFile, JSON.stringify({ savedAt: Date.now(), bots }, null, 1))
    } catch (err) {
      this.log.warn(`Enregistrement de la liste des bots impossible : ${err.message}`)
    }
  }

  /** Recrée les bots enregistrés ; ceux qui étaient connectés se reconnectent à tour de rôle. */
  restoreBots () {
    if (!this.botsFile) return []
    let saved
    try {
      saved = JSON.parse(fs.readFileSync(this.botsFile, 'utf8')).bots || []
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Liste des bots illisible : ${err.message}`)
      return []
    }
    const delay = Number(this.config.swarm.joinDelay) || 1500
    const restored = []
    let n = 0
    for (const entry of saved) {
      if (!entry || !entry.username || this.bots.has(entry.username)) continue
      try {
        const { online, ...opts } = entry
        this.createBot({ ...opts, connect: !!online, connectDelay: online ? n++ * delay : 0 })
        restored.push(entry.username)
      } catch (err) {
        this.log.warn(`Bot ${entry.username} non restauré : ${err.message}`)
      }
    }
    if (restored.length) this.log.info(`${restored.length} bot(s) restauré(s) depuis la session précédente (${n} reconnecté(s))`)
    return restored
  }

  // --- Graphes -------------------------------------------------------------

  /**
   * Lance un graphe sur des bots. Par défaut, une exécution du même graphe déjà
   * en cours sur un bot est remplacée (pas de doublons en relançant).
   */
  runGraph (graphRef, targets, { replace = true } = {}) {
    const graph = this.graphs.load(graphRef)
    const bots = this.resolve(targets)
    if (!bots.length) throw new Error('Aucun bot ciblé')
    const local = bots.filter(b => !b.remote).map(instance => ({ instance }))
    const started = this._runLocal(graph, local, replace)
    const remote = bots.filter(b => b.remote)
    if (remote.length) started.push(...this.pool.runGraph(graph, remote, { replace }))
    this._pruneRuntimes()
    return started
  }

  /** Lance un graphe avec des identifiants d'exécution imposés (processus ouvrier). */
  runGraphWithIds (graph, items, { replace = true } = {}) {
    const entries = items.map(it => ({ instance: this.require(it.botId), id: it.runtimeId }))
    const started = this._runLocal(graph, entries, replace)
    this._pruneRuntimes()
    return started
  }

  _runLocal (graph, entries, replace) {
    const started = []
    for (const { instance, id } of entries) {
      if (replace) {
        for (const rt of [...instance.runtimes]) {
          if (rt.graph.id === (graph.id || 'sans-nom')) rt.stop('Relancé')
        }
      }
      const rt = new GraphRuntime({ manager: this, instance, graph, id })
      this.runtimes.set(rt.id, rt)
      rt.start()
      started.push(rt)
    }
    return started
  }

  stopRuntime (id, reason) {
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.stop(reason)
      return true
    }
    return this.pool ? this.pool.stopRuntime(id, reason) : false
  }

  stopRuntimes ({ botId, graphId } = {}) {
    let n = 0
    for (const rt of this.runtimes.values()) {
      if (!rt.active) continue
      if (botId && rt.instance.id !== botId) continue
      if (graphId && rt.graph.id !== graphId) continue
      rt.stop()
      n++
    }
    if (this.pool && this.pool.live().length) {
      n += this.pool.listRuntimes().filter(r => ACTIVE.has(r.status) && (!botId || r.botId === botId) && (!graphId || r.graphId === graphId)).length
      this.pool.stopRuntimes({ botId, graphId })
    }
    return n
  }

  listRuntimes () {
    const all = [...this.runtimes.values()].map(r => r.summary())
    if (this.pool) all.push(...this.pool.listRuntimes())
    return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  }

  _pruneRuntimes () {
    const done = [...this.runtimes.values()].filter(r => !r.active)
    for (const r of done.slice(0, Math.max(0, done.length - 100))) this.runtimes.delete(r.id)
  }

  /** Envoie un signal aux nœuds "Signal reçu". */
  trigger (name, data, targets) {
    const bots = this.resolve(targets)
    for (const b of bots) if (!b.remote) b.events.emit('custom', { name: String(name), data })
    const remote = bots.filter(b => b.remote)
    if (remote.length) this.pool.trigger(String(name), data, remote)
    return bots.length
  }

  // --- Traces et repères de la carte ------------------------------------------

  /** Relève la position de chaque bot en jeu et diffuse les nouveaux points. */
  sampleTrails (now = Date.now()) {
    const changes = []
    for (const b of this.bots.values()) {
      const pos = b.trailPosition()
      if (!pos) {
        this.trails.pause(b.id)
        continue
      }
      const change = this.trails.record(b.id, pos.x, pos.z, pos.dimension, now)
      if (change) changes.push(change)
    }
    if (now - this._trailPrunedAt >= 10000) {
      this._trailPrunedAt = now
      this.trails.prune(now)
    }
    if (changes.length) this.emit('trails', changes)
  }

  /** Repère sur la carte (mort, blocage, expulsion) : { kind, id, x, z, dimension }. */
  addMarker (marker) {
    if (this.isWorker) {
      this.emit('marker', marker)
      return
    }
    const m = this.trails.addMarker(marker)
    if (m) this.emit('marker', m)
  }

  clearTrails (ids = null) {
    this.trails.clear(ids)
    this.emit('trailsCleared', ids)
  }

  saveTrails () {
    try {
      this.trails.save()
    } catch (err) {
      this.log.warn(`Enregistrement des traces impossible : ${err.message}`)
    }
  }

  shutdown () {
    if (this.campaigns) this.campaigns.stop()
    for (const t of this.timers) clearInterval(t)
    clearTimeout(this._botsSaveTimer)
    if (!this.isWorker) {
      this.saveTrails()
      this.saveBots()
    }
    this._closed = true
    if (this.probe) this.probe.stop()
    this.server.close()
    if (this.pool) this.pool.shutdown()
    for (const rt of this.runtimes.values()) if (rt.active) rt.stop('Arrêt du programme')
    for (const b of this.list()) {
      if (b.remote) continue
      clearTimeout(b._joinTimer)
      b.disconnect('Arrêt du programme')
    }
  }
}

module.exports = { BotManager, mixOrder }
