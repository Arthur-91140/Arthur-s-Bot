'use strict'

const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const pvpPlugin = require('mineflayer-pvp').plugin
const collectBlockPlugin = require('mineflayer-collectblock').plugin
const armorManager = require('mineflayer-armor-manager')
const modes = require('../modes')
const { ModeContext } = require('./ModeContext')
const { attachPlugins, equipBestArmor } = require('./plugins')
const { applyMovements, gotoGoal, stopMoving, goals } = require('./navigation')
const u = require('./utils')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

/** mineflayer-pvp écoute l'ancien évènement 'physicTick' : on le redirige pour éviter l'avertissement. */
function loadPvp (bot) {
  const on = bot.on
  bot.on = function (event, fn) {
    return on.call(this, event === 'physicTick' ? 'physicsTick' : event, fn)
  }
  try {
    pvpPlugin(bot)
  } finally {
    bot.on = on
  }
}
const CHAT_HISTORY = 300

/** Les 9 cases de la barre rapide (affichage façon HUD dans l'interface). */
function hotbarOf (bot) {
  const start = bot.inventory.hotbarStart ?? 36
  return Array.from({ length: 9 }, (_, i) => {
    const it = bot.inventory.slots[start + i]
    return it ? { name: it.name, count: it.count } : null
  })
}

/** Yaw mineflayer (radians) -> yaw affiché par F3 (degrés, 0 = sud). */
function notchianYaw (yaw) {
  let deg = ((Math.PI - yaw) * 180) / Math.PI
  deg = ((deg + 180) % 360 + 360) % 360 - 180
  return Math.round(deg)
}

/** Ajoute une piste de résolution aux erreurs de connexion fréquentes. */
function explain (text) {
  const t = String(text)
  if (/ECONNREFUSED/.test(t)) return `${t} — serveur injoignable : vérifiez l'adresse, le port et que le serveur est démarré.`
  if (/ENOTFOUND|EAI_AGAIN/.test(t)) return `${t} — nom d'hôte introuvable.`
  if (/ETIMEDOUT|timed out/i.test(t)) return `${t} — délai dépassé (pare-feu, mauvais port ou serveur surchargé).`
  if (/unsupported protocol|not supported|Unsupported/i.test(t)) return `${t} — version non supportée : choisissez une version explicite ou utilisez ViaVersion côté serveur.`
  if (/Failed to verify username|verify username|Invalid session/i.test(t)) return `${t} — le serveur est en online-mode : utilisez l'auth Microsoft ou passez online-mode=false.`
  if (/throttl|too fast|trop rapidement/i.test(t)) return `${t} — anti-flood de connexion : augmentez le délai entre les bots (joinDelay).`
  return t
}

/**
 * Un bot piloté par Arthur's Bot : encapsule un bot mineflayer, gère la
 * reconnexion, le mode actif, les plugins utilitaires et expose un état
 * sérialisable pour l'interface web et l'API.
 */
class BotInstance extends EventEmitter {
  constructor (manager, options) {
    super()
    this.manager = manager
    this.options = options
    this.id = options.username
    this.log = manager.logger.child(this.id)
    this.status = 'offline'
    this.bot = null
    this.mode = { name: options.mode || 'idle', options: options.modeOptions || {} }
    this.modeMemory = {}
    this.activeMode = null
    this.plugins = JSON.parse(JSON.stringify(options.plugins || {}))
    this.events = new EventEmitter()
    this.events.setMaxListeners(500)
    this.runtimes = new Set()
    this.chatHistory = []
    this.stats = { connections: 0, spawns: 0, deaths: 0, kicks: 0, errors: 0, messages: 0, setbacks: 0, reconnects: 0, lastLoginMs: null }
    this.lastKick = null
    this.lastError = null
    this.msaCode = null
    this.createdAt = Date.now()
    this.spawnedAt = null
    this.manualStop = true
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this._pendingCycle = null
    this.tpsSamples = []
    this.tps = null
  }

  // --- Connexion -----------------------------------------------------------

