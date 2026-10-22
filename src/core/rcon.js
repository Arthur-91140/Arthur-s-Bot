'use strict'

const net = require('net')

const AUTH = 3
const EXEC = 2
const RESPONSE = 0
const END_MARKER_TYPE = 100 // type inconnu : le serveur répond « Unknown request », ce qui marque la fin d'une réponse

/**
 * Client RCON (protocole Source, utilisé par Minecraft). Une seule connexion,
 * commandes envoyées l'une après l'autre ; les réponses longues découpées en
 * plusieurs paquets sont réassemblées grâce à un paquet marqueur.
 */
class RconClient {
  constructor ({ host = 'localhost', port = 25575, password = '', timeout = 5000 } = {}) {
    this.host = host
    this.port = Number(port) || 25575
    this.password = String(password || '')
    this.timeout = timeout
    this.socket = null
    this.ready = null
    this.nextId = 1
    this.buffer = Buffer.alloc(0)
    this.waiting = new Map() // id → { resolve, reject, parts, marker }
    this.queue = Promise.resolve()
  }

  get connected () {
    return !!this.socket && !this.socket.destroyed
  }

  connect () {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      const fail = err => {
        this._close(err)
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error(`RCON : pas de réponse de ${this.host}:${this.port}`)), this.timeout)
      socket.once('error', err => {
        clearTimeout(timer)
        fail(new Error(`RCON : ${err.code === 'ECONNREFUSED' ? `connexion refusée sur ${this.host}:${this.port} (enable-rcon=true ?)` : err.message}`))
      })
      socket.on('data', chunk => this._onData(chunk))
      socket.on('close', () => this._close(new Error('RCON : connexion fermée')))
      socket.once('connect', () => {
        const id = this._id()
        this.waiting.set(id, {
          auth: true,
          resolve: () => {
            clearTimeout(timer)
            socket.removeAllListeners('error')
            socket.on('error', err => this._close(err))
            resolve()
          },
          reject: err => {
            clearTimeout(timer)
            fail(err)
          }
        })
        this._send(id, AUTH, this.password)
      })
    })
    this.ready.catch(() => { this.ready = null })
    return this.ready
  }

  /** Exécute une commande (sans « / ») et renvoie la réponse du serveur. */
  command (cmd) {
    const run = async () => {
      await this.connect()
      const text = String(cmd).trim().replace(/^\//, '')
      if (!text) throw new Error('Commande vide')
      const id = this._id()
      const marker = this._id()
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id)
          this.waiting.delete(marker)
          reject(new Error(`RCON : délai dépassé pour « ${text} »`))
        }, this.timeout)
        const entry = {
          parts: [],
          resolve: value => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: err => {
            clearTimeout(timer)
            reject(err)
          }
        }
        this.waiting.set(id, entry)
        this.waiting.set(marker, { marker: true, of: id })
      })
      this._send(id, EXEC, text)
      this._send(marker, END_MARKER_TYPE, '')
      return promise
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  close () {
    this._close(new Error('RCON : connexion fermée'))
  }

  _id () {
    this.nextId = (this.nextId % 0x7ffffff0) + 1
    return this.nextId
  }

  _send (id, type, body) {
    const payload = Buffer.from(body, 'utf8')
    const packet = Buffer.alloc(14 + payload.length)
    packet.writeInt32LE(10 + payload.length, 0)
    packet.writeInt32LE(id, 4)
    packet.writeInt32LE(type, 8)
    payload.copy(packet, 12)
    this.socket.write(packet)
  }

  _onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0)
      if (this.buffer.length < 4 + length) return
      const id = this.buffer.readInt32LE(4)
      const type = this.buffer.readInt32LE(8)
      const body = this.buffer.toString('utf8', 12, 4 + length - 2)
      this.buffer = this.buffer.subarray(4 + length)
      this._onPacket(id, type, body)
    }
  }

  _onPacket (id, type, body) {
    if (id === -1) {
      // mot de passe refusé
      for (const [key, entry] of this.waiting) {
        if (entry.auth) {
          this.waiting.delete(key)
          entry.reject(new Error('RCON : mot de passe refusé (rcon.password)'))
        }
      }
      return
    }
    const entry = this.waiting.get(id)
    if (!entry) return
    if (entry.auth) {
      if (type === EXEC) {
        this.waiting.delete(id)
        entry.resolve()
      }
      return
    }
    if (entry.marker) {
      // tous les morceaux de la réponse sont arrivés
      this.waiting.delete(id)
      const owner = this.waiting.get(entry.of)
      if (owner) {
        this.waiting.delete(entry.of)
        owner.resolve(owner.parts.join(''))
      }
      return
    }
    if (type === RESPONSE) entry.parts.push(body)
  }

  _close (err) {
    const socket = this.socket
    this.socket = null
    this.ready = null
    this.buffer = Buffer.alloc(0)
    if (socket && !socket.destroyed) socket.destroy()
    for (const [id, entry] of this.waiting) {
      this.waiting.delete(id)
      if (entry.reject) entry.reject(err)
    }
  }
}

module.exports = { RconClient }
