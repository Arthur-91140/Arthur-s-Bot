'use strict'

const fs = require('fs')
const path = require('path')

const JUMP = 32 // au-delà de 32 blocs d'un coup, c'est une téléportation : on coupe la trace
const MIN_STEP = 0.35 // en dessous, le bot n'a pas vraiment bougé
const MAX_MARKERS = 5000
const MARKER_KINDS = new Set(['death', 'stuck', 'kick'])

const round1 = n => Math.round(n * 10) / 10

/**
 * Traces des déplacements (vue de dessus), gardées côté serveur : elles survivent
 * aux rechargements de page, sont communes à toutes les fenêtres ouvertes et sont
 * enregistrées sur disque pour survivre à un redémarrage.
 *
 * Une trace = { dim, dist, points } ; un point = [x, z, t] et null marque une
 * coupure (téléportation, déconnexion).
 *
 * Les repères (morts, blocages, expulsions) alimentent la carte de chaleur.
 */
class TrailStore {
  constructor ({ keepMinutes = 60, file = null } = {}) {
    this.keepMs = Math.max(1, Number(keepMinutes) || 60) * 60000
    // un point par seconde au plus : de quoi couvrir toute la durée conservée
    this.maxPoints = Math.ceil(this.keepMs / 1000) + 60
    this.file = file
    this.trails = new Map()
    this.markers = [] // { t, kind, id, x, z, dim, detail }
    this.dirty = false
    if (file) this.load()
  }

  get keepMinutes () {
    return this.keepMs / 60000
  }

  /**
   * Ajoute la position d'un bot. Renvoie le changement à diffuser aux navigateurs
   * ({ id, dim, points, dist, reset? }) ou null si le bot n'a pas bougé.
   */
  record (id, x, z, dim, t = Date.now()) {
    const p = [round1(x), round1(z), t]
    let trail = this.trails.get(id)
    if (!trail || trail.dim !== dim) {
      trail = { dim, dist: 0, points: [p], live: true }
      this.trails.set(id, trail)
      this.dirty = true
      return { id, dim, points: [p], dist: 0, reset: true }
    }
    const wasLive = trail.live
    trail.live = true
    const points = trail.points
    const last = points[points.length - 1]
    const out = []
    if (last) {
      const d = Math.hypot(p[0] - last[0], p[1] - last[1])
      if (d < MIN_STEP) return null
      if (!wasLive || d > JUMP) out.push(null)
      else trail.dist += d
    }
    out.push(p)
    points.push(...out)
    this.dirty = true
    return { id, dim, points: out, dist: round1(trail.dist) }
  }

  /** Le bot n'est plus en jeu : son prochain point ouvrira un nouveau tronçon. */
  pause (id) {
    const trail = this.trails.get(id)
    if (trail) trail.live = false
  }

  remove (id) {
    if (this.trails.delete(id)) this.dirty = true
  }

  clear (ids = null) {
    if (!ids) {
      this.trails.clear()
      this.markers = []
    } else {
      for (const id of ids) this.trails.delete(id)
      const set = new Set(ids)
      this.markers = this.markers.filter(m => !set.has(m.id))
    }
    this.dirty = true
  }

  /** Ajoute un repère (mort, blocage, expulsion) ; renvoie le repère enregistré. */
  addMarker ({ kind, id, x, z, dimension, dim, detail = null, t = Date.now() } = {}) {
    if (!MARKER_KINDS.has(kind) || !Number.isFinite(x) || !Number.isFinite(z)) return null
    const m = { t, kind, id: String(id || ''), x: round1(x), z: round1(z), dim: dimension || dim || 'overworld', detail: detail ? String(detail).slice(0, 200) : null }
    this.markers.push(m)
    if (this.markers.length > MAX_MARKERS) this.markers.splice(0, this.markers.length - MAX_MARKERS)
    this.dirty = true
    return m
  }

  markersSince (minutes = null) {
    const since = minutes ? Date.now() - Number(minutes) * 60000 : 0
    return this.markers.filter(m => m.t >= since)
  }

  /** Oublie les points trop anciens et les traces vides. */
  prune (now = Date.now()) {
    const since = now - this.keepMs
    for (const [id, trail] of this.trails) {
      const pts = trail.points
      let cut = 0
      while (cut < pts.length && (pts[cut] === null || pts[cut][2] < since || pts.length - cut > this.maxPoints)) cut++
      if (cut) {
        pts.splice(0, cut)
        this.dirty = true
      }
      if (!pts.length && !trail.live) this.trails.delete(id)
    }
    const before = this.markers.length
    this.markers = this.markers.filter(m => m.t >= since)
    if (this.markers.length !== before) this.dirty = true
  }

  /** Traces des `minutes` dernières minutes, par bot. */
  snapshot ({ minutes = null, ids = null } = {}) {
    const since = minutes ? Date.now() - Number(minutes) * 60000 : 0
    const out = {}
    for (const [id, trail] of this.trails) {
      if (ids && !ids.includes(id)) continue
      let start = 0
      while (start < trail.points.length && (trail.points[start] === null || trail.points[start][2] < since)) start++
      out[id] = { dim: trail.dim, dist: round1(trail.dist), points: trail.points.slice(start) }
    }
    return out
  }

  load () {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [id, t] of Object.entries(data.trails || {})) {
        if (!t || !Array.isArray(t.points)) continue
        this.trails.set(id, { dim: t.dim, dist: Number(t.dist) || 0, points: t.points, live: false })
      }
      if (Array.isArray(data.markers)) this.markers = data.markers.filter(m => m && MARKER_KINDS.has(m.kind))
      this.prune()
      this.dirty = false
    } catch (err) {
      if (err.code !== 'ENOENT') this.trails.clear()
    }
  }

  /** Écrit les traces sur disque si elles ont changé (écriture atomique). */
  save () {
    if (!this.file || !this.dirty) return false
    const data = { savedAt: Date.now(), keepMinutes: this.keepMinutes, trails: this.snapshot(), markers: this.markers }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, this.file)
    this.dirty = false
    return true
  }
}

module.exports = { TrailStore, JUMP }
