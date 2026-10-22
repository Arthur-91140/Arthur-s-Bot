'use strict'

const { Vec3 } = require('vec3')
const { entityLabel, isHostile, round } = require('./utils')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const MAX_RADIUS = 32
const MAX_HEIGHT = 24

function clamp (v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))
}

function entityKind (e) {
  if (e.type === 'player') return 'player'
  if (isHostile(e)) return 'hostile'
  if (e.name === 'item' || e.name === 'Item' || e.type === 'object' || e.type === 'projectile' || e.type === 'other') return 'object'
  return 'passive'
}

/**
 * Instantané du monde autour d'un bot pour la vue 3D de l'interface.
 *
 * - pose : position, regard (radians mineflayer), heure du jour
 * - entities : entités proches (joueurs, monstres, animaux, objets)
 * - blocks (facultatif) : boîte de (2r+1) × (2h+1) × (2r+1) blocs, chaque bloc
 *   étant un indice dans `palette`, ordre x puis z puis y, encodé en base64.
 *
 * On lit le type de bloc directement dans les chunks (rapide, toutes versions).
 */
function snapshot (instance, { radius = 20, height = 12, blocks = true } = {}) {
  const bot = instance.requireBot()
  const p = bot.entity.position
  const manager = instance.manager
  const out = {
    t: Date.now(),
    pose: {
      x: round(p.x, 3),
      y: round(p.y, 3),
      z: round(p.z, 3),
      yaw: round(bot.entity.yaw, 4),
      pitch: round(bot.entity.pitch, 4),
      eye: bot.entity.eyeHeight || 1.62,
      dimension: String(bot.game.dimension).replace('minecraft:', ''),
      timeOfDay: bot.time ? bot.time.timeOfDay : 6000,
      isRaining: !!bot.isRaining,
      health: bot.health,
      heldItem: bot.heldItem ? bot.heldItem.name : null
    },
    entities: []
  }

  const r = clamp(radius, 4, MAX_RADIUS)
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue
    if (e.position.distanceTo(p) > r + 8) continue
    out.entities.push({
      id: e.id,
      kind: entityKind(e),
      name: entityLabel(e),
      managed: e.type === 'player' && manager.isManaged(e.username),
      x: round(e.position.x, 2),
      y: round(e.position.y, 2),
      z: round(e.position.z, 2),
      yaw: round(e.yaw || 0, 3),
      height: e.height || (e.type === 'player' ? 1.8 : 0.9),
      width: e.width || 0.6
    })
    if (out.entities.length >= 200) break
  }

  if (blocks) {
    const h = clamp(height, 4, MAX_HEIGHT)
    const origin = { x: Math.floor(p.x) - r, y: Math.floor(p.y) - h, z: Math.floor(p.z) - r }
    const size = { x: 2 * r + 1, y: 2 * h + 1, z: 2 * r + 1 }
    const registry = bot.registry
    const palette = [{ name: 'air', solid: false }]
    const indexById = new Map()
    const data = new Uint16Array(size.x * size.y * size.z)
    const pos = new Vec3(0, 0, 0)
    let i = 0
    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++, i++) {
          pos.set(origin.x + x, origin.y + y, origin.z + z)
          let id = 0
          try {
            id = bot.world.getBlockType(pos)
          } catch (err) {
            id = 0
          }
          if (!id) continue
          let index = indexById.get(id)
          if (index === undefined) {
            const def = registry.blocks[id]
            if (!def || AIR.has(def.name)) {
              index = 0
            } else {
              index = palette.length
              palette.push({ name: def.name, solid: def.boundingBox === 'block' })
            }
            indexById.set(id, index)
          }
          data[i] = index
        }
      }
    }
    const bytes = palette.length <= 256 ? 1 : 2
    const buffer = bytes === 1 ? Buffer.from(Uint8Array.from(data)) : Buffer.from(data.buffer)
    out.blocks = { origin, size, palette, bytes, data: buffer.toString('base64') }
  }
  return out
}

module.exports = { snapshot, MAX_RADIUS, MAX_HEIGHT }
