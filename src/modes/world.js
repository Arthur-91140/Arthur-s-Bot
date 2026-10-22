'use strict'

const { Vec3 } = require('vec3')
const { resolveBlockIds, findItem, randomBetween, parseList, errorMessage, withTimeout } = require('../core/utils')
const { creativeGive } = require('../core/plugins')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const UNBREAKABLE = new Set([
  'air', 'cave_air', 'void_air', 'bedrock', 'barrier', 'water', 'lava', 'command_block',
  'chain_command_block', 'repeating_command_block', 'structure_block', 'structure_void', 'jigsaw',
  'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal', 'portal', 'light',
  'moving_piston', 'reinforced_deepslate'
])

const posKey = p => `${p.x},${p.y},${p.z}`

function isUnderBot (bot, p) {
  const b = bot.entity.position
  return p.x === Math.floor(b.x) && p.z === Math.floor(b.z) && p.y < b.y && p.y >= Math.floor(b.y) - 2
}

function isBotSpace (bot, p) {
  const b = bot.entity.position.floored()
  return p.x === b.x && p.z === b.z && (p.y === b.y || p.y === b.y + 1)
}

/** Objet qui pose un bloc plein (exclut le blé, les graines, les torches...). */
function isSolidBlockItem (bot, item) {
  const block = bot.registry.blocksByName[item.name]
  return !!block && block.boundingBox === 'block' && !UNBREAKABLE.has(block.name) && !/(_sapling|_slab|_stairs|_door|_bed|sign|banner|torch|shulker_box|chest|_trapdoor|_wall|_fence|_pane)/.test(block.name)
}

/** Conclut un test "autorisé / refusé" en fonction du résultat attendu. */
function verdict (expect, stats) {
  if (expect === 'allowed') return stats.denied === 0 && stats.done > 0 ? 'passed' : 'failed'
  if (expect === 'denied') return stats.done === 0 && stats.denied > 0 ? 'passed' : 'failed'
  return 'passed'
}

const EXPECT_OPTION = {
  key: 'expect',
  label: 'Résultat attendu',
  type: 'select',
  default: 'any',
  options: [
    { value: 'any', label: 'Indifférent (statistiques)' },
    { value: 'allowed', label: 'Autorisé (zone libre)' },
    { value: 'denied', label: 'Refusé (zone protégée)' }
  ]
}

