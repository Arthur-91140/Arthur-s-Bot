'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { RconClient } = require('./rcon')
const { ManagementClient } = require('./management')

/**
 * Outils d'administration du serveur testé : RCON (commandes de préparation) et
 * protocole de gestion 1.21.9+ (état vu par le serveur, notifications, réglages).
 * Les réglages sont modifiables depuis l'interface et enregistrés dans data/.
 */
class ServerTools extends EventEmitter {
  constructor ({ config, logger, file = null }) {
    super()
    this.setMaxListeners(100)
    this.log = logger.child('serveur')
    this.file = file
    const base = config.server || {}
    this.settings = {
      rcon: { enabled: false, host: base.host || 'localhost', port: 25575, password: '', ...(config.rcon || {}) },
      management: { enabled: false, host: base.host || 'localhost', port: 0, secret: '', tls: false, ...(config.management || {}) }
    }
    this._load()
    this.rcon = null
    this.management = null
    this.managementState = null
    this._apply()
  }

  /** Réglages sans les secrets (pour l'interface). */
  publicSettings () {
    const { rcon, management } = this.settings
    return {
      rcon: { enabled: rcon.enabled, host: rcon.host, port: rcon.port, hasPassword: !!rcon.password },
      management: { enabled: management.enabled, host: management.host, port: management.port, tls: management.tls, hasSecret: !!management.secret }
    }
  }

  state () {
    return {
      settings: this.publicSettings(),
      rcon: { enabled: this.settings.rcon.enabled, connected: !!(this.rcon && this.rcon.connected) },
      management: this.settings.management.enabled
        ? this.management ? this.management.snapshot() : { connected: false }
        : null
    }
  }

  /** Met à jour les réglages ; un secret vide conserve le précédent. */
  update ({ rcon, management } = {}) {
    const keep = (cur, next, key) => (next[key] === undefined || next[key] === '' ? cur[key] : String(next[key]))
    if (rcon) {
      const cur = this.settings.rcon
      this.settings.rcon = {
        enabled: rcon.enabled !== undefined ? !!rcon.enabled : cur.enabled,
        host: String(rcon.host || cur.host),
        port: Number(rcon.port) || cur.port,
        password: rcon.clearPassword ? '' : keep(cur, rcon, 'password')
      }
    }
    if (management) {
      const cur = this.settings.management
      this.settings.management = {
        enabled: management.enabled !== undefined ? !!management.enabled : cur.enabled,
        host: String(management.host || cur.host),
        port: Number(management.port) || cur.port,
        secret: management.clearSecret ? '' : keep(cur, management, 'secret'),
        tls: management.tls !== undefined ? !!management.tls : cur.tls
      }
    }
    this._save()
    this._apply()
    return this.state()
  }

  async runRcon (command) {
    if (!this.settings.rcon.enabled || !this.rcon) throw new Error('RCON désactivé : renseignez-le dans les outils du serveur')
    const response = await this.rcon.command(command)
    this.log.debug(`RCON ${command} → ${response}`)
    return response
  }

  async manage (method, params = []) {
    if (!this.settings.management.enabled || !this.management) {
      throw new Error('Protocole de gestion désactivé : renseignez-le dans les outils du serveur (Minecraft 1.21.9+)')
    }
    return this.management.call(method, params)
  }

  /** Joueurs connectés vus par le serveur, ou null si le protocole de gestion est indisponible. */
  serverPlayers () {
    const s = this.managementState
    return s && s.connected ? s.players : null
  }

  close () {
    if (this.rcon) this.rcon.close()
    if (this.management) this.management.stop()
  }

  _apply () {
    const { rcon, management } = this.settings
    if (this.rcon) this.rcon.close()
    this.rcon = rcon.enabled ? new RconClient(rcon) : null

    if (this.management) {
      this.management.removeAllListeners()
      this.management.stop()
    }
    this.management = null
    this.managementState = null
    if (management.enabled && management.port) {
      const client = new ManagementClient(management)
      client.on('state', s => {
        this.managementState = s
        this.emit('state', this.state())
      })
      client.on('notification', n => {
        if (n.kind === 'connected') this.log.info(`Protocole de gestion connecté (${client.url})`)
        else if (n.kind === 'disconnected') this.log.warn('Protocole de gestion déconnecté')
        this.emit('notification', n)
      })
      this.management = client
      try {
        client.start()
      } catch (err) {
        this.log.warn(err.message)
      }
    }
    this.emit('state', this.state())
  }

  _load () {
    if (!this.file) return
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (saved.rcon) Object.assign(this.settings.rcon, saved.rcon)
      if (saved.management) Object.assign(this.settings.management, saved.management)
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Réglages du serveur illisibles : ${err.message}`)
    }
  }

  _save () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
    } catch (err) {
      this.log.warn(`Enregistrement des réglages du serveur impossible : ${err.message}`)
    }
  }
}

module.exports = { ServerTools }
