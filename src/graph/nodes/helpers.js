'use strict'

const { Vec3 } = require('vec3')
const { isHostile, entityLabel, round } = require('../../core/utils')

const ENTITY_FILTER = {
  key: 'filter',
  label: 'Entité',
  type: 'select',
  default: 'hostile',
  options: [
    { value: 'hostile', label: 'Monstre le plus proche' },
    { value: 'player', label: 'Joueur le plus proche' },
    { value: 'any', label: 'Entité vivante la plus proche' },
    { value: 'named', label: 'Nom précis (joueur ou type)' }
  ]
}

function isLiving (e) {
  return e.type === 'player' || e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' ||
    e.type === 'passive' || e.type === 'water_creature' || e.type === 'ambient' || isHostile(e)
}

/** Cherche l'entité la plus proche correspondant au filtre. */
function findEntity (api, filter, name, range = 32) {
  const bot = api.bot
  const own = bot.entity.position
  return bot.nearestEntity(e => {
    if (e === bot.entity || !e.position || e.position.distanceTo(own) > range) return false
    switch (filter) {
      case 'player': return e.type === 'player' && !api.manager.isManaged(e.username)
      case 'hostile': return isHostile(e)
      case 'named': return e.username === name || e.name === name || e.displayName === name
      default: return isLiving(e)
    }
  })
}

function entityInfo (bot, e) {
  if (!e) return null
  return {
    id: e.id,
    name: entityLabel(e),
    type: e.type,
    x: round(e.position.x),
    y: round(e.position.y),
    z: round(e.position.z),
    distance: bot && bot.entity ? round(e.position.distanceTo(bot.entity.position)) : null
  }
}

const FACES = [
  new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)
]

/** Trouve un bloc plein voisin de `target` sur lequel s'appuyer pour poser un bloc. */
function findPlacementReference (bot, target) {
  for (const f of FACES) {
    const ref = bot.blockAt(target.plus(f))
    if (ref && ref.boundingBox === 'block') return { ref, face: f.scaled(-1) }
  }
  return null
}

function vecFromParams (api) {
  return new Vec3(Math.floor(api.param('x')), Math.floor(api.param('y')), Math.floor(api.param('z')))
}

const XYZ = [
  { key: 'x', label: 'X', type: 'number', default: 0 },
  { key: 'y', label: 'Y', type: 'number', default: 64 },
  { key: 'z', label: 'Z', type: 'number', default: 0 }
]

module.exports = { ENTITY_FILTER, findEntity, entityInfo, findPlacementReference, vecFromParams, XYZ, isLiving }
