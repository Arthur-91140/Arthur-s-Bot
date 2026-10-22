'use strict'

const { sleep, waitForEvent, isAbortError, errorMessage } = require('./utils')
const { applyMovements, gotoGoal, stopMoving, goals } = require('./navigation')

/**
 * Contexte d'exécution d'un mode prédéfini. Tout ce qui est créé via ce contexte
 * (timers, écouteurs, boucles, déplacements) est nettoyé automatiquement à l'arrêt
 * du mode ou à la déconnexion du bot.
 */
class ModeContext {
  constructor (instance, def, options) {
    this.instance = instance
    this.bot = instance.bot
    this.def = def
    this.options = options
    this.log = instance.log
    this.memory = instance.modeMemory
    this.state = {}
    this.goals = goals
    this._abort = new AbortController()
    this._timers = new Set()
    this._listeners = []
  }

  get signal () {
    return this._abort.signal
  }

  get active () {
    return !this._abort.signal.aborted && this.instance.bot === this.bot
  }

  /** Écoute un évènement (du bot par défaut) jusqu'à l'arrêt du mode. */
  on (emitterOrEvent, eventOrFn, maybeFn) {
    const emitter = typeof emitterOrEvent === 'string' ? this.bot : emitterOrEvent
    const event = typeof emitterOrEvent === 'string' ? emitterOrEvent : eventOrFn
    const fn = typeof emitterOrEvent === 'string' ? eventOrFn : maybeFn
    const wrapped = (...args) => {
      if (!this.active) return
      try {
        const r = fn(...args)
        if (r && typeof r.catch === 'function') r.catch(err => this._onError(err))
      } catch (err) {
        this._onError(err)
      }
    }
    emitter.on(event, wrapped)
    this._listeners.push([emitter, event, wrapped])
  }

  /** Exécute fn toutes les `ms` millisecondes, sans chevauchement si fn est asynchrone. */
  every (ms, fn) {
    let busy = false
    const timer = setInterval(async () => {
      if (!this.active || busy) return
      busy = true
      try {
        await fn()
      } catch (err) {
        this._onError(err)
      } finally {
        busy = false
      }
    }, Math.max(50, ms))
    this._timers.add(timer)
    return timer
  }

  after (ms, fn) {
    const timer = setTimeout(async () => {
      this._timers.delete(timer)
      if (!this.active) return
      try {
        await fn()
      } catch (err) {
        this._onError(err)
      }
    }, ms)
    this._timers.add(timer)
    return timer
  }

  /**
   * Boucle asynchrone tant que le mode est actif. Si fn renvoie `false`, la boucle
   * s'arrête. En cas d'erreur, on journalise et on attend `errorDelay`.
   */
  loop (fn, { delay = 0, errorDelay = 3000 } = {}) {
    const run = async () => {
      while (this.active) {
        try {
          const result = await fn()
          if (result === false) return
          if (delay) await this.sleep(delay)
        } catch (err) {
          if (isAbortError(err) || !this.active) return
          this._onError(err)
          try {
            await this.sleep(errorDelay)
          } catch (e) {
            return
          }
        }
      }
    }
    run()
  }

  sleep (ms) {
    return sleep(ms, this.signal)
  }

  waitFor (event, { emitter, filter, timeout } = {}) {
    return waitForEvent(emitter || this.bot, event, { filter, timeout, signal: this.signal })
  }

  movements (opts) {
    return applyMovements(this.bot, opts)
  }

  /** Déplacement interruptible ; renvoie true si l'objectif est atteint. */
  async goto (goal, timeout = 60000) {
    const res = await gotoGoal(this.bot, goal, { timeout, signal: this.signal })
    if (!res.ok) this.log.debug(`Déplacement échoué : ${res.error}`)
    return res.ok
  }

  createReport (name) {
    return this.instance.manager.reports.create({
      kind: 'mode',
      name,
      botId: this.instance.id,
      source: `mode:${this.def.name}`
    })
  }

  _onError (err) {
    if (isAbortError(err) || !this.active) return
    this.log.warn(`[${this.def.name}] ${errorMessage(err)}`)
  }

  dispose () {
    if (this._abort.signal.aborted) return
    this._abort.abort()
    for (const t of this._timers) {
      clearInterval(t)
      clearTimeout(t)
    }
    this._timers.clear()
    for (const [emitter, event, fn] of this._listeners) emitter.removeListener(event, fn)
    this._listeners = []
    if (this.instance.bot === this.bot) stopMoving(this.bot)
  }
}

module.exports = { ModeContext }
