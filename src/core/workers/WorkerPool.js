'use strict'

const os = require('os')
const path = require('path')
const { fork } = require('child_process')
const { RemoteBot } = require('./RemoteBot')

const CHILD = path.join(__dirname, 'child.js')
const IDLE_MS = 30000 // un ouvrier sans bot est arrêté au bout de 30 s
const CRASH_WINDOW_MS = 15000 // un ouvrier qui meurt plus vite n'est pas relancé (boucle de plantage)

/** Un processus ouvrier : héberge une partie des bots et relaie leurs évènements. */
class Worker {
  constructor (pool, index) {
    this.pool = pool
    this.index = index
    this.label = `P${index}`
    this.bots = new Map()
    this.pending = new Map()
    this.nextId = 1
    this.health = null
    this.exited = false
    this.closing = false
    this.startedAt = Date.now()
    this.idleSince = null
    this.child = fork(CHILD, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ARTHUR_WORKER: String(index) },
      serialization: 'advanced'
    })
    this.child.on('message', m => this.onMessage(m))
    this.child.on('exit', (code, signal) => this.onExit(code, signal))
    this.child.on('error', err => pool.log.error(`Processus ${this.label} : ${err.message}`))
    this.send({ type: 'init', index, config: pool.childConfig() })
  }

  get pid () {
    return this.child.pid
  }

  send (msg) {
    if (this.exited || !this.child.connected) return false
    try {
      this.child.send(msg)
      return true
    } catch (err) {
      return false
    }
  }

  request (op, args = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error(`Processus ${this.label} arrêté`))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Processus ${this.label} : pas de réponse (${op})`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ type: 'req', id, op, args })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Processus ${this.label} injoignable`))
      }
    })
  }

  onMessage (m) {
    const manager = this.pool.manager
    switch (m.type) {
      case 'res': {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(m.error))
        else p.resolve(m.result)
        return
      }
      case 'states':
        for (const s of m.states) {
          const bot = this.bots.get(s.id)
          if (bot) bot.update(s)
        }
        manager.emit('botChanged')
        return
      case 'log':
        manager.logger.log(m.level, m.source, m.message)
        return
      case 'chat':
        manager.emit('chat', m.payload)
        return
      case 'trace':
        manager.emit('trace', m.payload)
        return
      case 'runtime':
        this.pool.onRuntime(this, m.payload)
        return
      case 'report':
        manager.reports.ingest(m.payload)
        return
      case 'marker':
        manager.addMarker(m.payload)
        return
      case 'health':
        this.health = { ...m.payload, process: this.label, bots: this.bots.size }
        return
      case 'req':
        this.pool.handleChildRequest(this, m)
    }
  }

  onExit (code, signal) {
    this.exited = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`Processus ${this.label} arrêté`))
      this.pending.delete(id)
    }
    this.pool.onWorkerExit(this, code, signal)
  }

  stop () {
    this.closing = true
    this.send({ type: 'shutdown' })
    const timer = setTimeout(() => { if (!this.exited) this.child.kill('SIGKILL') }, 4000)
    timer.unref()
  }
}

/**
 * Répartit les bots sur plusieurs processus Node.js au-delà d'un seuil, pour que
 * le programme ne sature pas pendant les gros tests de charge : le processus
 * principal garde l'interface et les `botsPerProcess` premiers bots, les suivants
 * vont dans des processus ouvriers (au plus `maxProcesses`).
 */
class WorkerPool {
  constructor (manager, options = {}) {
    this.manager = manager
    this.log = manager.logger.child('processus')
    this.enabled = options.enabled !== false
    this.botsPerProcess = Math.max(5, Number(options.botsPerProcess) || 100)
    this.maxProcesses = Math.max(1, Number(options.maxProcesses) || Math.max(1, os.cpus().length - 1))
    this.workers = []
    this.nextIndex = 1
    this.runtimes = new Map() // exécutions de graphes dans les ouvriers : id → résumé
    this.closing = false
    this.idleTimer = setInterval(() => this.stopIdleWorkers(), 5000)
    this.idleTimer.unref()
  }