const miner = {
  name: 'miner',
  label: 'Mineur',
  category: 'Monde',
  description: 'Cherche et récolte un type de bloc (minerais, bois, pierre...).',
  options: [
    { key: 'blocks', label: 'Blocs', type: 'string', default: 'stone', help: 'Ex. "oak_log, *_ore" (exact, partiel ou joker *)' },
    { key: 'maxDistance', label: 'Distance de recherche', type: 'number', default: 32 },
    { key: 'limit', label: 'Quantité (0 = infini)', type: 'number', default: 0 },
    { key: 'canDig', label: 'Creuser pour atteindre', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const ids = resolveBlockIds(bot.registry, o.blocks)
    if (!ids.length) {
      ctx.log.warn(`Aucun bloc ne correspond à "${o.blocks}"`)
      return
    }
    bot.collectBlock.movements = ctx.movements({ canDig: o.canDig })
    ctx.state.mined = 0
    const skip = new Set()
    ctx.every(120000, () => skip.clear())
    ctx.loop(async () => {
      if (o.limit > 0 && ctx.state.mined >= o.limit) {
        ctx.log.info(`Objectif atteint : ${ctx.state.mined} blocs récoltés`)
        return false
      }
      if (bot.inventory.emptySlotCount() === 0) {
        ctx.log.warn('Inventaire plein, arrêt du minage')
        return false
      }
      const pos = bot.findBlocks({ matching: ids, maxDistance: o.maxDistance, count: 64 }).find(p => !skip.has(posKey(p)))
      const block = pos && bot.blockAt(pos)
      if (!block) {
        if (!ctx.state.warned) ctx.log.info('Aucun bloc cible à proximité, exploration…')
        ctx.state.warned = true
        const p = bot.entity.position
        await ctx.goto(new ctx.goals.GoalNearXZ(p.x + randomBetween(-24, 24), p.z + randomBetween(-24, 24), 2), 30000)
        return
      }
      ctx.state.warned = false
      try {
        await withTimeout(bot.collectBlock.collect(block, { ignoreNoPath: true }), 60000, 'collecte trop longue')
      } catch (err) {
        await bot.collectBlock.cancelTask().catch(() => {})
        skip.add(posKey(block.position))
        throw err
      }
      // collect() ignore silencieusement les blocs inaccessibles : on vérifie qu'il a bien disparu.
      const after = bot.blockAt(block.position)
      if (after && after.type === block.type) {
        skip.add(posKey(block.position))
        await ctx.sleep(300)
        return
      }
      ctx.state.mined++
      if (ctx.state.mined % 10 === 0) ctx.log.info(`${ctx.state.mined} blocs récoltés`)
    })
  },
  stop (ctx) {
    if (ctx.bot.collectBlock) ctx.bot.collectBlock.cancelTask().catch(() => {})
  }
}

const CROPS = {
  wheat: { max: 7, seed: 'wheat_seeds' },
  carrots: { max: 7, seed: 'carrot' },
  potatoes: { max: 7, seed: 'potato' },
  beetroots: { max: 3, seed: 'beetroot_seeds' },
  nether_wart: { max: 3, seed: 'nether_wart' }
}

function cropAge (block) {
  const props = typeof block.getProperties === 'function' ? block.getProperties() : {}
  return props.age !== undefined ? Number(props.age) : block.metadata
}

const farmer = {
  name: 'farmer',
  label: 'Fermier',
  category: 'Monde',
  description: 'Récolte les cultures mûres et replante (blé, carottes, pommes de terre, betteraves, verrues).',
  options: [
    { key: 'radius', label: 'Rayon', type: 'number', default: 24 },
    { key: 'crops', label: 'Cultures', type: 'string', default: 'wheat,carrots,potatoes,beetroots,nether_wart' },
    { key: 'replant', label: 'Replanter', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const wanted = parseList(o.crops).filter(n => CROPS[n])
    const ids = wanted.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    if (!ids.length) {
      ctx.log.warn('Aucune culture reconnue pour cette version')
      return
    }
    ctx.movements({})
    ctx.state.harvested = 0
    const skip = new Set()
    ctx.every(60000, () => skip.clear())
    ctx.loop(async () => {
      const mature = bot.findBlocks({ matching: ids, maxDistance: o.radius, count: 128 })
        .map(p => bot.blockAt(p))
        .filter(b => b && CROPS[b.name] && cropAge(b) >= CROPS[b.name].max && !skip.has(posKey(b.position)))
      if (!mature.length) {
        await ctx.sleep(3000)
        return
      }
      const block = mature[0]
      const p = block.position
      if (!(await ctx.goto(new ctx.goals.GoalNear(p.x, p.y, p.z, 2), 30000))) {
        skip.add(posKey(p))
        return
      }
      await bot.dig(block, true)
      ctx.state.harvested++
      if (o.replant) {
        await ctx.sleep(200)
        const seedName = CROPS[block.name].seed
        const seed = bot.inventory.items().find(i => i.name === seedName)
        const soil = bot.blockAt(p.offset(0, -1, 0))
        if (seed && soil && (soil.name === 'farmland' || soil.name === 'soul_sand')) {
          try {
            await bot.equip(seed, 'hand')
            await bot.placeBlock(soil, new Vec3(0, 1, 0))
          } catch (err) {
            ctx.log.debug(`Replantation impossible : ${errorMessage(err)}`)
          }
        }
      }
      await ctx.goto(new ctx.goals.GoalBlock(p.x, p.y, p.z), 5000)
      if (ctx.state.harvested % 10 === 0) ctx.log.info(`${ctx.state.harvested} cultures récoltées`)
    })
  }
}

const builder = {
  name: 'builder',
  label: 'Bâtisseur',
  category: 'Monde',
  description: 'Pose des blocs (au hasard, en ligne ou en pilier) et compte les refus — test de protections (WorldGuard, claims...).',
  options: [
    { key: 'block', label: 'Bloc', type: 'string', default: '', help: 'Vide = premier bloc de l\'inventaire' },
    { key: 'pattern', label: 'Motif', type: 'select', default: 'scatter', options: ['scatter', 'line', 'pillar'] },
    { key: 'count', label: 'Nombre de blocs', type: 'number', default: 16 },
    { key: 'radius', label: 'Rayon (scatter)', type: 'number', default: 5 },
    { key: 'delay', label: 'Délai entre poses (ms)', type: 'number', default: 300 },
    { key: 'creativeRefill', label: 'Se servir en créatif', type: 'boolean', default: true },
    EXPECT_OPTION
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const report = ctx.state.report = ctx.createReport(`Construction ${o.pattern} (${bot.username})`)
    const stats = ctx.state.stats = { done: 0, denied: 0, failed: 0 }
    const origin = bot.entity.position.floored()
    const yaw = bot.entity.yaw
    const dir = new Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw)))
    if (dir.x === 0 && dir.z === 0) dir.z = 1
    let index = 0
    ctx.movements({})

    const getItem = async () => {
      let item = o.block
        ? findItem(bot, o.block)
        : bot.inventory.items().find(i => isSolidBlockItem(bot, i))
      if (!item && o.creativeRefill && bot.game.gameMode === 'creative') {
        item = await creativeGive(bot, o.block || 'stone')
      }
      return item
    }

    const groundAt = (x, z, aroundY) => {
      for (let y = aroundY + 2; y >= aroundY - 3; y--) {
        const pos = new Vec3(x, y, z)
        const b = bot.blockAt(pos)
        const below = bot.blockAt(pos.offset(0, -1, 0))
        if (b && AIR.has(b.name) && below && below.boundingBox === 'block' && !isBotSpace(bot, pos)) return pos
      }
      return null
    }

    const placeAt = async target => {
      const item = await getItem()
      if (!item) return 'empty'
      if (bot.entity.position.distanceTo(target) > 4) {
        if (!(await ctx.goto(new ctx.goals.GoalNear(target.x, target.y, target.z, 3), 20000))) return 'failed'
      }
      if (isBotSpace(bot, target)) return 'failed'
      await bot.equip(item, 'hand')
      try {
        await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0))
      } catch (err) {
        ctx.log.debug(`placeBlock : ${errorMessage(err)}`)
      }
      await ctx.sleep(400)
      const now = bot.blockAt(target)
      return now && !AIR.has(now.name) ? 'done' : 'denied'
    }

    const pillarStep = async () => {
      const item = await getItem()
      if (!item) return 'empty'
      await bot.equip(item, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
      if (!ref || ref.boundingBox !== 'block') return 'failed'
      const startY = bot.entity.position.y
      bot.setControlState('jump', true)
      const deadline = Date.now() + 1500
      while (bot.entity.position.y < startY + 1.05 && Date.now() < deadline) await ctx.sleep(20)
      bot.setControlState('jump', false)
      try {
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
      } catch (err) {
        ctx.log.debug(`placeBlock : ${errorMessage(err)}`)
      }
      await ctx.sleep(500)
      const placed = bot.blockAt(ref.position.offset(0, 1, 0))
      return placed && !AIR.has(placed.name) ? 'done' : 'denied'
    }

    ctx.loop(async () => {
      const attempts = stats.done + stats.denied + stats.failed
      if (attempts >= o.count) return finish()
      let result
      let where = ''
      if (o.pattern === 'pillar') {
        result = await pillarStep()
        where = 'pilier'
      } else {
        let target = null
        if (o.pattern === 'line') {
          index++
          target = groundAt(origin.x + dir.x * (index + 1), origin.z + dir.z * (index + 1), origin.y)
        } else {
          for (let i = 0; i < 10 && !target; i++) {
            target = groundAt(
              Math.floor(origin.x + randomBetween(-o.radius, o.radius)),
              Math.floor(origin.z + randomBetween(-o.radius, o.radius)),
              origin.y)
          }
        }
        if (!target) {
          stats.failed++
          return
        }
        where = `${target.x} ${target.y} ${target.z}`
        result = await placeAt(target)
      }
      if (result === 'empty') {
        ctx.log.warn('Plus de blocs à poser')
        return finish()
      }
      stats[result]++
      report.entry(`${where} : ${result === 'done' ? 'posé' : result === 'denied' ? 'refusé' : 'échec'}`)
      await ctx.sleep(o.delay)
    })

    function finish () {
      const status = verdict(o.expect, stats)
      ctx.log.info(`Construction terminée : ${stats.done} posés, ${stats.denied} refusés, ${stats.failed} échecs`)
      report.metric('posés', stats.done)
      report.metric('refusés', stats.denied)
      report.metric('échecs', stats.failed)
      report.finish(status)
      return false
    }
  },
  stop (ctx) {
    if (ctx.state.report) ctx.state.report.finish('stopped')
  }
}