  connect () {
    if (this.bot) return false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.manualStop = false
    this.status = 'connecting'
    this.lastError = null
    this._connectStart = Date.now()
    const o = this.options
    this.log.info(`Connexion à ${o.host}:${o.port} (version ${o.version || 'auto'}, auth ${o.auth})…`)
    let bot
    try {
      bot = mineflayer.createBot({
        host: o.host,
        port: o.port,
        username: o.username,
        auth: o.auth,
        password: o.password || undefined,
        version: o.version && o.version !== 'auto' ? o.version : false,
        hideErrors: true,
        logErrors: false,
        respawn: false,
        checkTimeoutInterval: o.checkTimeoutInterval,
        viewDistance: o.viewDistance,
        profilesFolder: o.profilesFolder,
        onMsaCode: data => {
          this.msaCode = { uri: data.verification_uri, code: data.user_code }
          this.log.warn(`Authentification Microsoft : ouvrez ${data.verification_uri} et saisissez le code ${data.user_code}`)
          this.emitState()
        }
      })
    } catch (err) {
      this.lastError = explain(u.errorMessage(err))
      this.log.error(`Création du bot impossible : ${this.lastError}`)
      this.status = 'offline'
      this._scheduleReconnect()
      this.emitState()
      return false
    }
    this.bot = bot
    this.stats.connections++
    bot.loadPlugin(pathfinder)
    bot.loadPlugin(loadPvp)
    bot.loadPlugin(collectBlockPlugin)
    if (this.plugins.autoArmor) bot.loadPlugin(armorManager)
    this._attach(bot)
    attachPlugins(this, bot)
    this.emitState()
    return true
  }

  /** Déconnexion volontaire : pas de reconnexion automatique. */
  disconnect (reason = 'Déconnexion demandée') {
    this.manualStop = true
    this._pendingCycle = null
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const bot = this.bot
    if (!bot) {
      this.status = 'offline'
      this.emitState()
      return
    }
    try {
      bot.quit(reason)
    } catch (err) {
      try { bot.end(reason) } catch (e) { /* ignore */ }
    }
    // Filet de sécurité si 'end' n'arrive jamais (connexion bloquée).
    setTimeout(() => { if (this.bot === bot) this._onEnd(bot, reason) }, 5000)
  }

  /** Quitte puis revient après `offlineMs` (tests de join/quit). */
  cycleReconnect (offlineMs = 3000) {
    if (!this.bot) return this.connect()
    this._pendingCycle = Math.max(500, offlineMs)
    try { this.bot.quit('Cycle de reconnexion') } catch (err) { /* ignore */ }
  }

  reconnect () {
    if (this.bot) this.cycleReconnect(1500)
    else this.connect()
  }