  localCount () {
    let n = 0
    for (const b of this.manager.bots.values()) if (!b.remote) n++
    return n
  }

  /** Le prochain bot doit-il aller dans un processus ouvrier ? */
  shouldPlace (forced = null) {
    if (forced === false) return false
    if (forced === true) return true
    return this.enabled && this.localCount() >= this.botsPerProcess
  }

  pickWorker () {
    const live = this.workers.filter(w => !w.exited && !w.closing)
    const free = live.filter(w => w.bots.size < this.botsPerProcess).sort((a, b) => b.bots.size - a.bots.size)
    if (free.length) return free[0]
    if (live.length < this.maxProcesses) return this.spawn()
    return live.sort((a, b) => a.bots.size - b.bots.size)[0]
  }

  spawn () {
    const w = new Worker(this, this.nextIndex++)
    this.workers.push(w)
    this.log.info(`Processus ouvrier ${w.label} démarré (pid ${w.pid})`)
    return w
  }

  createBot (options, { connect = true, connectDelay = 0 } = {}) {
    const worker = this.pickWorker()
    const bot = new RemoteBot(this, worker, options)
    worker.bots.set(bot.id, bot)
    worker.idleSince = null
    this._create(worker, bot, connect, connectDelay)
    return bot
  }

  _create (worker, bot, connect, connectDelay) {
    worker.request('createBot', { options: bot.options, connect, connectDelay }).catch(err => {
      this.log.error(`${bot.id} : création dans ${worker.label} impossible (${err.message})`)
      bot.update({ ...bot.state, status: 'offline', lastError: err.message })
      this.manager.emit('botChanged')
    })
  }

  removeBot (bot) {
    bot.worker.bots.delete(bot.id)
    if (!bot.worker.bots.size) bot.worker.idleSince = Date.now()
    bot.worker.request('removeBot', { id: bot.id }).catch(() => {})
  }

