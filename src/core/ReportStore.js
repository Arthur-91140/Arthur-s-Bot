'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const MAX_REPORTS = 200
const MAX_ITEMS = 2000

let seq = 0

/** Rapport de test : assertions, métriques, journal libre et statut final. */
class Report {
  constructor (store, { kind = 'graph', name = 'Rapport', botId = null, source = null, graphId = null, runtimeId = null }) {
    this.store = store
    this.id = `r${Date.now().toString(36)}${(++seq).toString(36)}`
    this.kind = kind
    this.name = name
    this.botId = botId
    this.source = source
    this.graphId = graphId
    this.runtimeId = runtimeId
    this.startedAt = Date.now()
    this.endedAt = null
    this.status = 'running'
    this.message = ''
    this.assertions = []
    this.metrics = []
    this.entries = []
    this.errors = []
  }

  _push (list, item) {
    if (list.length >= MAX_ITEMS) list.shift()
    list.push({ t: Date.now(), ...item })
    this.store.touch(this)
  }

  assert (ok, message, nodeId = null) {
    this._push(this.assertions, { ok: !!ok, message: String(message), nodeId })
    return !!ok
  }

  metric (name, value, nodeId = null) {
    this._push(this.metrics, { name: String(name), value, nodeId })
  }

  entry (message, nodeId = null) {
    this._push(this.entries, { message: String(message), nodeId })
  }

  error (message, nodeId = null) {
    this._push(this.errors, { message: String(message), nodeId })
  }

  get done () {
    return this.status !== 'running'
  }

  /** Termine le rapport. Sans statut explicite, il est déduit des assertions et erreurs. */
  finish (status, message = '') {
    if (this.done) return this
    const failed = this.assertions.some(a => !a.ok) || this.errors.length > 0
    if (!status || status === 'auto') status = failed ? 'failed' : 'passed'
    else if (status === 'stopped' && (this.assertions.length || this.errors.length)) status = failed ? 'failed' : 'passed'
    this.status = status
    this.message = message
    this.endedAt = Date.now()
    this.store.touch(this, true)
    this.store.persist(this)
    return this
  }

  summary () {
    const passed = this.assertions.filter(a => a.ok).length
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      botId: this.botId,
      source: this.source,
      graphId: this.graphId,
      status: this.status,
      message: this.message,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      duration: (this.endedAt || Date.now()) - this.startedAt,
      passed,
      failed: this.assertions.length - passed,
      errors: this.errors.length,
      metrics: this.metrics.length
    }
  }

  toJSON () {
    return {
      ...this.summary(),
      assertions: this.assertions,
      metrics: this.metrics,
      entries: this.entries,
      errors: this.errors
    }
  }
}

class ReportStore extends EventEmitter {
  constructor ({ dir = null } = {}) {
    super()
    this.dir = dir
    this.reports = new Map()
    this._dirty = new Set()
    this._timer = null
  }

  create (opts) {
    const report = new Report(this, opts)
    this.reports.set(report.id, report)
    if (this.reports.size > MAX_REPORTS) {
      const oldest = [...this.reports.values()].find(r => r.done)
      if (oldest) this.reports.delete(oldest.id)
    }
    this.touch(report, true)
    return report
  }

  get (id) {
    return this.reports.get(id) || null
  }

  list () {
    return [...this.reports.values()].map(r => r.summary()).reverse()
  }

  remove (id) {
    return this.reports.delete(id)
  }

  clear () {
    for (const [id, r] of this.reports) if (r.done) this.reports.delete(id)
    this.emit('cleared')
  }

  /** Signale une modification ; les notifications sont regroupées toutes les 300 ms. */
  touch (report, immediate = false) {
    this._dirty.add(report.id)
    if (immediate) return this._flush()
    if (!this._timer) this._timer = setTimeout(() => this._flush(), 300)
  }

  _flush () {
    clearTimeout(this._timer)
    this._timer = null
    for (const id of this._dirty) {
      const r = this.reports.get(id)
      if (r) this.emit('update', r.summary())
    }
    this._dirty.clear()
  }

  persist (report) {
    if (!this.dir) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const safe = report.name.replace(/[^\w.-]+/g, '_').slice(0, 60)
      fs.writeFileSync(path.join(this.dir, `${report.id}-${safe}.json`), JSON.stringify(report.toJSON(), null, 2))
    } catch (err) {
      // la persistance est facultative
    }
  }
}

module.exports = { ReportStore, Report }
