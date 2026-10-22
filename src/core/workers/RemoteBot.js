'use strict'

/**
 * Représentant, dans le processus principal, d'un bot hébergé par un processus
 * ouvrier. Son état est une copie envoyée régulièrement par l'ouvrier ; les
 * actions lui sont transmises par IPC. Il expose la même interface que
 * BotInstance pour l'API, la console, les actions groupées et les campagnes.
 */
class RemoteBot {
  constructor (pool, worker, options) {
    this.remote = true
    this.pool = pool
    this.worker = worker
    this.options = options
    this.id = options.username
    this.createdAt = Date.now()
    this.state = {
      id: this.id,
      username: this.id,
      status: 'offline',
      host: options.host,
      port: options.port,
      version: options.version,
      auth: options.auth,
      mode: { name: options.mode, options: options.modeOptions || {} },
      modeLabel: options.mode,
      plugins: options.plugins,
      stats: { connections: 0, spawns: 0, deaths: 0, kicks: 0, errors: 0, messages: 0, setbacks: 0, reconnects: 0, lastLoginMs: null },
      runtimes: [],
      position: null,
      dimension: null
    }
    this.lastState = 0
  }

  get status () {
    return this.state.status
  }

  get mode () {
    return this.state.mode
  }

  get plugins () {
    return this.state.plugins
  }

  /** Le bot doit-il être connecté (pour le relancer après un redémarrage) ? */
  get wantsOnline () {
    return !!this.state.wantsOnline
  }

  get lastKick () {
    return this.state.lastKick
  }

  get lastError () {
    return this.state.lastError
  }

  get spawnedAt () {
    return this.state.status === 'online' ? Date.now() - (this.state.uptime || 0) : null
  }

  update (state) {
    this.state = state
    this.lastState = Date.now()
  }

  getState () {
    return { ...this.state, process: this.worker.label }
  }

  trailPosition () {
    const s = this.state
    if (s.status !== 'online' || !s.position) return null
    return { x: s.position.x, z: s.position.z, dimension: s.dimension || 'overworld' }
  }

  runAction (action, payload) {
    return this.worker.request('action', { id: this.id, action, payload })
  }

  /** Appelle une méthode de lecture de l'instance dans l'ouvrier (inventaire, chat, vue 3D…). */
  call (method, args = []) {
    return this.worker.request('call', { id: this.id, method, args })
  }

  getChat (limit = 150) {
    return this.call('getChat', [limit])
  }

  getInventory () {
    return this.call('getInventory')
  }

  getWindow () {
    return this.call('getWindow')
  }

  disconnect (reason) {
    return this.runAction('disconnect', { reason }).catch(() => {})
  }

  connect () {
    return this.runAction('connect', {}).catch(() => {})
  }

  setMode (mode, options) {
    return this.runAction('mode', { mode, options })
  }
}

module.exports = { RemoteBot }
