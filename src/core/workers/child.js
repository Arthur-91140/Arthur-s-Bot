'use strict'

// Processus ouvrier : héberge une partie des bots pour le processus principal, qui
// garde l'interface web, les rapports, les traces et les outils du serveur.

const { EventEmitter } = require('events')
const { Logger } = require('../Logger')
const { runAction } = require('../actions')
const { snapshot } = require('../view')
const { HealthProbe } = require('../health')

let manager = null

function send (msg) {
  if (!process.connected) return
  try {
    process.send(msg)
  } catch (err) {
    // le processus principal s'arrête
  }
}

/** Outils du serveur vus depuis un ouvrier : les appels passent par le processus principal. */
class ServerToolsProxy extends EventEmitter {
  constructor () {
    super()
    this.setMaxListeners(500)
    this.lastState = null
    this.pending = new Map()
    this.nextId = 1
  }

  request (op, args) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${op} : pas de réponse du processus principal`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      send({ type: 'req', id, op, args })
    })
  }

  resolve ({ id, result, error }) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  }

  runRcon (command) {
    return this.request('rcon', { command })
  }

  manage (method, params = []) {
    return this.request('manage', { method, params })
  }

  serverPlayers () {
    const m = this.lastState && this.lastState.management
    return m && m.connected ? m.players : null
  }

  state () {
    return this.lastState
  }

  close () {}
}

const server = new ServerToolsProxy()

function init ({ config }) {
  const { BotManager } = require('../BotManager')
  const logger = new Logger({ maxLines: 200, console: 'none', file: null })
  logger.on('line', l => send({ type: 'log', level: l.level, source: l.source, message: l.message }))
  manager = new BotManager({ config, logger, worker: true, serverTools: server })
  manager.on('chat', payload => send({ type: 'chat', payload }))
  manager.on('trace', payload => send({ type: 'trace', payload }))
  manager.on('runtime', payload => send({ type: 'runtime', payload }))
  manager.on('marker', payload => send({ type: 'marker', payload }))
  manager.reports.on('update', summary => {
    const report = manager.reports.get(summary.id)
    if (report) send({ type: 'report', payload: report.toJSON() })
  })

  // États des bots : dès qu'ils changent (au plus 4 fois par seconde) et au moins chaque seconde.
  let dirty = true
  let lastSent = 0
  manager.on('botChanged', () => { dirty = true })
  setInterval(() => {
    const now = Date.now()
    if (!dirty && now - lastSent < 1000) return
    dirty = false
    lastSent = now
    send({ type: 'states', states: manager.states() })
  }, 250)

  const probe = new HealthProbe()
  setInterval(() => send({ type: 'health', payload: probe.sample({ bots: manager.bots.size }) }), 2000)
  send({ type: 'ready' })
}

async function handle ({ id, op, args }) {
  try {
    let result
    switch (op) {
      case 'createBot': {
        const b = manager.createBot({ ...args.options, connect: args.connect, connectDelay: args.connectDelay })
        result = b.id
        break
      }
      case 'removeBot':
        result = manager.removeBot(args.id)
        break
      case 'action':
        result = await runAction(manager.require(args.id), args.action, args.payload || {})
        break
      case 'call': {
        const b = manager.require(args.id)
        const [first] = args.args || []
        if (args.method === 'view') result = snapshot(b, first || {})
        else if (args.method === 'getChat') result = b.getChat(first)
        else if (args.method === 'getInventory') result = b.getInventory()
        else if (args.method === 'getWindow') result = b.getWindow()
        else if (args.method === 'protocol') result = b.protocolInfo()
        else throw new Error(`Méthode inconnue : ${args.method}`)
        break
      }
      case 'runGraph':
        result = manager.runGraphWithIds(args.graph, args.items, { replace: args.replace }).map(r => r.summary())
        break
      case 'stopRuntime':
        result = manager.stopRuntime(args.id, args.reason)
        break
      case 'stopRuntimes':
        result = manager.stopRuntimes(args.filter || {})
        break
      case 'trigger':
        result = manager.trigger(args.name, args.data, args.ids)
        break
      default:
        throw new Error(`Opération inconnue : ${op}`)
    }
    send({ type: 'res', id, result: result === undefined ? null : result })
  } catch (err) {
    send({ type: 'res', id, error: err && err.message ? err.message : String(err) })
  }
}

function stop () {
  if (manager) manager.shutdown()
  setTimeout(() => process.exit(0), 800)
}

process.on('message', m => {
  if (!m || !m.type) return
  if (m.type === 'init') init(m)
  else if (m.type === 'req') handle(m)
  else if (m.type === 'res') server.resolve(m)
  else if (m.type === 'names' && manager) manager.externalNames = new Set(m.names)
  else if (m.type === 'server') {
    if (m.event === 'state') server.lastState = m.payload
    server.emit(m.event, m.payload)
  } else if (m.type === 'shutdown') stop()
})
// Le processus principal a disparu : on déconnecte proprement les bots.
process.on('disconnect', stop)
process.on('uncaughtException', err => send({ type: 'log', level: 'error', source: `processus ${process.env.ARTHUR_WORKER}`, message: `Exception non gérée : ${err && err.stack ? err.stack : err}` }))
process.on('unhandledRejection', err => send({ type: 'log', level: 'error', source: `processus ${process.env.ARTHUR_WORKER}`, message: `Promesse rejetée non gérée : ${err && err.stack ? err.stack : err}` }))
