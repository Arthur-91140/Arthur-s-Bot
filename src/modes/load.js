'use strict'

const { Vec3 } = require('vec3')
const { round, errorMessage } = require('../core/utils')

// Les 4 directions d'une spirale carrée : est, sud, ouest, nord.
const SPIRAL = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]

/** Passe le bot en créatif : RCON s'il est configuré, sinon /gamemode (le bot doit être op). */
async function ensureCreative (ctx) {
  const bot = ctx.bot
  if (bot.game.gameMode === 'creative' || bot.game.gameMode === 'spectator') return true
  try {
    await ctx.instance.manager.server.runRcon(`gamemode creative ${bot.username}`)
  } catch (err) {
    ctx.log.debug(`RCON indisponible (${errorMessage(err)}), essai de /gamemode`)
    bot.chat('/gamemode creative')
  }
  await ctx.waitFor('game', { timeout: 5000, filter: () => bot.game.gameMode === 'creative' })
  return bot.game.gameMode === 'creative'
}

/** Le chunk qui contient `pos` a-t-il été reçu du serveur ? */
function chunkLoaded (bot, pos) {
  try {
    return !!bot.world.getColumnAt(pos)
  } catch (err) {
    return true
  }
}

/**
 * Vol en ligne droite à vitesse fixe, interruptible, sans collision (hauteur libre
 * supposée). Comme un vrai client, le bot n'entre pas dans un chunk que le serveur
 * ne lui a pas encore envoyé : il attend, ce qui mesure aussi la vitesse d'envoi.
 */
async function flyTo (ctx, target, speed, stats = {}) {
  const bot = ctx.bot
  const step = Math.min(2, Math.max(0.1, speed / 20)) // blocs par tick (au plus 2 pour l'anti-triche vanilla)
  bot.creative.startFlying()
  while (ctx.active) {
    const pos = bot.entity.position
    const v = target.minus(pos)
    const dist = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    bot.entity.velocity.set(0, 0, 0)
    const next = dist <= step ? target.clone() : pos.plus(v.scaled(step / dist))
    if (!chunkLoaded(bot, next)) {
      stats.waits = (stats.waits || 0) + 1
      await ctx.sleep(50)
      continue
    }
    bot.entity.position = next
    if (dist <= step) return
    await ctx.sleep(50)
  }
}

const skyexplorer = {
  name: 'skyexplorer',
  label: 'Explorateur volant',
  category: 'Charge',
  description: 'Vole en créatif au-dessus du monde pour charger et générer sans cesse de nouveaux chunks : la charge la plus lourde pour un serveur. Passe en créatif par RCON (ou /gamemode si le bot est op).',
  options: [
    { key: 'pattern', label: 'Trajet', type: 'select', default: 'spiral', options: [
      { value: 'spiral', label: 'Spirale (couvre une zone)' },
      { value: 'line', label: 'Ligne droite (aller-retour)' },
      { value: 'random', label: 'Points au hasard' }
    ] },
    { key: 'speed', label: 'Vitesse (blocs/s, 10 = vol créatif)', type: 'number', default: 10 },
    { key: 'height', label: 'Altitude au-dessus du départ', type: 'number', default: 40 },
    { key: 'spacing', label: 'Écart entre les tours de spirale', type: 'number', default: 96 },
    { key: 'radius', label: 'Distance max du départ (blocs)', type: 'number', default: 3000 },
    { key: 'creative', label: 'Passer en créatif automatiquement', type: 'boolean', default: true }
  ],
  async start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    if (o.creative && !(await ensureCreative(ctx))) {
      ctx.log.warn('Explorateur volant : impossible de passer en créatif (activez RCON ou donnez l\'op au bot). Arrêt.')
      return
    }
    const origin = bot.entity.position.floored()
    const y = Math.max(-50, Math.min(310, origin.y + o.height))
    const speed = Math.max(1, Math.min(40, o.speed))
    const seen = new Set()
    const startCount = () => {
      try {
        for (const c of bot.world.getColumns()) seen.add(`${c.chunkX},${c.chunkZ}`)
      } catch (err) { /* ignore */ }
    }
    startCount()
    const initial = seen.size
    ctx.on('chunkColumnLoad', p => seen.add(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`))
    try {
      // « je vole » (les champs de vitesse ne sont écrits que par les anciennes versions)
      bot._client.write('abilities', { flags: 2, flyingSpeed: 0.05, walkingSpeed: 0.1 })
    } catch (err) { /* sans importance */ }

    const startedAt = Date.now()
    const stats = { waits: 0 }
    let flown = 0
    ctx.every(30000, () => {
      const minutes = (Date.now() - startedAt) / 60000
      const fresh = seen.size - initial
      const waiting = round((stats.waits * 50) / 1000, 0)
      stats.waits = 0
      ctx.log.info(`Explorateur volant : ${fresh} nouveaux chunks (${round(fresh / Math.max(minutes, 0.1), 0)}/min), ${round(flown / 1000, 2)} km parcourus${waiting ? `, ${waiting} s d'attente de chunks` : ''}, TPS ${ctx.instance.tps ?? '?'}`)
    })

    // Montée à l'altitude de vol.
    await flyTo(ctx, new Vec3(bot.entity.position.x, y, bot.entity.position.z), speed, stats)

    let leg = 0
    let direction = Math.random() * Math.PI * 2
    ctx.loop(async () => {
      const pos = bot.entity.position
      let target
      if (o.pattern === 'spiral') {
        const dir = SPIRAL[leg % 4]
        const length = o.spacing * Math.ceil((leg + 1) / 2)
        target = pos.plus(dir.scaled(length))
        if (Math.hypot(target.x - origin.x, target.z - origin.z) > o.radius) {
          ctx.log.info('Explorateur volant : spirale terminée, retour au départ')
          target = new Vec3(origin.x, y, origin.z)
          leg = -1
        }
      } else if (o.pattern === 'line') {
        const far = new Vec3(origin.x + Math.cos(direction) * o.radius, y, origin.z + Math.sin(direction) * o.radius)
        target = Math.hypot(pos.x - far.x, pos.z - far.z) < 2 ? new Vec3(origin.x, y, origin.z) : far
        if (target.x === origin.x && target.z === origin.z) direction += Math.PI / 3
      } else {
        const angle = Math.random() * Math.PI * 2
        const distance = o.radius * (0.3 + Math.random() * 0.7)
        target = new Vec3(origin.x + Math.cos(angle) * distance, y, origin.z + Math.sin(angle) * distance)
      }
      target.y = y
      const before = bot.entity.position.clone()
      await flyTo(ctx, target, speed, stats)
      flown += before.distanceTo(bot.entity.position)
      leg++
    })
  },
  stop (ctx) {
    try {
      ctx.bot.creative.stopFlying()
    } catch (err) { /* déjà déconnecté */ }
  }
}

module.exports = [skyexplorer]
