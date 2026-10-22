'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, none: 100 }
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', chat: '\x1b[32m' }
const RESET = '\x1b[0m'

/**
 * Journal central : garde les dernières lignes en mémoire (pour l'interface web),
 * les écrit dans un fichier et les affiche dans la console selon le niveau choisi.
 */
class Logger extends EventEmitter {
  constructor ({ maxLines = 3000, console: consoleLevel = 'info', file = null } = {}) {
    super()
    this.setMaxListeners(50)
    this.maxLines = maxLines
    this.consoleLevel = consoleLevel
    this.lines = []
    this.seq = 0
    this.printer = line => process.stdout.write(line + '\n')
    this.stream = null
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        this.stream = fs.createWriteStream(file, { flags: 'a' })
        this.stream.on('error', () => { this.stream = null })
      } catch (err) {
        this.stream = null
      }
    }
  }

  /** Permet au REPL d'afficher les logs sans casser la ligne de saisie. */
  setPrinter (fn) {
    this.printer = fn
  }

  log (level, source, message) {
    const entry = { id: ++this.seq, t: Date.now(), level, source, message: String(message) }
    this.lines.push(entry)
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
    const time = new Date(entry.t).toLocaleTimeString('fr-FR')
    if (this.stream) this.stream.write(`${new Date(entry.t).toISOString()} [${level}] [${source}] ${entry.message}\n`)
    const threshold = LEVELS[this.consoleLevel] ?? LEVELS.info
    const value = level === 'chat' ? LEVELS.info : (LEVELS[level] ?? LEVELS.info)
    if (value >= threshold) {
      this.printer(`${COLORS[level] || ''}${time} [${source}]${RESET} ${entry.message}`)
    }
    this.emit('line', entry)
    return entry
  }

  child (source) {
    return {
      debug: msg => this.log('debug', source, msg),
      info: msg => this.log('info', source, msg),
      warn: msg => this.log('warn', source, msg),
      error: msg => this.log('error', source, msg),
      chat: msg => this.log('chat', source, msg)
    }
  }

  getLines ({ source, level, limit = 500, since = 0 } = {}) {
    const min = level ? (LEVELS[level] ?? 0) : 0
    const out = this.lines.filter(l =>
      l.id > since &&
      (!source || l.source === source) &&
      (l.level === 'chat' ? min <= LEVELS.info : (LEVELS[l.level] ?? 0) >= min))
    return out.slice(-limit)
  }

  close () {
    if (this.stream) this.stream.end()
  }
}

module.exports = { Logger, LEVELS }
