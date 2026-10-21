'use strict'

const { Vec3 } = require('vec3')
const registry = require('./registry')
const expr = require('./expression')
const { stopMoving } = require('../core/navigation')
const u = require('../core/utils')

const MAX_STEPS_PER_SECOND = 20000
const TRACE_THROTTLE_MS = 120

let seq = 0

/** Instantané sûr de l'état du bot, exposé sous le nom `bot` dans les expressions. */
function botSnapshot (instance) {
  const bot = instance.bot
  const online = instance.status === 'online' && bot && bot.entity
  if (!online) return { username: instance.options.username, online: false, status: instance.status }
  const p = bot.entity.position
  return {
    username: bot.username,
    online: true,
    status: instance.status,
    health: bot.health,
    food: bot.food,
    saturation: bot.foodSaturation,
    x: u.round(p.x),
    y: u.round(p.y),
    z: u.round(p.z),
    blockX: Math.floor(p.x),
    blockY: Math.floor(p.y),
    blockZ: Math.floor(p.z),
    yaw: u.round(((Math.PI - bot.entity.yaw) * 180) / Math.PI, 1),
    pitch: u.round((-bot.entity.pitch * 180) / Math.PI, 1),
    onGround: bot.entity.onGround,
    dimension: String(bot.game.dimension).replace('minecraft:', ''),
    gameMode: bot.game.gameMode,
    ping: bot.player ? bot.player.ping : null,
    level: bot.experience ? bot.experience.level : 0,
    players: Object.keys(bot.players).length,
    playerNames: Object.keys(bot.players),
    heldItem: bot.heldItem ? bot.heldItem.name : null,
    isRaining: !!bot.isRaining,
    timeOfDay: bot.time ? bot.time.timeOfDay : null,
    isDay: bot.time ? bot.time.isDay : null,
    tps: instance.tps,
    windowTitle: bot.currentWindow ? u.chatToText(bot.currentWindow.title) : null,
    emptySlots: bot.inventory.emptySlotCount(),
    moving: bot.pathfinder ? bot.pathfinder.isMoving() : false
  }
}

/** Fonctions des expressions qui interrogent le bot et le monde. */
function botFunctions (instance) {
  const manager = instance.manager
  const live = () => (instance.status === 'online' && instance.bot && instance.bot.entity ? instance.bot : null)
  const nearest = (filter, maxDist) => {
    const bot = live()
    if (!bot) return null
    return bot.nearestEntity(e => {
      if (e === bot.entity || !e.position || e.position.distanceTo(bot.entity.position) > maxDist) return false
      if (!filter) return true
      if (filter === 'hostile') return u.isHostile(e)
      if (filter === 'player') return e.type === 'player'
      return e.username === filter || e.name === filter || e.type === filter
    })
  }
  const info = e => {
    const bot = live()
    if (!e || !bot) return null
    return {
      id: e.id,
      name: u.entityLabel(e),
      type: e.type,
      x: u.round(e.position.x),
      y: u.round(e.position.y),
      z: u.round(e.position.z),
      distance: u.round(e.position.distanceTo(bot.entity.position))
    }
  }
  return {
    hasItem: (name, count = 1) => u.countItem(live(), name) >= count,
    countItem: name => u.countItem(live(), name),
    blockAt: (x, y, z) => {
      const bot = live()
      const b = bot && bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
      return b ? b.name : null
    },
    blockBelow: () => {
      const bot = live()
      const b = bot && bot.blockAt(bot.entity.position.offset(0, -1, 0))
      return b ? b.name : null
    },
    distanceTo: (x, y, z) => {
      const bot = live()
      return bot ? u.round(bot.entity.position.distanceTo(new Vec3(x, y, z))) : null
    },
    nearestPlayer: (maxDist = 64, includeBots = false) => {
      const bot = live()
      if (!bot) return null
      const e = bot.nearestEntity(x => x.type === 'player' && x.username !== bot.username &&
        (includeBots || !manager.isManaged(x.username)) && x.position.distanceTo(bot.entity.position) <= maxDist)
      return e ? e.username : null
    },
    nearestEntity: (filter = '', maxDist = 32) => info(nearest(filter, maxDist)),
    entityCount: (filter = '', maxDist = 9999) => {
      const bot = live()
      if (!bot) return 0
      return Object.values(bot.entities).filter(e => e !== bot.entity && e.position &&
        e.position.distanceTo(bot.entity.position) <= maxDist &&
        (!filter || (filter === 'hostile' ? u.isHostile(e) : filter === 'player' ? e.type === 'player' : e.name === filter || e.type === filter))).length
    },
    playerOnline: name => {
      const bot = live()
      return !!(bot && bot.players[name])
    },
    players: () => {
      const bot = live()
      return bot ? Object.keys(bot.players) : []
    },
    playerPos: name => {
      const bot = live()
      const p = bot && bot.players[name]
      return p && p.entity ? { x: u.round(p.entity.position.x), y: u.round(p.entity.position.y), z: u.round(p.entity.position.z) } : null
    },
    findBlock: (name, maxDist = 32) => {
      const bot = live()
      if (!bot) return null
      const ids = u.resolveBlockIds(bot.registry, name)
      const b = ids.length ? bot.findBlock({ matching: ids, maxDistance: maxDist }) : null
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z, name: b.name } : null
    },
    inventoryFull: () => {
      const bot = live()
      return bot ? bot.inventory.emptySlotCount() === 0 : false
    },
    isManaged: name => manager.isManaged(name),
    botNames: () => manager.list().map(b => b.username),
    lastMessage: () => {
      const last = [...instance.chatHistory].reverse().find(m => m.type !== 'self')
      return last ? last.message : null
    },
    online: () => instance.status === 'online'
  }
}

