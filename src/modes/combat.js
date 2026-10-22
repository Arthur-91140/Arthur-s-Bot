'use strict'

const { isHostile, entityLabel, parseList } = require('../core/utils')

function setupPvp (ctx, attackRange) {
  const pvp = ctx.bot.pvp
  if (attackRange) pvp.attackRange = attackRange
  ctx.state.hits = 0
  ctx.on('attackedTarget', () => { ctx.state.hits++ })
}

const guard = {
  name: 'guard',
  label: 'Garde',
  category: 'Combat',
  description: 'Garde sa position et attaque les monstres (et éventuellement les joueurs) qui s\'approchent.',
  options: [
    { key: 'radius', label: 'Rayon de garde', type: 'number', default: 12 },
    { key: 'attackPlayers', label: 'Attaquer les joueurs', type: 'boolean', default: false },
    { key: 'whitelist', label: 'Joueurs épargnés', type: 'string', default: '', help: 'Liste séparée par des virgules' },
    { key: 'returnToPost', label: 'Revenir au poste', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const post = bot.entity.position.clone()
    const whitelist = new Set(parseList(o.whitelist))
    ctx.movements({})
    setupPvp(ctx)
    ctx.on('stoppedAttacking', () => {
      if (o.returnToPost) bot.pathfinder.setGoal(new ctx.goals.GoalNear(post.x, post.y, post.z, 1))
    })
    ctx.every(400, () => {
      const target = bot.pvp.target
      if (target) {
        if (!target.isValid || target.position.distanceTo(post) > o.radius * 1.5) bot.pvp.stop()
        return
      }
      const enemy = bot.nearestEntity(e => {
        if (!e.position || e.position.distanceTo(post) > o.radius) return false
        if (e.type === 'player') {
          return o.attackPlayers && e.username !== bot.username && !whitelist.has(e.username) &&
            !ctx.instance.manager.isManaged(e.username)
        }
        return isHostile(e)
      })
      if (enemy) {
        ctx.log.info(`Attaque ${entityLabel(enemy)}`)
        bot.pvp.attack(enemy)
      } else if (o.returnToPost && !bot.pathfinder.isMoving() && bot.entity.position.distanceTo(post) > 2) {
        bot.pathfinder.setGoal(new ctx.goals.GoalNear(post.x, post.y, post.z, 1))
      }
    })
  },
  stop (ctx) {
    if (ctx.bot.pvp) ctx.bot.pvp.forceStop()
  }
}

const pvp = {
  name: 'pvp',
  label: 'Combattant',
  category: 'Combat',
  description: 'Attaque une cible (joueur nommé, joueur le plus proche, monstres...) — test de plugins PvP, d\'arènes ou d\'anti-cheat.',
  options: [
    { key: 'targetType', label: 'Type de cible', type: 'select', default: 'player', options: ['player', 'hostile', 'any', 'named'] },
    { key: 'target', label: 'Nom de la cible (type "named")', type: 'string', default: '' },
    { key: 'range', label: 'Portée de détection', type: 'number', default: 24 },
    { key: 'attackRange', label: 'Allonge (blocs)', type: 'number', default: 3 },
    { key: 'ignore', label: 'Joueurs ignorés', type: 'string', default: '' },
    { key: 'ignoreOwnBots', label: 'Ignorer les autres bots', type: 'boolean', default: false }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const ignore = new Set(parseList(o.ignore))
    ctx.movements({})
    setupPvp(ctx, o.attackRange)
    ctx.on('stoppedAttacking', () => {
      ctx.log.info(`Fin d'attaque (${ctx.state.hits} coups portés)`)
    })
    const matches = e => {
      if (!e.position || e === bot.entity) return false
      if (e.position.distanceTo(bot.entity.position) > o.range) return false
      if (e.type === 'player') {
        if (e.username === bot.username || ignore.has(e.username)) return false
        if (o.ignoreOwnBots && ctx.instance.manager.isManaged(e.username)) return false
      }
      switch (o.targetType) {
        case 'player': return e.type === 'player'
        case 'hostile': return isHostile(e)
        case 'named': return e.username === o.target || e.name === o.target
        default: return e.type === 'player' || isHostile(e) || e.type === 'mob' || e.type === 'animal' || e.type === 'passive'
      }
    }
    ctx.every(500, () => {
      if (bot.pvp.target && bot.pvp.target.isValid) return
      const target = bot.nearestEntity(matches)
      if (target) {
        ctx.log.info(`Cible : ${entityLabel(target)}`)
        bot.pvp.attack(target)
      }
    })
  },
  stop (ctx) {
    if (ctx.bot.pvp) ctx.bot.pvp.forceStop()
  }
}

module.exports = [guard, pvp]
