'use strict'

const { Vec3 } = require('vec3')
const { randomBetween, randomInt, vecToObj, round } = require('../core/utils')

/** Joueur le plus proche (hors bots gérés si demandé). */
function nearestPlayer (ctx, { ignoreOwnBots = true } = {}) {
  const bot = ctx.bot
  return bot.nearestEntity(e =>
    e.type === 'player' &&
    e.username !== bot.username &&
    !(ignoreOwnBots && ctx.instance.manager.isManaged(e.username)))
}

const idle = {
  name: 'idle',
  label: 'Inactif',
  category: 'Base',
  description: 'Reste connecté sans rien faire (test de connexion, de charge ou de kick AFK).',
  options: [],
  start (ctx) {
    ctx.log.debug('Mode inactif')
  }
}

const antiafk = {
  name: 'antiafk',
  label: 'Anti-AFK',
  category: 'Base',
  description: 'Effectue de petites actions aléatoires (saut, regard, bras, accroupi, pas) pour ne pas être détecté AFK.',
  options: [
    { key: 'interval', label: 'Intervalle (s)', type: 'number', default: 15 },
    { key: 'actions', label: 'Actions', type: 'string', default: 'jump,look,swing,sneak,step', help: 'Parmi : jump, look, swing, sneak, step' }
  ],
  start (ctx) {
    const actions = ctx.options.actions.split(',').map(s => s.trim()).filter(Boolean)
    const bot = ctx.bot
    const tick = async () => {
      const action = actions[randomInt(0, actions.length - 1)]
      switch (action) {
        case 'jump':
          bot.setControlState('jump', true)
          await ctx.sleep(350)
          bot.setControlState('jump', false)
          break
        case 'look':
          await bot.look(Math.random() * Math.PI * 2, randomBetween(-0.6, 0.6), false)
          break
        case 'swing':
          bot.swingArm()
          break
        case 'sneak':
          bot.setControlState('sneak', true)
          await ctx.sleep(600)
          bot.setControlState('sneak', false)
          break
        case 'step':
          bot.setControlState('forward', true)
          await ctx.sleep(300)
          bot.setControlState('forward', false)
          bot.setControlState('back', true)
          await ctx.sleep(300)
          bot.setControlState('back', false)
          break
      }
    }
    ctx.loop(async () => {
      await ctx.sleep(Math.max(1, ctx.options.interval) * 1000 * randomBetween(0.7, 1.3))
      await tick()
    })
  }
}

