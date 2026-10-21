'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { snapshot } = require('../src/core/view')

// Monde factice : sol de pierre en y = 63, un bloc de terre en (2, 64, 0), de l'air ailleurs.
const registry = {
  blocks: {
    0: { name: 'air', boundingBox: 'empty' },
    1: { name: 'stone', boundingBox: 'block' },
    10: { name: 'dirt', boundingBox: 'block' },
    20: { name: 'short_grass', boundingBox: 'empty' }
  }
}

function fakeInstance () {
  const self = { position: new Vec3(0.5, 64, 0.5), yaw: Math.PI, pitch: 0, eyeHeight: 1.62 }
  const bot = {
    entity: self,
    registry,
    game: { dimension: 'minecraft:overworld' },
    time: { timeOfDay: 1000 },
    isRaining: false,
    health: 18,
    heldItem: { name: 'diamond_sword' },
    entities: {
      1: self,
      2: { id: 2, type: 'player', username: 'Bot_2', position: new Vec3(3, 64, 3), yaw: 0, height: 1.8, width: 0.6 },
      3: { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(-4, 64, 1), yaw: 1, height: 1.95, width: 0.6 },
      4: { id: 4, type: 'player', username: 'Loin', position: new Vec3(500, 64, 0) }
    },
    world: {
      getBlockType (pos) {
        if (pos.y === 63) return 1
        if (pos.x === 2 && pos.y === 64 && pos.z === 0) return 10
        if (pos.x === -1 && pos.y === 64 && pos.z === 0) return 20
        return 0
      }
    }
  }
  return { requireBot: () => bot, manager: { isManaged: name => name === 'Bot_2' } }
}

test('instantané : position, regard et entités proches', () => {
  const view = snapshot(fakeInstance(), { radius: 4, height: 4, blocks: false })
  assert.strictEqual(view.pose.dimension, 'overworld')
  assert.strictEqual(view.pose.heldItem, 'diamond_sword')
  assert.strictEqual(view.blocks, undefined)
  const byName = Object.fromEntries(view.entities.map(e => [e.name, e]))
  assert.deepStrictEqual(Object.keys(byName).sort(), ['Bot_2', 'zombie'])
  assert.strictEqual(byName.Bot_2.kind, 'player')
  assert.strictEqual(byName.Bot_2.managed, true)
  assert.strictEqual(byName.zombie.kind, 'hostile')
})

test('instantané : boîte de blocs encodée avec sa palette', () => {
  const view = snapshot(fakeInstance(), { radius: 4, height: 4 })
  const { origin, size, palette, bytes, data } = view.blocks
  assert.deepStrictEqual(origin, { x: -4, y: 60, z: -4 })
  assert.deepStrictEqual(size, { x: 9, y: 9, z: 9 })
  assert.strictEqual(bytes, 1)
  assert.strictEqual(palette[0].name, 'air')
  assert.deepStrictEqual(palette.map(p => p.name).sort(), ['air', 'dirt', 'short_grass', 'stone'])
  assert.strictEqual(palette.find(p => p.name === 'short_grass').solid, false)
  const cells = Buffer.from(data, 'base64')
  assert.strictEqual(cells.length, 9 * 9 * 9)
  const at = (x, y, z) => palette[cells[((y - origin.y) * size.z + (z - origin.z)) * size.x + (x - origin.x)]].name
  assert.strictEqual(at(0, 63, 0), 'stone')
  assert.strictEqual(at(4, 63, -4), 'stone')
  assert.strictEqual(at(2, 64, 0), 'dirt')
  assert.strictEqual(at(-1, 64, 0), 'short_grass')
  assert.strictEqual(at(0, 64, 0), 'air')
})

test('instantané : rayon et hauteur bornés', () => {
  const view = snapshot(fakeInstance(), { radius: 999, height: -3 })
  assert.deepStrictEqual(view.blocks.size, { x: 65, y: 9, z: 65 })
})
