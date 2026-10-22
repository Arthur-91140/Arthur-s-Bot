'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { TrailStore } = require('../src/core/TrailStore')
const { createTestManager } = require('./helpers')

const MIN = 60000

test('traces : points, distance et immobilité', () => {
  const store = new TrailStore()
  const first = store.record('A', 0, 0, 'overworld', 1000)
  assert.deepStrictEqual(first, { id: 'A', dim: 'overworld', points: [[0, 0, 1000]], dist: 0, reset: true })
  assert.strictEqual(store.record('A', 0.1, 0.1, 'overworld', 2000), null, 'un bot immobile n\'ajoute pas de point')
  const next = store.record('A', 3, 4, 'overworld', 3000)
  assert.deepStrictEqual(next.points, [[3, 4, 3000]])
  assert.strictEqual(next.dist, 5)
})

test('traces : coupure sur téléportation, déconnexion et changement de dimension', () => {
  const store = new TrailStore()
  store.record('A', 0, 0, 'overworld', 1000)
  const tp = store.record('A', 100, 0, 'overworld', 2000)
  assert.deepStrictEqual(tp.points, [null, [100, 0, 2000]])
  assert.strictEqual(tp.dist, 0, 'une téléportation ne compte pas comme distance parcourue')

  store.pause('A')
  const back = store.record('A', 105, 0, 'overworld', 3000)
  assert.deepStrictEqual(back.points, [null, [105, 0, 3000]], 'reconnexion : nouveau tronçon')
  assert.deepStrictEqual(store.record('A', 107, 0, 'overworld', 4000).points, [[107, 0, 4000]])

  const nether = store.record('A', 13, 0, 'the_nether', 5000)
  assert.strictEqual(nether.reset, true)
  assert.deepStrictEqual(store.snapshot().A, { dim: 'the_nether', dist: 0, points: [[13, 0, 5000]] })
})

test('traces : durée conservée et fenêtre demandée', () => {
  const store = new TrailStore({ keepMinutes: 10 })
  const now = Date.now()
  store.record('A', 0, 0, 'overworld', now - 15 * MIN)
  store.record('A', 200, 0, 'overworld', now - 12 * MIN) // téléportation : coupure
  store.record('A', 202, 0, 'overworld', now - 4 * MIN)
  store.record('A', 204, 0, 'overworld', now - 1 * MIN)
  assert.strictEqual(store.snapshot({ minutes: 2 }).A.points.length, 1)
  store.prune(now)
  // les points de plus de 10 min et la coupure de tête disparaissent
  assert.deepStrictEqual(store.snapshot().A.points.map(p => p[0]), [202, 204])
})

test('traces : enregistrées sur disque et rechargées', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-bot-trails-'))
  const file = path.join(dir, 'data', 'trails.json')
  const store = new TrailStore({ file })
  const now = Date.now()
  store.record('A', 0, 0, 'overworld', now - 2000)
  store.record('A', 6, 8, 'overworld', now - 1000)
  assert.strictEqual(store.save(), true)
  assert.strictEqual(store.save(), false, 'rien à réécrire')

  const reloaded = new TrailStore({ file })
  assert.deepStrictEqual(reloaded.snapshot().A, { dim: 'overworld', dist: 10, points: [[0, 0, now - 2000], [6, 8, now - 1000]] })
  // après un redémarrage, le premier point ouvre un nouveau tronçon
  assert.deepStrictEqual(reloaded.record('A', 7, 8, 'overworld', now).points, [null, [7, 8, now]])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('traces : le gestionnaire relève les bots en jeu', () => {
  const { manager, dir } = createTestManager()
  manager.bots.set('A', { id: 'A', status: 'online', trailPosition: () => ({ x: 1, z: 2, dimension: 'overworld' }) })
  manager.bots.set('B', { id: 'B', status: 'offline', trailPosition: () => null })
  const seen = []
  manager.on('trails', c => seen.push(...c))
  manager.sampleTrails(1000)
  assert.deepStrictEqual(seen.map(c => c.id), ['A'])
  assert.deepStrictEqual(manager.trails.snapshot().A.points, [[1, 2, 1000]])
  const cleared = []
  manager.on('trailsCleared', ids => cleared.push(ids))
  manager.clearTrails()
  assert.deepStrictEqual(manager.trails.snapshot(), {})
  assert.deepStrictEqual(cleared, [null])
  manager.bots.clear()
  manager.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repères : ajout, filtrage, effacement par bot et enregistrement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-bot-markers-'))
  const file = path.join(dir, 'trails.json')
  const store = new TrailStore({ file, keepMinutes: 10 })
  const now = Date.now()
  assert.strictEqual(store.addMarker({ kind: 'inconnu', id: 'A', x: 0, z: 0 }), null)
  store.addMarker({ kind: 'death', id: 'A', x: 1.234, z: 2, dimension: 'overworld', t: now })
  store.addMarker({ kind: 'stuck', id: 'B', x: 5, z: 5, t: now })
  store.addMarker({ kind: 'kick', id: 'A', x: 9, z: 9, t: now - 20 * MIN })
  assert.deepStrictEqual(store.markersSince(5).map(m => m.kind), ['death', 'stuck'])
  assert.strictEqual(store.markers[0].x, 1.2)
  store.prune(now)
  assert.strictEqual(store.markers.length, 2, 'les repères trop anciens disparaissent')
  store.save()
  assert.strictEqual(new TrailStore({ file, keepMinutes: 10 }).markers.length, 2)
  store.clear(['A'])
  assert.deepStrictEqual(store.markers.map(m => m.id), ['B'])
  fs.rmSync(dir, { recursive: true, force: true })
})
