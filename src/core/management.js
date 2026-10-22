'use strict'

const { EventEmitter } = require('events')
const WebSocket = require('ws')

const STATUS_POLL_MS = 5000
const MAX_EVENTS = 100

/** Libellés des notifications du serveur, pour le fil d'évènements. */
const NOTIFICATION_LABELS = {
  'server/started': 'Serveur démarré',
  'server/stopping': 'Arrêt du serveur',
  'server/saving': 'Sauvegarde du monde…',
  'server/saved': 'Monde sauvegardé',
  'players/joined': 'Connexion',
  'players/left': 'Déconnexion',
  'operators/added': 'Opérateur ajouté',
  'operators/removed': 'Opérateur retiré',
  'allowlist/added': 'Ajouté à la liste blanche',
  'allowlist/removed': 'Retiré de la liste blanche',
  'bans/added': 'Joueur banni',
  'bans/removed': 'Bannissement levé',
  'ip_bans/added': 'IP bannie',
  'ip_bans/removed': 'Bannissement d\'IP levé',
  'gamerules/updated': 'Règle de jeu modifiée'
}

/**
 * Client du protocole de gestion de serveur de Minecraft (Java 1.21.9+) :
 * JSON-RPC 2.0 sur WebSocket, activé par management-server-enabled=true et
 * authentifié par management-server-secret (en-tête Authorization: Bearer).
 *
 * Donne l'état vu par le serveur (joueurs connectés, version, sauvegardes) et
 * permet d'agir dessus (sauvegarde, message système, expulsion, règles de jeu,
 * réglages). Se reconnecte tout seul.
 */
class ManagementClient extends EventEmitter {
  constructor ({ host = 'localhost', port = 0, secret = '', tls = false, timeout = 8000 } = {}) {
    super()
    this.host = host
    this.port = Number(port) || 0
    this.secret = String(secret || '')
    this.tls = !!tls
    this.timeout = timeout
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.stopped = true
    this.retryDelay = 2000
    this.retryTimer = null
    this.pollTimer = null
    this.state = {
      connected: false,
      error: null,
      started: null,
      version: null,
      players: [],
      saving: false,
      lastSave: null,
      updatedAt: null
    }
    this.events = [] // dernières notifications { t, kind, label, player? }
    this.joins = [] // horodatages des connexions vues par le serveur (dernière minute)
  }

  get url () {
    return `${this.tls ? 'wss' : 'ws'}://${this.host}:${this.port}`
  }

  start () {
    if (!this.port) throw new Error('Port du protocole de gestion non renseigné (management-server-port)')
    this.stopped = false
    this._open()
  }

  stop () {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearInterval(this.pollTimer)
    if (this.ws) {
      try { this.ws.close() } catch (err) { /* ignore */ }
    }
    this.ws = null
    this._setState({ connected: false })
  }

  /** Appelle une méthode (le préfixe « minecraft: » est ajouté si absent). */
  call (method, params = []) {
    const name = method.includes(':') ? method : `minecraft:${method}`
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Protocole de gestion non connecté'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Gestion : délai dépassé pour ${name}`))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer, name })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: name, params }))
    })
  }

  snapshot () {
    const now = Date.now()
    this.joins = this.joins.filter(t => now - t < 60000)
    return { ...this.state, url: this.url, joinsPerMinute: this.joins.length, events: this.events.slice(-30) }
  }

  _open () {
    clearTimeout(this.retryTimer)
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.secret}` },
      handshakeTimeout: this.timeout,
      // certificat auto-signé du serveur de test : on chiffre sans vérifier l'émetteur
      rejectUnauthorized: false
    })
    this.ws = ws
    ws.on('unexpected-response', (req, res) => {
      const reason = res.statusCode === 401 ? 'secret refusé (management-server-secret)' : `réponse HTTP ${res.statusCode}`
      this._setState({ connected: false, error: reason })
      ws.terminate()
    })
    ws.on('open', () => {
      this.retryDelay = 2000
      this._setState({ connected: true, error: null })
      this.emit('notification', { kind: 'connected', label: 'Protocole de gestion connecté' })
      this.refresh()
      clearInterval(this.pollTimer)
      this.pollTimer = setInterval(() => this.refresh(), STATUS_POLL_MS)
    })
    ws.on('message', data => this._onMessage(data))
    ws.on('error', err => {
      const reason = err.code === 'ECONNREFUSED'
        ? `connexion refusée sur ${this.host}:${this.port} (management-server-enabled=true ?)`
        : err.message
      this._setState({ error: reason })
    })
    ws.on('close', () => {
      if (this.ws !== ws) return
      clearInterval(this.pollTimer)
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('Protocole de gestion déconnecté'))
        this.pending.delete(id)
      }
      const was = this.state.connected
      this._setState({ connected: false })
      if (was) this.emit('notification', { kind: 'disconnected', label: 'Protocole de gestion déconnecté' })
      if (!this.stopped) {
        this.retryTimer = setTimeout(() => this._open(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 30000)
      }
    })
  }

  async refresh () {
    try {
      const status = await this.call('server/status')
      const players = status.players || (await this.call('players')) || []
      this._setState({
        started: !!status.started,
        version: status.version || null,
        players: players.map(p => p.name).sort()
      })
    } catch (err) {
      this._setState({ error: err.message })
    }
  }

  _onMessage (data) {
    let msg
    try {
      msg = JSON.parse(data)
    } catch (err) {
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`Gestion (${p.name}) : ${msg.error.message || 'erreur'}${msg.error.data ? ` — ${JSON.stringify(msg.error.data)}` : ''}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) this._onNotification(msg.method.replace(/^minecraft:notification\//, ''), msg.params)
  }

  _onNotification (kind, params) {
    const arg = Array.isArray(params) ? params[0] : params
    const player = arg && arg.name ? arg.name : arg && arg.player && arg.player.name ? arg.player.name : null
    const players = new Set(this.state.players)
    if (kind === 'players/joined' && player) {
      players.add(player)
      this.joins.push(Date.now())
    }
    if (kind === 'players/left' && player) players.delete(player)
    const patch = { players: [...players].sort() }
    if (kind === 'server/saving') patch.saving = true
    if (kind === 'server/saved') Object.assign(patch, { saving: false, lastSave: Date.now() })
    if (kind === 'server/started') patch.started = true
    if (kind === 'server/stopping') patch.started = false
    if (kind === 'server/status' && arg) {
      patch.started = !!arg.started
      if (arg.version) patch.version = arg.version
      if (arg.players) patch.players = arg.players.map(p => p.name).sort()
    }
    this._setState(patch)
    if (kind === 'server/status' || kind === 'server/activity') return
    const label = NOTIFICATION_LABELS[kind] || kind
    const event = { t: Date.now(), kind, label, player, data: arg && !player ? arg : undefined }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.shift()
    this.emit('notification', event)
  }

  _setState (patch) {
    Object.assign(this.state, patch, { updatedAt: Date.now() })
    this.emit('state', this.snapshot())
  }
}

module.exports = { ManagementClient, NOTIFICATION_LABELS }