const breaker = {
  name: 'breaker',
  label: 'Casseur',
  category: 'Monde',
  description: 'Tente de casser les blocs autour de lui et détecte ceux que le serveur restaure — test de protections / anti-grief.',
  options: [
    { key: 'blocks', label: 'Blocs (vide = tous les blocs pleins)', type: 'string', default: '' },
    { key: 'radius', label: 'Rayon', type: 'number', default: 5 },
    { key: 'count', label: 'Nombre de blocs', type: 'number', default: 16 },
    { key: 'delay', label: 'Délai (ms)', type: 'number', default: 250 },
    EXPECT_OPTION
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const report = ctx.state.report = ctx.createReport(`Casse (${bot.username})`)
    const stats = { done: 0, denied: 0, failed: 0 }
    const ids = o.blocks
      ? resolveBlockIds(bot.registry, o.blocks)
      : bot.registry.blocksArray.filter(b => !UNBREAKABLE.has(b.name) && b.boundingBox === 'block' && b.diggable !== false).map(b => b.id)
    const skip = new Set()
    ctx.movements({})

    const finish = () => {
      ctx.log.info(`Casse terminée : ${stats.done} cassés, ${stats.denied} restaurés/refusés, ${stats.failed} échecs`)
      report.metric('cassés', stats.done)
      report.metric('refusés', stats.denied)
      report.metric('échecs', stats.failed)
      report.finish(verdict(o.expect, stats))
      return false
    }

    ctx.loop(async () => {
      if (stats.done + stats.denied + stats.failed >= o.count) return finish()
      const pos = bot.findBlocks({ matching: ids, maxDistance: o.radius, count: 64 })
        .find(p => !skip.has(posKey(p)) && !isUnderBot(bot, p))
      if (!pos) {
        ctx.log.info('Plus aucun bloc à casser dans le rayon')
        return finish()
      }
      skip.add(posKey(pos))
      const block = bot.blockAt(pos)
      if (bot.entity.position.distanceTo(pos) > 4) await ctx.goto(new ctx.goals.GoalNear(pos.x, pos.y, pos.z, 3), 20000)
      if (!block || !bot.canDigBlock(block)) {
        stats.failed++
        return
      }
      if (bot.tool) await bot.tool.equipForBlock(block, {}).catch(() => {})
      try {
        await bot.dig(block, true)
      } catch (err) {
        stats.failed++
        report.entry(`${posKey(pos)} ${block.name} : échec (${errorMessage(err)})`)
        return
      }
      await ctx.sleep(500)
      const after = bot.blockAt(pos)
      const restored = after && after.type === block.type
      stats[restored ? 'denied' : 'done']++
      report.entry(`${posKey(pos)} ${block.name} : ${restored ? 'restauré (refusé)' : 'cassé'}`)
      await ctx.sleep(o.delay)
    })
  },
  stop (ctx) {
    if (ctx.state.report) ctx.state.report.finish('stopped')
  }
}

module.exports = [miner, farmer, builder, breaker]