const wander = {
  name: 'wander',
  label: 'Promeneur',
  category: 'Déplacement',
  description: 'Se promène aléatoirement autour de son point d\'apparition.',
  options: [
    { key: 'radius', label: 'Rayon', type: 'number', default: 16 },
    { key: 'minPause', label: 'Pause min (ms)', type: 'number', default: 1000 },
    { key: 'maxPause', label: 'Pause max (ms)', type: 'number', default: 5000 },
    { key: 'sprint', label: 'Sprinter', type: 'boolean', default: false },
    { key: 'canDig', label: 'Peut casser des blocs', type: 'boolean', default: false },
    { key: 'unstuck', label: 'Si le bot est coincé', type: 'select', default: 'auto', options: [
      { value: 'auto', label: 'Se dégager, puis téléportation par RCON' },
      { value: 'walk', label: 'Se dégager seulement (sauts, pas)' },
      { value: 'none', label: 'Ne rien faire' }
    ] }
  ],
  start (ctx) {
    const { radius, minPause, maxPause, sprint, canDig, unstuck } = ctx.options
    const bot = ctx.bot
    let center = bot.entity.position.clone()
    ctx.movements({ sprint, canDig })
    let failures = 0
    let stuckSince = null
    let stuckAt = null
    ctx.loop(async () => {
      // Après un échec, on vise plus près de la position actuelle : un but trop loin est souvent inatteignable.
      const near = failures > 0
      const origin = near ? bot.entity.position : center
      const r = near ? Math.max(4, radius / 2) : radius
      const x = origin.x + randomBetween(-r, r)
      const z = origin.z + randomBetween(-r, r)
      const reached = await ctx.goto(new ctx.goals.GoalNearXZ(x, z, 1), 30000)
      // atteindre un point au fond du trou ne compte pas : il faut s'être éloigné de l'endroit du blocage
      const escaped = reached && (!stuckAt || bot.entity.position.distanceTo(stuckAt) > 4)
      if (escaped) {
        if (stuckSince) ctx.log.info(`Promeneur : débloqué après ${failures} essai(s) en ${Math.round((Date.now() - stuckSince) / 1000)} s`)
        failures = 0
        stuckSince = null
        stuckAt = null
      } else {
        failures++
        if (failures === 3) {
          stuckSince = Date.now()
          stuckAt = bot.entity.position.clone()
          const p = vecToObj(bot.entity.position, 0)
          ctx.log.warn(`Promeneur : coincé en ${p.x} ${p.y} ${p.z}${unstuck === 'none' ? '' : ', tentative de déblocage'}`)
          ctx.instance._marker('stuck', `${failures} destinations inaccessibles`)
        }
        if (failures >= 3 && unstuck !== 'none') {
          if (failures % 3 === 0) await stepOut(ctx)
          if (unstuck === 'auto' && failures % 9 === 0) {
            const moved = await teleportOut(ctx, center, radius)
            if (moved) center = bot.entity.position.clone()
          }
        }
      }
      await ctx.sleep(randomBetween(minPause, Math.max(minPause, maxPause)) + Math.min(failures, 10) * 300)
    })
  }
}

