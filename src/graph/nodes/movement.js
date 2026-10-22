'use strict'

const { Vec3 } = require('vec3')
const { applyMovements, gotoGoal, stopMoving, goals } = require('../../core/navigation')
const { randomBetween } = require('../../core/utils')

const ARRIVED = [{ name: 'arrived', label: 'Arrivé' }, { name: 'failed', label: 'Échec' }]
const CONTROL_OPTIONS = [
  { value: 'forward', label: 'Avancer' }, { value: 'back', label: 'Reculer' },
  { value: 'left', label: 'Gauche' }, { value: 'right', label: 'Droite' },
  { value: 'jump', label: 'Sauter' }, { value: 'sprint', label: 'Sprinter' }, { value: 'sneak', label: 'S\'accroupir' }
]

function playerEntity (api, name) {
  const bot = api.bot
  const p = bot.players[name]
  return p && p.entity ? p.entity : null
}

async function go (api, goal, timeout) {
  api.runtime.usedMovement = true
  applyMovements(api.bot, { canDig: api.param('canDig') === true })
  const res = await gotoGoal(api.bot, goal, { timeout, signal: api.signal })
  if (!res.ok) api.log(`Déplacement échoué : ${res.error}`, 'debug')
  return res.ok ? 'arrived' : 'failed'
}

