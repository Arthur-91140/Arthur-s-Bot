'use strict'

const path = require('path')
const { EventEmitter } = require('events')
const { BotInstance } = require('./BotInstance')
const { ReportStore } = require('./ReportStore')
const { TrailStore } = require('./TrailStore')
const { GraphStore } = require('../graph/GraphStore')
const { GraphRuntime } = require('../graph/GraphRuntime')
const modes = require('../modes')
const { fillPlaceholders } = require('./utils')

const OFFLINE_NAME = /^[A-Za-z0-9_]{1,16}$/

/**
 * Gestionnaire central : crée les bots (seuls ou en essaim), lance les graphes,
 * centralise les rapports, les variables partagées et les évènements pour l'UI.
 */
class BotManager extends EventEmitter {
  constructor ({ config, logger }) {
    super()
    this.setMaxListeners(100)
    this.config = config
    this.logger = logger
    this.log = logger.child('manager')
    this.bots = new Map()
    this.runtimes = new Map()
    this.shared = {}
    this.reports = new ReportStore({ dir: config.paths.reports })
    this.graphs = new GraphStore(config.paths.graphs)

    // Traces des déplacements : un point par seconde et par bot, enregistrées sur disque.
    const trails = config.trails || {}
    this.trails = new TrailStore({
      keepMinutes: trails.keepMinutes,
      file: trails.persist !== false && config.paths.data ? path.join(config.paths.data, 'trails.json') : null
    })
    this._trailTimer = setInterval(() => this.sampleTrails(), 1000)
    this._trailSaveTimer = setInterval(() => this.saveTrails(), 30000)
    this._trailTimer.unref()
    this._trailSaveTimer.unref()
    this._trailPrunedAt = 0
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
      plugins
    }
  }

  createBot (opts = {}) {
    const options = this.normalizeOptions(opts)
    if (!options.username) throw new Error('Pseudo requis')
    if (options.auth === 'offline' && !OFFLINE_NAME.test(options.username)) {
      throw new Error(`Pseudo invalide "${options.username}" : 1 à 16 caractères parmi A-Z, a-z, 0-9 et _`)
    }
    if (this.bots.has(options.username)) throw new Error(`Un bot nommé ${options.username} existe déjà`)
    if (!modes.get(options.mode)) throw new Error(`Mode inconnu : ${options.mode}`)
    const instance = new BotInstance(this, options)
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
    if (opts.graph) {
      try {
        this.runGraph(opts.graph, [instance.id])
      } catch (err) {
        instance.log.error(`Graphe "${opts.graph}" : ${err.message}`)
      }
    }
    return instance
  }

  /**
   * Crée plusieurs bots avec un motif de nom ("Bot_{i}") et un délai entre chaque
   * connexion pour ne pas déclencher l'anti-flood du serveur.
   */
  createSwarm ({ count = 1, namePattern, startIndex = 1, joinDelay, ...opts } = {}) {
    const pattern = namePattern || this.config.swarm.namePattern
    const delay = Number(joinDelay ?? this.config.swarm.joinDelay)
    const created = []
    const errors = []
    let index = Number(startIndex) || 1
    let attempts = 0
    while (created.length < count && attempts < count + 1000) {
      attempts++
      const username = fillPlaceholders(pattern.includes('{i}') || count === 1 ? pattern : `${pattern}{i}`, { i: index++ })
      if (this.bots.has(username)) continue
      try {
        created.push(this.createBot({ ...opts, username, connectDelay: created.length * delay }))
      } catch (err) {
        errors.push(err.message)
        if (errors.length > 3) break
      }
    }
    if (created.length > 1) this.log.info(`Essaim de ${created.length} bots (un toutes les ${delay} ms)`)
    return { created: created.map(b => b.id), errors }
  }

  removeBot (id) {
    const instance = this.bots.get(id)
    if (!instance) return false
    clearTimeout(instance._joinTimer)
    for (const rt of [...instance.runtimes]) rt.stop('Bot supprimé')
    instance.disconnect('Bot supprimé')
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

  states () {
    return this.list().map(b => b.getState())
  }

  isManaged (username) {
    return !!username && this.bots.has(username)
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

  // --- Graphes -------------------------------------------------------------

  /**
   * Lance un graphe sur des bots. Par défaut, une exécution du même graphe déjà
   * en cours sur un bot est remplacée (pas de doublons en relançant).
   */
  runGraph (graphRef, targets, { replace = true } = {}) {
    const graph = this.graphs.load(graphRef)
    const bots = this.resolve(targets)
    if (!bots.length) throw new Error('Aucun bot ciblé')
    const started = []
    for (const instance of bots) {
      if (replace) {
        for (const rt of [...instance.runtimes]) {
          if (rt.graph.id === (graph.id || 'sans-nom')) rt.stop('Relancé')
        }
      }
      const rt = new GraphRuntime({ manager: this, instance, graph })
      this.runtimes.set(rt.id, rt)
      rt.start()
      started.push(rt)
    }
    this._pruneRuntimes()
    return started
  }

  stopRuntime (id, reason) {
    const rt = this.runtimes.get(id)
    if (!rt) return false
    rt.stop(reason)
    return true
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
    return n
  }

  listRuntimes () {
    return [...this.runtimes.values()].map(r => r.summary()).reverse()
  }

  _pruneRuntimes () {
    const done = [...this.runtimes.values()].filter(r => !r.active)
    for (const r of done.slice(0, Math.max(0, done.length - 100))) this.runtimes.delete(r.id)
  }

  /** Envoie un signal aux nœuds "Signal reçu". */
  trigger (name, data, targets) {
    const bots = this.resolve(targets)
    for (const b of bots) b.events.emit('custom', { name: String(name), data })
    return bots.length
  }

  /** Relève la position de chaque bot en jeu et diffuse les nouveaux points. */
  sampleTrails (now = Date.now()) {
    const changes = []
    for (const b of this.bots.values()) {
      const bot = b.bot
      if (b.status !== 'online' || !bot || !bot.entity || !bot.entity.position || !bot.game) {
        this.trails.pause(b.id)
        continue
      }
      const { x, z } = bot.entity.position
      const change = this.trails.record(b.id, x, z, String(bot.game.dimension).replace('minecraft:', ''), now)
      if (change) changes.push(change)
    }
    if (now - this._trailPrunedAt >= 10000) {
      this._trailPrunedAt = now
      this.trails.prune(now)
    }
    if (changes.length) this.emit('trails', changes)
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
    clearInterval(this._trailTimer)
    clearInterval(this._trailSaveTimer)
    this.saveTrails()
    for (const rt of this.runtimes.values()) if (rt.active) rt.stop('Arrêt du programme')
    for (const b of this.list()) {
      clearTimeout(b._joinTimer)
      b.disconnect('Arrêt du programme')
    }
  }
}

module.exports = { BotManager }