/** Se dégager à la main : regard au hasard, pas en avant en sautant (sort d'un trou peu profond). */
async function stepOut (ctx) {
  const bot = ctx.bot
  await bot.look(Math.random() * Math.PI * 2, 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  try {
    await ctx.sleep(1200)
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
}

/** Dernier recours : /spreadplayers par RCON place le bot sur une surface sûre de la zone. */
async function teleportOut (ctx, center, radius) {
  const bot = ctx.bot
  try {
    const res = await ctx.instance.manager.server.runRcon(`spreadplayers ${Math.round(center.x)} ${Math.round(center.z)} 0 ${Math.max(8, Math.round(radius))} false ${bot.username}`)
    ctx.log.info(`Promeneur : téléporté par RCON pour le débloquer (${res || 'ok'})`)
    await ctx.sleep(1500)
    return true
  } catch (err) {
    ctx.log.debug(`Promeneur : pas de téléportation (${err.message})`)
    return false
  }
}

const follow = {
  name: 'follow',
  label: 'Suiveur',
  category: 'Déplacement',
  description: 'Suit un joueur (ou le joueur le plus proche si aucun nom n\'est donné).',
  options: [
    { key: 'target', label: 'Joueur', type: 'string', default: '', help: 'Vide = joueur le plus proche' },
    { key: 'distance', label: 'Distance', type: 'number', default: 2 },
    { key: 'ignoreOwnBots', label: 'Ignorer les autres bots', type: 'boolean', default: true },
    { key: 'sprint', label: 'Sprinter', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    ctx.movements({ sprint: ctx.options.sprint })
    ctx.every(1000, async () => {
      const name = ctx.options.target
      const entity = name ? (bot.players[name] && bot.players[name].entity) : nearestPlayer(ctx, ctx.options)
      if (!entity) {
        if (ctx.state.targetId) {
          ctx.log.info('Cible perdue de vue')
          ctx.state.targetId = null
          bot.pathfinder.setGoal(null)
        }
        return
      }
      if (ctx.state.targetId !== entity.id) {
        ctx.state.targetId = entity.id
        ctx.log.info(`Suit ${entity.username}`)
        bot.pathfinder.setGoal(new ctx.goals.GoalFollow(entity, ctx.options.distance), true)
      }
      if (bot.entity.position.distanceTo(entity.position) <= ctx.options.distance + 1) {
        await bot.lookAt(entity.position.offset(0, entity.height || 1.6, 0))
      }
    })
  }
}

const DIRECTIONS = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0)
}
const SPIRAL = ['east', 'south', 'west', 'north']

const explorer = {
  name: 'explorer',
  label: 'Explorateur',
  category: 'Déplacement',
  description: 'Avance loin pour forcer le chargement/la génération de chunks (test de performance, pré-génération).',
  options: [
    { key: 'direction', label: 'Direction', type: 'select', default: 'random', options: ['north', 'south', 'east', 'west', 'random', 'spiral'] },
    { key: 'step', label: 'Longueur d\'étape', type: 'number', default: 48 },
    { key: 'maxDistance', label: 'Distance max (0 = infini)', type: 'number', default: 0 },
    { key: 'sprint', label: 'Sprinter', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const start = bot.entity.position.clone()
    ctx.movements({ sprint: o.sprint, canDig: false })
    let leg = 0
    let failures = 0
    let dirName = o.direction === 'random' ? Object.keys(DIRECTIONS)[randomInt(0, 3)] : o.direction
    ctx.loop(async () => {
      let dir
      let length = o.step
      if (o.direction === 'spiral') {
        dir = DIRECTIONS[SPIRAL[leg % 4]]
        length = o.step * Math.ceil((leg + 1) / 2)
      } else {
        dir = DIRECTIONS[dirName]
      }
      const target = bot.entity.position.plus(dir.scaled(length))
      const ok = await ctx.goto(new ctx.goals.GoalNearXZ(target.x, target.z, 3), Math.max(30000, length * 1500))
      leg++
      const dist = round(bot.entity.position.distanceTo(start), 0)
      if (ok) {
        failures = 0
        let chunks = '?'
        try { chunks = bot.world.getColumns().length } catch (err) { /* ignore */ }
        ctx.log.info(`Exploration : ${dist} blocs parcourus, ${chunks} chunks chargés, TPS ${ctx.instance.tps ?? '?'}`)
      } else {
        failures++
        if (failures >= 3 && o.direction !== 'spiral') {
          dirName = Object.keys(DIRECTIONS)[randomInt(0, 3)]
          ctx.log.info(`Obstacle : nouvelle direction ${dirName}`)
        }
        if (failures >= 12) {
          ctx.log.warn('Explorateur : aucun chemin possible, le bot semble coincé. Arrêt.')
          return false
        }
        await ctx.sleep(1000)
      }
      if (o.maxDistance > 0 && dist >= o.maxDistance) {
        ctx.log.info(`Distance max atteinte (${dist} blocs) en ${vecToObj(bot.entity.position, 0).x}, ${vecToObj(bot.entity.position, 0).z}`)
        return false
      }
    })
  }
}

const joinleave = {
  name: 'joinleave',
  label: 'Connexion / déconnexion',
  category: 'Charge',
  description: 'Se déconnecte et se reconnecte en boucle (test des évènements join/quit, fuites mémoire, anti-bot).',
  options: [
    { key: 'stay', label: 'Durée en ligne (s)', type: 'number', default: 10 },
    { key: 'offline', label: 'Durée hors ligne (s)', type: 'number', default: 5 },
    { key: 'cycles', label: 'Nombre de cycles (0 = infini)', type: 'number', default: 0 }
  ],
  start (ctx) {
    const mem = ctx.memory
    mem.cycles = mem.cycles || 0
    ctx.after(Math.max(1, ctx.options.stay) * 1000, () => {
      mem.cycles++
      if (ctx.options.cycles > 0 && mem.cycles > ctx.options.cycles) {
        ctx.log.info(`Cycles terminés (${ctx.options.cycles})`)
        return
      }
      ctx.log.info(`Cycle ${mem.cycles} : déconnexion pendant ${ctx.options.offline} s`)
      ctx.instance.cycleReconnect(Math.max(0.5, ctx.options.offline) * 1000)
    })
  }
}

module.exports = [idle, antiafk, wander, follow, explorer, joinleave]
module.exports.nearestPlayer = nearestPlayer