/**
 * Un flux = une exécution déclenchée par un évènement. Les variables locales
 * (event, index, found...) lui sont propres.
 */
class Flow {
  constructor (runtime, locals) {
    this.runtime = runtime
    this.locals = locals
    this.steps = 0
    this.burstStart = Date.now()
    this.burstSteps = 0
  }

  async exec (fromId, port) {
    const targets = this.runtime.targets(fromId, port)
    if (!targets.length) return
    if (targets.length === 1) return this.run(targets[0])
    await Promise.all(targets.map(id => this.run(id)))
  }

  /** Compte les étapes, cède la main régulièrement et détecte les boucles sans attente. */
  async tick () {
    this.runtime.stats.steps++
    const now = Date.now()
    if (now - this.burstStart > 1000) {
      this.burstStart = now
      this.burstSteps = 0
    }
    if (++this.burstSteps > MAX_STEPS_PER_SECOND) {
      throw new Error(`Plus de ${MAX_STEPS_PER_SECOND} étapes en une seconde : boucle infinie ? Ajoutez un nœud "Attendre" dans la boucle.`)
    }
    if (++this.steps % 100 === 0) await new Promise(resolve => setImmediate(resolve))
  }

  async run (startId) {
    const rt = this.runtime
    let nodeId = startId
    while (nodeId) {
      rt.checkActive()
      await this.tick()
      const node = rt.nodes.get(nodeId)
      const def = node && registry.get(node.type)
      if (!def || def.passive || def.subscribe) return
      rt.trace(nodeId)
      let result
      try {
        result = await def.run(rt.api(node, this))
      } catch (err) {
        if (u.isAbortError(err) && rt.signal.aborted) throw err
        rt.nodeError(node, def, err)
        if (!def.outputs.some(o => o.name === 'error')) return
        result = 'error'
      }
      if (result === undefined) result = def.outputs.length ? def.outputs[0].name : null
      if (result === null) return
      const ports = Array.isArray(result) ? result : [result]
      // Chaîne simple : on itère au lieu d'empiler les appels, ce qui permet
      // de boucler indéfiniment dans le graphe (A → B → A) sans fuite mémoire.
      if (ports.length === 1) {
        const targets = rt.targets(nodeId, ports[0])
        if (targets.length === 1) {
          nodeId = targets[0]
          continue
        }
      }
      for (const port of ports) await this.exec(nodeId, port)
      return
    }
  }
}

/**
 * Exécution d'un graphe de comportement sur un bot. Les nœuds évènements
 * s'abonnent aux évènements de l'instance (qui survivent aux reconnexions).
 */
