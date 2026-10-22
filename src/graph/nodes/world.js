'use strict'

const { resolveBlockIds } = require('../../core/utils')
const { ENTITY_FILTER, findEntity, entityInfo } = require('./helpers')

const FOUND = [{ name: 'found', label: 'Trouvé' }, { name: 'notFound', label: 'Introuvable' }]

module.exports = [
  {
    type: 'world.findBlock',
    category: 'Monde',
    label: 'Chercher un bloc',
    description: 'Cherche le bloc le plus proche et stocke {x, y, z, name} dans une variable de flux.',
    outputs: FOUND,
    params: [
      { key: 'block', label: 'Bloc (exact, partiel ou *)', type: 'string', default: 'chest' },
      { key: 'maxDistance', label: 'Distance max', type: 'number', default: 32 },
      { key: 'variable', label: 'Variable', type: 'variable', default: 'found' }
    ],
    run (api) {
      const bot = api.bot
      const ids = resolveBlockIds(bot.registry, api.param('block'))
      const block = ids.length ? bot.findBlock({ matching: ids, maxDistance: api.param('maxDistance') }) : null
      const name = api.param('variable') || 'found'
      if (!block) {
        api.locals[name] = null
        return 'notFound'
      }
      api.locals[name] = { x: block.position.x, y: block.position.y, z: block.position.z, name: block.name }
      return 'found'
    }
  },
  {
    type: 'world.findEntity',
    category: 'Monde',
    label: 'Chercher une entité',
    description: 'Cherche l\'entité la plus proche et stocke {name, type, x, y, z, distance} dans une variable de flux.',
    outputs: FOUND,
    params: [
      ENTITY_FILTER,
      { key: 'name', label: 'Nom (si "Nom précis")', type: 'string', default: '' },
      { key: 'maxDistance', label: 'Distance max', type: 'number', default: 32 },
      { key: 'variable', label: 'Variable', type: 'variable', default: 'entity' }
    ],
    run (api) {
      const e = findEntity(api, api.param('filter'), api.param('name'), api.param('maxDistance'))
      const name = api.param('variable') || 'entity'
      api.locals[name] = entityInfo(api.bot, e)
      return e ? 'found' : 'notFound'
    }
  }
]