  /** Lance un graphe sur des bots distants ; les identifiants d'exécution sont choisis ici. */
  runGraph (graph, bots, { replace = true } = {}) {
    const byWorker = new Map()
    const started = []
    for (const bot of bots) {
      const id = `run${bot.worker.label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const summary = { id, graphId: graph.id || 'sans-nom', name: graph.name || graph.id, botId: bot.id, status: 'starting', startedAt: Date.now(), process: bot.worker.label }
      this.runtimes.set(id, summary)
      if (!byWorker.has(bot.worker)) byWorker.set(bot.worker, [])
      byWorker.get(bot.worker).push({ botId: bot.id, runtimeId: id })
      started.push(this._remoteRuntime(id))
    }
    for (const [worker, items] of byWorker) {
      worker.request('runGraph', { graph, items, replace }).catch(err => {
        this.log.error(`Graphe "${graph.name || graph.id}" dans ${worker.label} : ${err.message}`)
        for (const it of items) this.onRuntime(worker, { ...this.runtimes.get(it.runtimeId), status: 'error', stopReason: err.message, endedAt: Date.now() })
      })
    }
    this._prune()
    return started
  }

  _remoteRuntime (id) {
    const pool = this
    return {
      id,
      remote: true,
      summary: () => pool.runtimes.get(id),
      get active () {
        const s = pool.runtimes.get(id)
        return !!s && ['starting', 'running', 'idle'].includes(s.status)
      }
    }
  }

  onRuntime (worker, summary) {
    const full = { ...summary, process: worker.label }
    this.runtimes.set(summary.id, full)
    this.manager.emit('runtime', full)
  }

  _prune () {
    const done = [...this.runtimes.values()].filter(r => !['starting', 'running', 'idle'].includes(r.status))
    for (const r of done.slice(0, Math.max(0, done.length - 200))) this.runtimes.delete(r.id)
  }

  listRuntimes () {
    return [...this.runtimes.values()]
  }

  async stopRuntime (id, reason) {
    const s = this.runtimes.get(id)
    if (!s) return false
    const worker = this.workers.find(w => w.label === s.process && !w.exited)
    if (!worker) return false
    return worker.request('stopRuntime', { id, reason })
  }

  async stopRuntimes (filter) {
    const counts = await Promise.all(this.live().map(w => w.request('stopRuntimes', { filter }).catch(() => 0)))
    return counts.reduce((a, b) => a + b, 0)
  }

  trigger (name, data, bots) {
    const byWorker = new Map()
    for (const b of bots) {
      if (!byWorker.has(b.worker)) byWorker.set(b.worker, [])
      byWorker.get(b.worker).push(b.id)
    }
    for (const [worker, ids] of byWorker) worker.request('trigger', { name, data, ids }).catch(() => {})
    return bots.length
  }

  /** Relaie l'état et les notifications des outils du serveur aux ouvriers. */
  broadcastServer (event, payload) {
    for (const w of this.live()) w.send({ type: 'server', event, payload })
  }

  /** Un ouvrier demande quelque chose au processus principal (RCON, protocole de gestion). */
  async handleChildRequest (worker, { id, op, args }) {
    try {
      let result
      if (op === 'rcon') result = await this.manager.server.runRcon(args.command)
      else if (op === 'manage') result = await this.manager.server.manage(args.method, args.params)
      else throw new Error(`Opération inconnue : ${op}`)
      worker.send({ type: 'res', id, result })
    } catch (err) {
      worker.send({ type: 'res', id, error: err.message })
    }
  }

  live () {
    return this.workers.filter(w => !w.exited)
  }

  health () {
    return this.live().map(w => w.health && { ...w.health, bots: w.bots.size }).filter(Boolean)
  }

  info () {
    return this.live().map(w => ({ label: w.label, pid: w.pid, bots: w.bots.size, startedAt: w.startedAt }))
  }

  stopIdleWorkers () {
    const now = Date.now()
    for (const w of this.live()) {
      if (!w.bots.size && w.idleSince && now - w.idleSince > IDLE_MS && !w.closing) {
        this.log.info(`Processus ouvrier ${w.label} arrêté (plus aucun bot)`)
        w.stop()
      }
    }
  }

  onWorkerExit (worker, code, signal) {
    this.workers = this.workers.filter(w => w !== worker)
    for (const [id, s] of this.runtimes) {
      if (s.process === worker.label && ['starting', 'running', 'idle'].includes(s.status)) {
        this.runtimes.set(id, { ...s, status: 'error', stopReason: `Processus ${worker.label} arrêté`, endedAt: Date.now() })
      }
    }
    if (this.closing || worker.closing || !worker.bots.size) return
    const bots = [...worker.bots.values()]
    if (Date.now() - worker.startedAt < CRASH_WINDOW_MS) {
      this.log.error(`Processus ${worker.label} arrêté juste après son démarrage (code ${code ?? signal}) : ses ${bots.length} bots restent hors ligne`)
      for (const bot of bots) bot.update({ ...bot.state, status: 'offline', lastError: `Processus ${worker.label} arrêté` })
      this.manager.emit('botChanged')
      return
    }
    // Relance : un nouvel ouvrier reprend les mêmes bots.
    const next = this.spawn()
    this.log.error(`Processus ${worker.label} arrêté (code ${code ?? signal}) : ses ${bots.length} bots repartent dans ${next.label}`)
    bots.forEach((bot, i) => {
      const wanted = bot.wantsOnline || bot.status !== 'offline'
      bot.worker = next
      next.bots.set(bot.id, bot)
      bot.update({ ...bot.state, status: 'offline', lastError: `Processus ${worker.label} arrêté, relancé dans ${next.label}` })
      this._create(next, bot, wanted, i * 1000)
    })
    this.manager.emit('botChanged')
  }

  /** Configuration transmise aux ouvriers : pas d'interface, pas de fichiers partagés. */
  childConfig () {
    const config = JSON.parse(JSON.stringify(this.manager.config))
    config.paths = { ...config.paths, data: null, reports: null }
    config.workers = { enabled: false }
    config.web = { ...config.web, enabled: false }
    config.logs = { ...config.logs, file: null, console: 'none' }
    return config
  }

  shutdown () {
    this.closing = true
    clearInterval(this.idleTimer)
    for (const w of this.live()) w.stop()
  }
}

module.exports = { WorkerPool }
