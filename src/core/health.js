'use strict'

const os = require('os')
const { monitorEventLoopDelay } = require('perf_hooks')

// Au-delà, le programme lui-même ralentit les bots : ping, TPS estimé et temps de
// réponse mesurés ne reflètent plus seulement le serveur.
const LIMITS = {
  loopWarn: 100, // ms (99e centile du retard de la boucle d'évènements)
  loopBad: 250,
  cpuWarn: 85, // % d'un cœur : Node.js exécute le JavaScript sur un seul fil
  cpuBad: 97
}

/**
 * Mesure la santé d'un processus Node.js : temps CPU, mémoire et retard de la
 * boucle d'évènements (le meilleur signe de saturation pour des bots mineflayer).
 */
class HealthProbe {
  constructor () {
    this.histogram = monitorEventLoopDelay({ resolution: 10 })
    this.histogram.enable()
    this.lastCpu = process.cpuUsage()
    this.lastTime = process.hrtime.bigint()
  }

  sample (extra = {}) {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - this.lastTime) / 1e6
    const cpu = process.cpuUsage(this.lastCpu)
    this.lastCpu = process.cpuUsage()
    this.lastTime = now
    const mem = process.memoryUsage()
    const h = this.histogram
    const ms = v => Math.round((v / 1e6) * 10) / 10
    const sample = {
      t: Date.now(),
      pid: process.pid,
      cpu: elapsedMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10 : 0,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      loopMean: Number.isFinite(h.mean) ? ms(h.mean) : 0,
      loopP99: ms(h.percentile(99)),
      loopMax: ms(h.max),
      ...extra
    }
    h.reset()
    sample.level = level(sample)
    return sample
  }

  stop () {
    this.histogram.disable()
  }
}

function level (s) {
  if (s.loopP99 >= LIMITS.loopBad || s.cpu >= LIMITS.cpuBad) return 'bad'
  if (s.loopP99 >= LIMITS.loopWarn || s.cpu >= LIMITS.cpuWarn) return 'warn'
  return 'ok'
}

/** Résumé de plusieurs processus (principal + ouvriers) pour l'interface. */
function summarize (processes) {
  const list = processes.filter(Boolean)
  const worst = list.reduce((w, p) => (p.level === 'bad' || (p.level === 'warn' && w !== 'bad') ? p.level : w), 'ok')
  return {
    t: Date.now(),
    cores: os.cpus().length,
    totalMemory: os.totalmem(),
    level: worst,
    rss: list.reduce((n, p) => n + p.rss, 0),
    cpu: Math.round(list.reduce((n, p) => n + p.cpu, 0) * 10) / 10,
    loopP99: list.reduce((m, p) => Math.max(m, p.loopP99), 0),
    processes: list,
    limits: LIMITS
  }
}

module.exports = { HealthProbe, summarize, LIMITS, level }