class GraphRuntime {
  constructor ({ manager, instance, graph }) {
    this.id = `run${Date.now().toString(36)}${(++seq).toString(36)}`
    this.manager = manager
    this.instance = instance
    this.graph = JSON.parse(JSON.stringify(graph))
    this.graph.id = this.graph.id || 'sans-nom'
    this.graph.name = this.graph.name || this.graph.id
    this.status = 'idle'
    this.vars = JSON.parse(JSON.stringify(this.graph.variables || {}))
    this.timers = {}
    this.nodeStates = new Map()
    this.stats = { flows: 0, steps: 0, errors: 0 }
    this.startedAt = null
    this.endedAt = null
    this.stopReason = null
    this.usedMovement = false
    this._abort = new AbortController()
    this._unsubs = []
    this._running = new Map()
    this._lastTrace = new Map()
    this.nodes = new Map()
    this.outgoing = new Map()
    for (const node of this.graph.nodes || []) {
      node.params = node.params || {}
      this.nodes.set(node.id, node)
    }
    for (const link of this.graph.links || []) {
      if (!this.nodes.has(link.from) || !this.nodes.has(link.to)) continue
      const port = link.fromPort || 'out'
      if (!this.outgoing.has(link.from)) this.outgoing.set(link.from, new Map())
      const ports = this.outgoing.get(link.from)
      if (!ports.has(port)) ports.set(port, [])
      ports.get(port).push(link.to)
    }
    this.report = manager.reports.create({
      kind: 'graph',
      name: `${this.graph.name} (${instance.id})`,
      botId: instance.id,
      graphId: this.graph.id,
      runtimeId: this.id,
      source: 'graph'
    })
    this.log = instance.manager.logger.child(`${instance.id}/${this.graph.name}`)
  }

  get signal () {
    return this._abort.signal
  }

  get active () {
    return this.status === 'running'
  }

  checkActive () {
    if (!this.active) throw u.abortError('Graphe arrêté')
  }

  targets (nodeId, port) {
    const ports = this.outgoing.get(nodeId)
    return (ports && ports.get(port)) || []
  }

  start () {
    const { errors, warnings } = registry.validate(this.graph)
    for (const w of warnings) this.log.warn(w)
    if (errors.length) {
      for (const e of errors) this.report.error(e)
      this.status = 'error'
      this.report.finish('error', errors[0])
      throw new Error(`Graphe invalide : ${errors.join(' ; ')}`)
    }
    this.status = 'running'
    this.startedAt = Date.now()
    this.instance.runtimes.add(this)
    for (const node of this.nodes.values()) {
      const def = registry.get(node.type)
      if (!def || !def.subscribe) continue
      try {
        const unsub = def.subscribe(this.api(node, null), (payload, port) => this.fire(node, payload, port))
        if (typeof unsub === 'function') this._unsubs.push(unsub)
      } catch (err) {
        this.nodeError(node, def, err)
      }
    }
    this.log.info(`Comportement démarré (${this.nodes.size} nœuds)`)
    this.manager.emit('runtime', this.summary())
    return this
  }

  fire (node, payload = {}, port = 'out') {
    if (!this.active) return
    if (node.params.allowOverlap === false && (this._running.get(node.id) || 0) > 0) return
    const flow = new Flow(this, { event: payload || {} })
    this.stats.flows++
    this._running.set(node.id, (this._running.get(node.id) || 0) + 1)
    this.trace(node.id)
    flow.exec(node.id, port)
      .catch(err => {
        if (!u.isAbortError(err)) {
          this.stats.errors++
          this.log.error(`Flux interrompu : ${u.errorMessage(err)}`)
          this.report.error(u.errorMessage(err), node.id)
        }
      })
      .finally(() => this._running.set(node.id, this._running.get(node.id) - 1))
  }

  stop (reason = 'Arrêt demandé', status = 'stopped') {
    if (!this.active) return
    this.status = status
    this.stopReason = reason
    this.endedAt = Date.now()
    this._abort.abort()
    for (const unsub of this._unsubs) {
      try { unsub() } catch (err) { /* ignore */ }
    }
    this._unsubs = []
    if (this.usedMovement && this.instance.bot) stopMoving(this.instance.bot)
    this.report.finish(status === 'finished' ? 'auto' : 'stopped', reason)
    this.instance.runtimes.delete(this)
    this.log.info(`Comportement arrêté : ${reason}`)
    this.manager.emit('runtime', this.summary())
    this.instance.emitState()
  }

  trace (nodeId, error = null) {
    const now = Date.now()
    if (!error && now - (this._lastTrace.get(nodeId) || 0) < TRACE_THROTTLE_MS) return
    this._lastTrace.set(nodeId, now)
    this.manager.emit('trace', { runtimeId: this.id, graphId: this.graph.id, botId: this.instance.id, nodeId, error })
  }