  _scheduleReconnect () {
    const o = this.options
    if (!o.autoReconnect || this.manualStop) return
    if (o.maxReconnectAttempts > 0 && this.reconnectAttempts >= o.maxReconnectAttempts) {
      this.log.warn('Nombre maximum de reconnexions atteint, abandon.')
      return
    }
    this.reconnectAttempts++
    const delay = Math.min(o.reconnectDelay * Math.min(this.reconnectAttempts, 6), 120000)
    this.status = 'reconnecting'
    this.stats.reconnects++
    this.log.info(`Reconnexion dans ${Math.round(delay / 1000)} s (tentative ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.manualStop) this.connect()
    }, delay)
  }

  _attach (bot) {
    const current = () => this.bot === bot
    const ev = this.events

    bot.once('login', () => {
      if (!current()) return
      this.status = 'spawning'
      this.msaCode = null
      this.stats.lastLoginMs = Date.now() - this._connectStart
      this.log.info(`Connecté (version ${bot.version}) en ${this.stats.lastLoginMs} ms`)
      this.emitState()
    })

    bot.on('spawn', () => {
      if (!current()) return
      const first = this.status !== 'online'
      this.status = 'online'
      this.stats.spawns++
      if (first) {
        this.spawnedAt = Date.now()
        this.reconnectAttempts = 0
        const p = u.vecToObj(bot.entity.position, 1)
        this.log.info(`Apparu en ${p.x} ${p.y} ${p.z} (${bot.game.gameMode}, ${String(bot.game.dimension).replace('minecraft:', '')})`)
        this._startMode()
      }
      ev.emit('spawn', { first })
      this.emitState()
    })

    bot.on('messagestr', (message, position) => {
      if (!current()) return
      if (position === 'game_info') {
        ev.emit('actionbar', { message })
        return
      }
      this.stats.messages++
      this._pushChat({ type: position === 'chat' ? 'chat' : 'system', message })
      ev.emit('message', { message, position })
    })

    bot.on('chat', (username, message) => {
      if (current() && username !== bot.username) ev.emit('chat', { username, message })
    })

    bot.on('whisper', (username, message) => {
      if (current() && username !== bot.username) ev.emit('whisper', { username, message })
    })

    bot.on('title', (text, type) => {
      if (current()) ev.emit('title', { text: u.chatToText(text), type })
    })

    bot.on('death', () => {
      if (!current()) return
      this.stats.deaths++
      this.log.warn('Le bot est mort')
      ev.emit('death', {})
    })

    bot.on('health', () => {
      if (current()) ev.emit('health', { health: bot.health, food: bot.food })
    })

    bot.on('entityHurt', entity => {
      if (current() && entity === bot.entity) ev.emit('hurt', { health: bot.health })
    })

    bot.on('playerJoined', player => {
      if (!current() || player.username === bot.username) return
      // La liste initiale des joueurs arrive au login : on l'ignore.
      if (!this.spawnedAt || Date.now() - this.spawnedAt < 2000) return
      ev.emit('playerJoined', { player: player.username })
    })

    bot.on('playerLeft', player => {
      if (current() && player.username !== bot.username) ev.emit('playerLeft', { player: player.username })
    })

    bot.on('windowOpen', window => {
      if (!current()) return
      const title = u.chatToText(window.title)
      this.log.info(`Fenêtre ouverte : "${title}" (${window.type}, ${window.inventoryStart} cases)`)
      ev.emit('windowOpen', { title, type: window.type, size: window.inventoryStart })
    })

    bot.on('windowClose', () => {
      if (current()) ev.emit('windowClose', {})
    })

    bot.on('forcedMove', () => {
      if (!current() || !bot.entity) return
      this.stats.setbacks++
      ev.emit('forcedMove', u.vecToObj(bot.entity.position))
    })

    bot.on('time', () => {
      if (current()) this._sampleTps(bot)
    })

    bot.on('kicked', (reason, loggedIn) => {
      if (!current()) return
      const text = u.chatToText(reason)
      this.stats.kicks++
      this.lastKick = { t: Date.now(), reason: text }
      this.log.warn(`Expulsé${loggedIn ? '' : ' pendant la connexion'} : ${explain(text)}`)
      ev.emit('kicked', { reason: text, loggedIn })
    })

    bot.on('error', err => {
      if (!current()) return
      this.stats.errors++
      this.lastError = explain(u.errorMessage(err))
      this.log.error(`Erreur : ${this.lastError}`)
      // Pas 'error' : un EventEmitter sans écouteur 'error' ferait planter le processus.
      ev.emit('botError', { message: this.lastError })
    })

    bot.on('end', reason => this._onEnd(bot, reason))
  }

  _onEnd (bot, reason) {
    if (this.bot !== bot) return
    this._stopMode()
    stopMoving(bot)
    this.bot = null
    this.spawnedAt = null
    this.tpsSamples = []
    this.tps = null
    const text = u.chatToText(reason) || 'fin de connexion'
    this.log.info(`Déconnecté (${text})`)
    this.events.emit('end', { reason: text })
    this.status = 'offline'
    if (this._pendingCycle && !this.manualStop) {
      const delay = this._pendingCycle
      this._pendingCycle = null
      this.status = 'reconnecting'
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.manualStop) this.connect()
      }, delay)
    } else if (!this.manualStop) {
      this._scheduleReconnect()
    }
    this.emitState()
  }

  _sampleTps (bot) {
    const now = Date.now()
    const age = Number(bot.time && bot.time.age)
    if (!Number.isFinite(age)) return
    this.tpsSamples.push([now, age])
    while (this.tpsSamples.length > 3 && now - this.tpsSamples[0][0] > 15000) this.tpsSamples.shift()
    const [t0, a0] = this.tpsSamples[0]
    const dt = (now - t0) / 1000
    if (dt >= 3) this.tps = Math.max(0, Math.min(20, u.round((age - a0) / dt, 1)))
  }

  _pushChat (entry) {
    const full = { t: Date.now(), ...entry }
    this.chatHistory.push(full)
    if (this.chatHistory.length > CHAT_HISTORY) this.chatHistory.splice(0, this.chatHistory.length - CHAT_HISTORY)
    this.manager.emit('chat', { botId: this.id, ...full })
  }

  // --- Modes ---------------------------------------------------------------

  setMode (name, options = {}) {
    const def = modes.get(name)
    if (!def) throw new Error(`Mode inconnu : ${name}`)
    this._stopMode()
    this.mode = { name: def.name, options: modes.normalizeOptions(def, options) }
    this.modeMemory = {}
    this.log.info(`Mode : ${def.label}`)
    if (this.status === 'online') this._startMode()
    this.emitState()
    return this.mode
  }

  _startMode () {
    if (!this.bot || this.activeMode) return
    const def = modes.get(this.mode.name) || modes.get('idle')
    const ctx = new ModeContext(this, def, modes.normalizeOptions(def, this.mode.options))
    this.activeMode = ctx
    Promise.resolve()
      .then(() => def.start(ctx))
      .catch(err => {
        if (!u.isAbortError(err)) this.log.error(`Mode ${def.name} : ${u.errorMessage(err)}`)
      })
  }

  _stopMode () {
    const ctx = this.activeMode
    if (!ctx) return
    this.activeMode = null
    try {
      if (ctx.def.stop) ctx.def.stop(ctx)
    } catch (err) {
      this.log.warn(`Arrêt du mode ${ctx.def.name} : ${u.errorMessage(err)}`)
    }
    ctx.dispose()
  }

  // --- Actions manuelles (interface / API / REPL) --------------------------

  requireBot () {
    if (!this.bot || this.status !== 'online' || !this.bot.entity) throw new Error(`${this.id} n'est pas en jeu`)
    return this.bot
  }

  say (message) {
    const bot = this.requireBot()
    const text = String(message)
    bot.chat(text)
    this._pushChat({ type: 'self', message: text })
  }

  control (action, state = true, duration = 0) {
    const bot = this.requireBot()
    if (!CONTROLS.includes(action)) throw new Error(`Contrôle inconnu : ${action}`)
    bot.setControlState(action, !!state)
    if (state && duration > 0) setTimeout(() => { if (this.bot === bot) bot.setControlState(action, false) }, duration)
  }

  async goto (x, y, z, range = 1) {
    const bot = this.requireBot()
    applyMovements(bot, {})
    const goal = y === null || y === undefined || y === ''
      ? new goals.GoalNearXZ(Number(x), Number(z), range)
      : new goals.GoalNear(Number(x), Number(y), Number(z), range)
    return gotoGoal(bot, goal, { timeout: 180000 })
  }

  async gotoPlayer (name, range = 2) {
    const bot = this.requireBot()
    const player = bot.players[name]
    if (!player || !player.entity) throw new Error(`Joueur ${name} hors de vue`)
    applyMovements(bot, {})
    const p = player.entity.position
    return gotoGoal(bot, new goals.GoalNear(p.x, p.y, p.z, range), { timeout: 120000 })
  }

  stopMovement () {
    stopMoving(this.requireBot())
  }

  async look (yawDeg, pitchDeg) {
    const bot = this.requireBot()
    // Angles au format F3 (yaw 0 = sud) convertis vers la convention de mineflayer.
    await bot.look(((180 - Number(yawDeg)) * Math.PI) / 180, (-Number(pitchDeg) * Math.PI) / 180, true)
  }

  attackNearest (kind = 'hostile') {
    const bot = this.requireBot()
    const target = bot.nearestEntity(e => {
      if (e === bot.entity || !e.position) return false
      if (e.position.distanceTo(bot.entity.position) > 32) return false
      if (kind === 'player') return e.type === 'player'
      if (kind === 'hostile') return u.isHostile(e)
      return e.type === 'player' || e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' || u.isHostile(e)
    })
    if (!target) return null
    bot.pvp.attack(target)
    return u.entityLabel(target)
  }

  async dropAll () {
    const bot = this.requireBot()
    let count = 0
    for (const item of bot.inventory.items()) {
      await bot.tossStack(item)
      count++
    }
    return count
  }

  respawn () {
    this.requireBot().respawn()
  }

  async useItem () {
    const bot = this.requireBot()
    bot.activateItem()
    await u.sleep(250)
    bot.deactivateItem()
  }

  swing () {
    this.requireBot().swingArm()
  }

  async equip (name, destination = 'hand') {
    const bot = this.requireBot()
    const item = u.findItem(bot, name)
    if (!item) throw new Error(`Objet absent de l'inventaire : ${name}`)
    await bot.equip(item, destination)
    return item.name
  }

  setHotbar (slot) {
    this.requireBot().setQuickBarSlot(Math.max(0, Math.min(8, Number(slot) || 0)))
  }

  equipArmor () {
    const bot = this.requireBot()
    if (!bot.armorManager) bot.loadPlugin(armorManager)
    equipBestArmor(bot)
  }

  getInventory () {
    const bot = this.requireBot()
    return {
      quickBarSlot: bot.quickBarSlot,
      held: bot.heldItem ? bot.heldItem.name : null,
      slots: bot.inventory.slots.map((item, slot) => item && {
        slot,
        name: item.name,
        displayName: item.displayName,
        count: item.count
      }).filter(Boolean)
    }
  }

  getWindow () {
    const bot = this.requireBot()
    const w = bot.currentWindow
    if (!w) return null
    return {
      id: w.id,
      type: w.type,
      title: u.chatToText(w.title),
      size: w.inventoryStart,
      slots: w.slots.slice(0, w.inventoryStart).map((item, slot) => item && {
        slot,
        name: item.name,
        displayName: item.customName ? u.chatToText(item.customName) : item.displayName,
        count: item.count
      }).filter(Boolean)
    }
  }

  async clickSlot (slot, button = 0, mode = 0) {
    const bot = this.requireBot()
    await bot.clickWindow(Number(slot), Number(button), Number(mode))
  }

  closeWindow () {
    const bot = this.requireBot()
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  }

  setPlugins (patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'authme' && typeof value === 'object') this.plugins.authme = { ...(this.plugins.authme || {}), ...value }
      else this.plugins[key] = value
    }
    if (patch.autoArmor && this.bot && this.status === 'online') this.equipArmor()
    this.emitState()
    return this.plugins
  }

  // --- État ----------------------------------------------------------------

  emitState () {
    this.manager.emit('botChanged', this.id)
  }

  getState () {
    const bot = this.bot
    const online = this.status === 'online' && bot && bot.entity
    const def = modes.get(this.mode.name)
    return {
      id: this.id,
      username: this.options.username,
      status: this.status,
      host: this.options.host,
      port: this.options.port,
      version: bot && bot.version ? bot.version : this.options.version,
      auth: this.options.auth,
      health: online ? u.round(bot.health, 1) : null,
      food: online ? bot.food : null,
      position: online ? u.vecToObj(bot.entity.position, 1) : null,
      yaw: online ? notchianYaw(bot.entity.yaw) : null,
      pitch: online ? Math.round((-bot.entity.pitch * 180) / Math.PI) : null,
      dimension: online && bot.game ? String(bot.game.dimension).replace('minecraft:', '') : null,
      gameMode: online && bot.game ? bot.game.gameMode : null,
      ping: online && bot.player ? bot.player.ping : null,
      level: online && bot.experience ? bot.experience.level : null,
      xp: online && bot.experience ? { level: bot.experience.level, progress: u.round(bot.experience.progress || 0, 3) } : null,
      quickBarSlot: online ? bot.quickBarSlot : null,
      hotbar: online ? hotbarOf(bot) : null,
      players: online ? Object.keys(bot.players).length : null,
      tps: this.tps,
      heldItem: online && bot.heldItem ? bot.heldItem.name : null,
      window: online && bot.currentWindow ? u.chatToText(bot.currentWindow.title) : null,
      moving: online && bot.pathfinder ? bot.pathfinder.isMoving() : false,
      mode: this.mode,
      modeLabel: def ? def.label : this.mode.name,
      plugins: this.plugins,
      stats: this.stats,
      uptime: this.spawnedAt ? Date.now() - this.spawnedAt : 0,
      lastKick: this.lastKick,
      lastError: this.lastError,
      msaCode: this.msaCode,
      runtimes: [...this.runtimes].map(r => ({ id: r.id, graphId: r.graph.id, name: r.graph.name, status: r.status }))
    }
  }
}

module.exports = { BotInstance, CONTROLS }