module.exports = [
  {
    type: 'move.goto',
    category: 'Déplacement',
    label: 'Aller à',
    description: 'Se rend à des coordonnées avec le pathfinder. Laissez Y vide pour ignorer la hauteur.',
    outputs: ARRIVED,
    params: [
      { key: 'x', label: 'X', type: 'number', default: 0 },
      { key: 'y', label: 'Y (vide = ignorer)', type: 'string', default: '' },
      { key: 'z', label: 'Z', type: 'number', default: 0 },
      { key: 'range', label: 'Tolérance', type: 'number', default: 1 },
      { key: 'timeout', label: 'Délai max (ms)', type: 'number', default: 60000 },
      { key: 'canDig', label: 'Peut creuser', type: 'boolean', default: false }
    ],
    run (api) {
      const yRaw = api.param('y')
      const x = api.param('x')
      const z = api.param('z')
      const range = api.param('range')
      const goal = yRaw === '' || yRaw === null || yRaw === undefined
        ? new goals.GoalNearXZ(x, z, range)
        : new goals.GoalNear(x, Number(api.evaluate(yRaw)), z, range)
      return go(api, goal, api.param('timeout'))
    }
  },
  {
    type: 'move.gotoPlayer',
    category: 'Déplacement',
    label: 'Aller vers un joueur',
    description: 'Rejoint la position actuelle d\'un joueur visible.',
    outputs: ARRIVED,
    params: [
      { key: 'player', label: 'Joueur', type: 'string', default: '{{ nearestPlayer() }}' },
      { key: 'range', label: 'Distance', type: 'number', default: 2 },
      { key: 'timeout', label: 'Délai max (ms)', type: 'number', default: 60000 }
    ],
    run (api) {
      const entity = playerEntity(api, api.param('player'))
      if (!entity) return 'failed'
      const p = entity.position
      return go(api, new goals.GoalNear(p.x, p.y, p.z, api.param('range')), api.param('timeout'))
    }
  },
  {
    type: 'move.follow',
    category: 'Déplacement',
    label: 'Suivre un joueur',
    description: 'Commence à suivre un joueur en continu (non bloquant). Utilisez "Arrêter de bouger" pour cesser.',
    outputs: [{ name: 'out', label: 'OK' }, { name: 'notFound', label: 'Introuvable' }],
    params: [
      { key: 'player', label: 'Joueur', type: 'string', default: '{{ nearestPlayer() }}' },
      { key: 'distance', label: 'Distance', type: 'number', default: 2 }
    ],
    run (api) {
      const entity = playerEntity(api, api.param('player'))
      if (!entity) return 'notFound'
      api.runtime.usedMovement = true
      applyMovements(api.bot, {})
      api.bot.pathfinder.setGoal(new goals.GoalFollow(entity, api.param('distance')), true)
      return 'out'
    }
  },
  {
    type: 'move.wander',
    category: 'Déplacement',
    label: 'Marcher au hasard',
    description: 'Va vers un point aléatoire autour de la position actuelle.',
    outputs: ARRIVED,
    params: [
      { key: 'radius', label: 'Rayon', type: 'number', default: 10 },
      { key: 'timeout', label: 'Délai max (ms)', type: 'number', default: 30000 }
    ],
    run (api) {
      const r = api.param('radius')
      const p = api.bot.entity.position
      return go(api, new goals.GoalNearXZ(p.x + randomBetween(-r, r), p.z + randomBetween(-r, r), 1), api.param('timeout'))
    }
  },
  {
    type: 'move.stop',
    category: 'Déplacement',
    label: 'Arrêter de bouger',
    description: 'Stoppe le pathfinder, le combat et relâche toutes les touches.',
    run (api) {
      stopMoving(api.bot)
    }
  },
  {
    type: 'move.control',
    category: 'Déplacement',
    label: 'Appuyer sur une touche',
    description: 'Maintient une touche de déplacement pendant une durée (0 = maintenir jusqu\'à "Relâcher").',
    params: [
      { key: 'control', label: 'Touche', type: 'select', default: 'forward', options: CONTROL_OPTIONS },
      { key: 'duration', label: 'Durée (ms)', type: 'number', default: 1000 }
    ],
    async run (api) {
      const bot = api.bot
      const control = api.param('control')
      const duration = api.param('duration')
      api.runtime.usedMovement = true
      bot.setControlState(control, true)
      if (duration > 0) {
        try {
          await api.sleep(duration)
        } finally {
          bot.setControlState(control, false)
        }
      }
    }
  },
  {
    type: 'move.release',
    category: 'Déplacement',
    label: 'Relâcher les touches',
    description: 'Relâche une touche, ou toutes.',
    params: [{ key: 'control', label: 'Touche', type: 'select', default: 'all', options: [{ value: 'all', label: 'Toutes' }, ...CONTROL_OPTIONS] }],
    run (api) {
      const control = api.param('control')
      if (control === 'all') api.bot.clearControlStates()
      else api.bot.setControlState(control, false)
    }
  },
  {
    type: 'move.jump',
    category: 'Déplacement',
    label: 'Sauter',
    description: 'Fait un saut.',
    async run (api) {
      const bot = api.bot
      bot.setControlState('jump', true)
      try {
        await api.sleep(300)
      } finally {
        bot.setControlState('jump', false)
      }
    }
  },
  {
    type: 'move.look',
    category: 'Déplacement',
    label: 'Regarder (angles)',
    description: 'Oriente la tête. Yaw : 0 = sud, 90 = ouest, 180 = nord, -90 = est (degrés, comme F3). Pitch : -90 = haut, 90 = bas.',
    params: [
      { key: 'yaw', label: 'Yaw (°)', type: 'number', default: 0 },
      { key: 'pitch', label: 'Pitch (°)', type: 'number', default: 0 }
    ],
    async run (api) {
      // mineflayer : yaw 0 = nord et sens anti-horaire ; F3 : yaw 0 = sud et sens horaire.
      const yaw = ((180 - api.param('yaw')) * Math.PI) / 180
      await api.bot.look(yaw, (-api.param('pitch') * Math.PI) / 180, true)
    }
  },
  {
    type: 'move.lookAt',
    category: 'Déplacement',
    label: 'Regarder un point',
    description: 'Regarde des coordonnées.',
    params: [
      { key: 'x', label: 'X', type: 'number', default: 0 },
      { key: 'y', label: 'Y', type: 'number', default: 64 },
      { key: 'z', label: 'Z', type: 'number', default: 0 }
    ],
    async run (api) {
      await api.bot.lookAt(new Vec3(api.param('x'), api.param('y'), api.param('z')), true)
    }
  },
  {
    type: 'move.lookAtPlayer',
    category: 'Déplacement',
    label: 'Regarder un joueur',
    description: 'Tourne la tête vers un joueur visible.',
    outputs: [{ name: 'out', label: 'OK' }, { name: 'notFound', label: 'Introuvable' }],
    params: [{ key: 'player', label: 'Joueur', type: 'string', default: '{{ nearestPlayer() }}' }],
    async run (api) {
      const entity = playerEntity(api, api.param('player'))
      if (!entity) return 'notFound'
      await api.bot.lookAt(entity.position.offset(0, entity.height || 1.62, 0), true)
      return 'out'
    }
  }
]