  nodeError (node, def, err) {
    const message = `${def ? def.label : node.type} : ${u.errorMessage(err)}`
    this.stats.errors++
    this.log.warn(message)
    this.report.error(message, node.id)
    this.trace(node.id, u.errorMessage(err))
  }

  scope (node, flow) {
    const locals = flow ? flow.locals : {}
    const instance = this.instance
    return expr.createScope({
      layers: [locals, this.vars],
      constants: {
        bot: () => botSnapshot(instance),
        event: () => locals.event || {},
        vars: this.vars,
        shared: this.manager.shared,
        graph: { id: this.graph.id, name: this.graph.name }
      },
      functions: this._functions || (this._functions = botFunctions(instance))
    })
  }

  /** Objet passé aux fonctions run/subscribe des nœuds. */
  api (node, flow) {
    const runtime = this
    const def = registry.get(node.type)
    const scope = this.scope(node, flow)
    if (!this.nodeStates.has(node.id)) this.nodeStates.set(node.id, {})
    const resolve = (p, raw) => {
      if (raw === undefined) raw = p.default
      try {
        switch (p.type) {
          case 'number': {
            const v = typeof raw === 'number' ? raw : raw === '' || raw === null ? p.default : expr.interpolateOrEval(raw, scope)
            const n = Number(v)
            if (!Number.isFinite(n)) throw new Error(`nombre attendu, obtenu "${v}"`)
            return n
          }
          case 'boolean':
            return typeof raw === 'boolean' ? raw : !!expr.interpolateOrEval(raw, scope)
          case 'expression':
            return raw === '' || raw === null || raw === undefined ? undefined : expr.evaluate(raw, scope)
          case 'json': {
            const v = expr.interpolate(raw, scope)
            if (typeof v !== 'string') return v
            return v.trim() ? JSON.parse(v) : null
          }
          case 'variable':
            return String(raw || '').trim()
          case 'select':
          case 'mode':
            return typeof raw === 'string' && raw.includes('{{') ? expr.interpolate(raw, scope) : raw
          default: {
            const v = expr.interpolate(raw === null || raw === undefined ? '' : raw, scope)
            return typeof v === 'string' ? v : expr.toText(v)
          }
        }
      } catch (err) {
        throw new Error(`paramètre "${p.label}" : ${u.errorMessage(err)}`)
      }
    }
    return {
      node,
      def,
      runtime,
      flow,
      instance: this.instance,
      manager: this.manager,
      report: this.report,
      signal: this.signal,
      locals: flow ? flow.locals : {},
      vars: this.vars,
      shared: this.manager.shared,
      nodeState: this.nodeStates.get(node.id),
      get bot () {
        return runtime.instance.requireBot()
      },
      param (key) {
        const p = def.params.find(x => x.key === key)
        if (!p) return node.params[key]
        return resolve(p, node.params[key])
      },
      evaluate: src => expr.evaluate(src, scope),
      interpolate: text => expr.interpolate(text, scope),
      exec: port => (flow ? flow.exec(node.id, port) : Promise.resolve()),
      connectedPorts: () => def.outputs.map(o => o.name).filter(name => runtime.targets(node.id, name).length > 0),
      getVar (name, scopeName = 'graph') {
        if (scopeName === 'flow') return flow ? flow.locals[name] : undefined
        if (scopeName === 'shared') return runtime.manager.shared[name]
        return runtime.vars[name]
      },
      setVar (name, value, scopeName = 'graph') {
        if (!name) throw new Error('Nom de variable vide')
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Nom de variable interdit')
        if (scopeName === 'flow') {
          if (flow) flow.locals[name] = value
        } else if (scopeName === 'shared') {
          runtime.manager.shared[name] = value
        } else {
          runtime.vars[name] = value
        }
      },
      log (message, level = 'info') {
        const fn = runtime.log[level] || runtime.log.info
        fn(message)
      },
      sleep: ms => u.sleep(ms, runtime.signal)
    }
  }

  summary () {
    return {
      id: this.id,
      graphId: this.graph.id,
      name: this.graph.name,
      botId: this.instance.id,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      stopReason: this.stopReason,
      reportId: this.report.id,
      stats: this.stats
    }
  }
}

module.exports = { GraphRuntime, botSnapshot, botFunctions }
