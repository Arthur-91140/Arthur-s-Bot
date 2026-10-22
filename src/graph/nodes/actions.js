'use strict'

const { applyMovements, gotoGoal, goals } = require('../../core/navigation')
const { waitForEvent, errorMessage, findItem } = require('../../core/utils')
const { ENTITY_FILTER, findEntity, findPlacementReference, vecFromParams, XYZ } = require('./helpers')

const DONE_FAILED = [{ name: 'done', label: 'OK' }, { name: 'failed', label: 'Échec' }]

async function approach (api, pos, range, timeout = 15000) {
  const bot = api.bot
  if (bot.entity.position.distanceTo(pos) <= range + 0.5) return true
  api.runtime.usedMovement = true
  applyMovements(bot, {})
  const res = await gotoGoal(bot, new goals.GoalNear(pos.x, pos.y, pos.z, Math.max(1, range - 1)), { timeout, signal: api.signal })
  return res.ok
}

module.exports = [
  {
    type: 'action.chat',
    category: 'Actions',
    label: 'Écrire dans le chat',
    description: 'Envoie un message (ou une commande si le texte commence par /).',
    params: [{ key: 'message', label: 'Message', type: 'string', default: 'Bonjour, je suis {{ bot.username }} !' }],
    run (api) {
      api.instance.say(api.param('message'))
    }
  },
  {
    type: 'action.command',
    category: 'Actions',
    label: 'Exécuter une commande',
    description: 'Envoie une commande (le / est ajouté automatiquement).',
    params: [{ key: 'command', label: 'Commande', type: 'string', default: 'spawn' }],
    run (api) {
      const cmd = String(api.param('command')).trim()
      api.instance.say(cmd.startsWith('/') ? cmd : `/${cmd}`)
    }
  },
  {
    type: 'action.whisper',
    category: 'Actions',
    label: 'Message privé',
    description: 'Chuchote à un joueur (/tell).',
    params: [
      { key: 'player', label: 'Joueur', type: 'string', default: '{{ event.username }}' },
      { key: 'message', label: 'Message', type: 'string', default: 'Salut !' }
    ],
    run (api) {
      api.bot.whisper(api.param('player'), api.param('message'))
    }
  },
  {
    type: 'action.attack',
    category: 'Actions',
    label: 'Attaquer',
    description: 'Frappe une fois ou combat jusqu\'à la mort/fuite de la cible.',
    outputs: [{ name: 'done', label: 'Terminé' }, { name: 'notFound', label: 'Aucune cible' }],
    params: [
      ENTITY_FILTER,
      { key: 'name', label: 'Nom (si "Nom précis")', type: 'string', default: '' },
      { key: 'range', label: 'Portée de recherche', type: 'number', default: 16 },
      { key: 'mode', label: 'Mode', type: 'select', default: 'hit', options: [
        { value: 'hit', label: 'Un coup' }, { value: 'fight', label: 'Combat complet' }
      ] },
      { key: 'timeout', label: 'Durée max du combat (ms)', type: 'number', default: 20000 }
    ],
    async run (api) {
      const bot = api.bot
      const target = findEntity(api, api.param('filter'), api.param('name'), api.param('range'))
      if (!target) return 'notFound'
      api.locals.target = target.username || target.name
      if (api.param('mode') === 'fight') {
        api.runtime.usedMovement = true
        applyMovements(bot, {})
        bot.pvp.attack(target)
        const res = await waitForEvent(bot, 'stoppedAttacking', { timeout: api.param('timeout'), signal: api.signal })
        if (!res) bot.pvp.stop()
        return 'done'
      }
      if (!(await approach(api, target.position, 3))) return 'notFound'
      await bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.8, 0), true)
      bot.attack(target)
      return 'done'
    }
  },
  {
    type: 'action.dig',
    category: 'Actions',
    label: 'Casser un bloc',
    description: 'Se rapproche si besoin et casse le bloc aux coordonnées (outil adapté choisi automatiquement).',
    outputs: DONE_FAILED,
    params: [...XYZ, { key: 'verify', label: 'Vérifier que le bloc a disparu', type: 'boolean', default: true }],
    async run (api) {
      const bot = api.bot
      const pos = vecFromParams(api)
      const block = bot.blockAt(pos)
      if (!block || block.name.endsWith('air')) return 'failed'
      if (!(await approach(api, pos, 4))) return 'failed'
      if (!bot.canDigBlock(block)) return 'failed'
      if (bot.tool) await bot.tool.equipForBlock(block, {}).catch(() => {})
      await bot.dig(block, true)
      if (api.param('verify')) {
        await api.sleep(400)
        const after = bot.blockAt(pos)
        if (after && after.type === block.type) return 'failed'
      }
      return 'done'
    }
  },
  {
    type: 'action.place',
    category: 'Actions',
    label: 'Poser un bloc',
    description: 'Pose un bloc aux coordonnées (il faut un bloc voisin sur lequel s\'appuyer).',
    outputs: DONE_FAILED,
    params: [...XYZ, { key: 'item', label: 'Bloc (vide = objet en main)', type: 'string', default: 'stone' }],
    async run (api) {
      const bot = api.bot
      const target = vecFromParams(api)
      const item = api.param('item')
      if (item) {
        const it = findItem(bot, item)
        if (!it) {
          api.log(`Objet absent : ${item}`, 'warn')
          return 'failed'
        }
        await bot.equip(it, 'hand')
      }
      const found = findPlacementReference(bot, target)
      if (!found) return 'failed'
      if (!(await approach(api, target, 4))) return 'failed'
      try {
        await bot.placeBlock(found.ref, found.face)
      } catch (err) {
        api.log(`Pose : ${errorMessage(err)}`, 'debug')
      }
      await api.sleep(300)
      const now = bot.blockAt(target)
      return now && !now.name.endsWith('air') ? 'done' : 'failed'
    }
  },
  {
    type: 'action.useBlock',
    category: 'Actions',
    label: 'Utiliser un bloc',
    description: 'Clic droit sur un bloc (bouton, levier, coffre, panneau, PNJ de bloc...).',
    outputs: DONE_FAILED,
    params: XYZ,
    async run (api) {
      const bot = api.bot
      const pos = vecFromParams(api)
      const block = bot.blockAt(pos)
      if (!block) return 'failed'
      if (!(await approach(api, pos, 4))) return 'failed'
      await bot.activateBlock(block)
      return 'done'
    }
  },
  {
    type: 'action.useEntity',
    category: 'Actions',
    label: 'Interagir avec une entité',
    description: 'Clic droit sur une entité (PNJ Citizens, villageois, monture...).',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'notFound', label: 'Introuvable' }],
    params: [
      { ...ENTITY_FILTER, default: 'named' },
      { key: 'name', label: 'Nom', type: 'string', default: '' },
      { key: 'range', label: 'Portée', type: 'number', default: 8 }
    ],
    async run (api) {
      const bot = api.bot
      const target = findEntity(api, api.param('filter'), api.param('name'), api.param('range'))
      if (!target) return 'notFound'
      if (!(await approach(api, target.position, 3))) return 'notFound'
      await bot.activateEntity(target)
      return 'done'
    }
  },
  {
    type: 'action.useItem',
    category: 'Actions',
    label: 'Utiliser l\'objet en main',
    description: 'Clic droit avec l\'objet tenu (boussole de menu, nourriture, arc...).',
    params: [{ key: 'duration', label: 'Maintenir (ms)', type: 'number', default: 200 }],
    async run (api) {
      const bot = api.bot
      bot.activateItem()
      try {
        await api.sleep(api.param('duration'))
      } finally {
        bot.deactivateItem()
      }
    }
  },
  {
    type: 'action.swing',
    category: 'Actions',
    label: 'Agiter le bras',
    description: 'Animation de clic gauche (sans cible).',
    run (api) {
      api.bot.swingArm()
    }
  },
  {
    type: 'action.respawn',
    category: 'Actions',
    label: 'Réapparaître',
    description: 'Réapparaît après une mort.',
    run (api) {
      api.bot.respawn()
    }
  },
  {
    type: 'action.setMode',
    category: 'Actions',
    label: 'Changer de mode',
    description: 'Active un mode prédéfini (suiveur, garde, mineur...) avec ses options en JSON.',
    params: [
      { key: 'mode', label: 'Mode', type: 'mode', default: 'idle' },
      { key: 'options', label: 'Options (JSON)', type: 'json', default: '{}' }
    ],
    run (api) {
      api.instance.setMode(api.param('mode'), api.param('options') || {})
    }
  },
  {
    type: 'action.disconnect',
    category: 'Actions',
    label: 'Se déconnecter',
    description: 'Déconnecte le bot. Avec un délai > 0, il se reconnecte ensuite automatiquement.',
    outputs: [],
    params: [{ key: 'reconnectAfter', label: 'Se reconnecter après (ms, 0 = non)', type: 'number', default: 0 }],
    run (api) {
      const delay = api.param('reconnectAfter')
      if (delay > 0) api.instance.cycleReconnect(delay)
      else api.instance.disconnect('Nœud "Se déconnecter"')
      return null
    }
  }
]
