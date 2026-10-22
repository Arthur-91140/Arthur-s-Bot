'use strict'

const { findItem, errorMessage } = require('./utils')

const BAD_FOODS = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit',
  'suspicious_stew', 'raw_chicken', 'chicken'
])

/** Description des plugins utilitaires, affichée dans l'interface. */
const PLUGIN_INFO = [
  { key: 'autoRespawn', label: 'Réapparition auto', description: 'Réapparaît automatiquement après la mort.' },
  { key: 'autoEat', label: 'Manger auto', description: 'Mange quand la faim descend sous 15.' },
  { key: 'autoArmor', label: 'Armure auto', description: 'Équipe la meilleure armure ramassée (au prochain login).' },
  { key: 'acceptResourcePack', label: 'Accepter le pack de ressources', description: 'Répond "accepté" aux packs de ressources du serveur.' },
  { key: 'authme', label: 'AuthMe /register /login', description: 'Répond automatiquement aux demandes /register et /login.' },
  { key: 'followTransfers', label: 'Suivre les transferts', description: 'Rejoint le serveur indiqué par un paquet de transfert (1.20.5+), cookies compris.' },
  { key: 'refuseCodeOfConduct', label: 'Refuser le code de conduite', description: 'Ne pas accepter le code de conduite du serveur (1.21.9+), pour tester le blocage.' }
]

/**
 * Branche les comportements utilitaires sur une connexion. Les options sont lues à
 * chaque évènement, donc les activer/désactiver depuis l'interface est immédiat.
 */
function attachPlugins (instance, bot) {
  const plugins = () => instance.plugins
  let eating = false
  let lastAuth = 0

  bot.on('death', () => {
    if (!plugins().autoRespawn) return
    setTimeout(() => {
      if (instance.bot !== bot) return
      try {
        bot.respawn()
      } catch (err) {
        instance.log.debug(`Respawn impossible : ${errorMessage(err)}`)
      }
    }, 1200)
  })

  bot.on('health', async () => {
    if (!plugins().autoEat || eating || bot.food >= 15) return
    if (bot.game && bot.game.gameMode === 'creative') return
    const foods = bot.registry.foodsByName || {}
    const candidates = bot.inventory.items()
      .filter(i => foods[i.name] && !BAD_FOODS.has(i.name))
      .sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))
    if (!candidates.length) return
    eating = true
    try {
      await bot.equip(candidates[0], 'hand')
      await bot.consume()
      instance.log.debug(`A mangé : ${candidates[0].name}`)
    } catch (err) {
      instance.log.debug(`Impossible de manger : ${errorMessage(err)}`)
    } finally {
      eating = false
    }
  })

  bot.on('messagestr', message => {
    const auth = plugins().authme
    if (!auth || !auth.enabled || !auth.password) return
    if (Date.now() - lastAuth < 4000) return
    const pw = auth.password
    // Les invites AuthMe/LoginSecurity contiennent toujours la commande à taper.
    if (/\/(register|reg)\b/i.test(message)) {
      lastAuth = Date.now()
      instance.log.info('AuthMe : envoi de /register')
      bot.chat(`/register ${pw} ${pw}`)
    } else if (/\/(login|l)\b/i.test(message)) {
      lastAuth = Date.now()
      instance.log.info('AuthMe : envoi de /login')
      bot.chat(`/login ${pw}`)
    }
  })

  bot.on('resourcePack', () => {
    if (!plugins().acceptResourcePack) return
    try {
      bot.acceptResourcePack()
      instance.log.info('Pack de ressources accepté')
    } catch (err) {
      instance.log.debug(`Pack de ressources : ${errorMessage(err)}`)
    }
  })
}

/** Équipe immédiatement la meilleure armure disponible. */
function equipBestArmor (bot) {
  if (bot && bot.armorManager) bot.armorManager.equipAll()
}

/** Donne un objet en mode créatif (utile pour builder/tests). */
async function creativeGive (bot, itemName, count = 64, slot = 36) {
  const Item = require('prismarine-item')(bot.registry)
  const def = bot.registry.itemsByName[itemName]
  if (!def) throw new Error(`Objet inconnu : ${itemName}`)
  await bot.creative.setInventorySlot(slot, new Item(def.id, Math.min(count, def.stackSize || 64)))
  return findItem(bot, itemName)
}

module.exports = { attachPlugins, equipBestArmor, creativeGive, PLUGIN_INFO }
