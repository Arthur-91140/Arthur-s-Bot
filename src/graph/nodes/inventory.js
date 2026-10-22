'use strict'

const { findItem, toRegExp, chatToText, waitForEvent, withTimeout, errorMessage } = require('../../core/utils')
const { creativeGive } = require('../../core/plugins')

function describeWindow (w) {
  if (!w) return null
  return {
    id: w.id,
    title: chatToText(w.title),
    type: w.type,
    size: w.inventoryStart,
    items: w.slots.slice(0, w.inventoryStart).map((it, slot) => it && {
      slot,
      name: it.name,
      displayName: it.customName ? chatToText(it.customName) : it.displayName,
      count: it.count
    }).filter(Boolean)
  }
}

const BUTTON = {
  key: 'button',
  label: 'Bouton',
  type: 'select',
  default: 'left',
  options: [{ value: 'left', label: 'Clic gauche' }, { value: 'right', label: 'Clic droit' }]
}

async function click (api, slot) {
  const bot = api.bot
  const button = api.param('button') === 'right' ? 1 : 0
  const mode = api.param('shift') ? 1 : 0
  await withTimeout(bot.clickWindow(slot, button, mode), 5000, 'Le serveur n\'a pas répondu au clic')
}

module.exports = [
  {
    type: 'inv.equip',
    category: 'Inventaire & GUI',
    label: 'Équiper',
    description: 'Prend un objet en main ou équipe une pièce d\'armure.',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'missing', label: 'Absent' }],
    params: [
      { key: 'item', label: 'Objet', type: 'string', default: 'diamond_sword' },
      { key: 'destination', label: 'Emplacement', type: 'select', default: 'hand', options: [
        { value: 'hand', label: 'Main' }, { value: 'off-hand', label: 'Main secondaire' },
        { value: 'head', label: 'Tête' }, { value: 'torso', label: 'Torse' },
        { value: 'legs', label: 'Jambes' }, { value: 'feet', label: 'Pieds' }
      ] }
    ],
    async run (api) {
      const item = findItem(api.bot, api.param('item'))
      if (!item) return 'missing'
      await api.bot.equip(item, api.param('destination'))
      return 'done'
    }
  },
  {
    type: 'inv.drop',
    category: 'Inventaire & GUI',
    label: 'Jeter',
    description: 'Jette un objet (quantité 0 = toute la pile) ou tout l\'inventaire si aucun objet n\'est indiqué.',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'missing', label: 'Absent' }],
    params: [
      { key: 'item', label: 'Objet (vide = tout)', type: 'string', default: '' },
      { key: 'count', label: 'Quantité (0 = tout)', type: 'number', default: 0 }
    ],
    async run (api) {
      const bot = api.bot
      const name = api.param('item')
      if (!name) {
        for (const it of bot.inventory.items()) await bot.tossStack(it)
        return 'done'
      }
      const item = findItem(bot, name)
      if (!item) return 'missing'
      const count = api.param('count')
      if (count > 0) await bot.toss(item.type, null, Math.min(count, item.count))
      else await bot.tossStack(item)
      return 'done'
    }
  },
  {
    type: 'inv.hotbar',
    category: 'Inventaire & GUI',
    label: 'Choisir la case de la barre',
    description: 'Sélectionne une case de la barre rapide (0 à 8).',
    params: [{ key: 'slot', label: 'Case (0-8)', type: 'number', default: 0 }],
    run (api) {
      api.bot.setQuickBarSlot(Math.max(0, Math.min(8, Math.floor(api.param('slot')))))
    }
  },
  {
    type: 'inv.consume',
    category: 'Inventaire & GUI',
    label: 'Manger / boire',
    description: 'Consomme un objet (nourriture, potion).',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'failed', label: 'Échec' }],
    params: [{ key: 'item', label: 'Objet (vide = objet en main)', type: 'string', default: 'bread' }],
    async run (api) {
      const bot = api.bot
      const name = api.param('item')
      if (name) {
        const item = findItem(bot, name)
        if (!item) return 'failed'
        await bot.equip(item, 'hand')
      }
      try {
        await bot.consume()
        return 'done'
      } catch (err) {
        api.log(`Consommation impossible : ${errorMessage(err)}`, 'debug')
        return 'failed'
      }
    }
  },
  {
    type: 'inv.creativeGive',
    category: 'Inventaire & GUI',
    label: 'Se donner (créatif)',
    description: 'Place un objet dans l\'inventaire (le bot doit être en mode créatif).',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'failed', label: 'Échec' }],
    params: [
      { key: 'item', label: 'Objet', type: 'string', default: 'stone' },
      { key: 'count', label: 'Quantité', type: 'number', default: 64 },
      { key: 'slot', label: 'Case d\'inventaire (36-44 = barre)', type: 'number', default: 36 }
    ],
    async run (api) {
      try {
        await creativeGive(api.bot, api.param('item'), api.param('count'), api.param('slot'))
        return 'done'
      } catch (err) {
        api.log(`Don créatif : ${errorMessage(err)}`, 'warn')
        return 'failed'
      }
    }
  },
  {
    type: 'gui.waitWindow',
    category: 'Inventaire & GUI',
    label: 'Attendre un menu',
    description: 'Attend l\'ouverture d\'une fenêtre (à placer juste après la commande/le clic qui l\'ouvre). Variable : window.',
    outputs: [{ name: 'opened', label: 'Ouvert' }, { name: 'timeout', label: 'Délai dépassé' }],
    params: [
      { key: 'pattern', label: 'Filtre de titre (regex)', type: 'string', default: '' },
      { key: 'timeout', label: 'Délai (ms)', type: 'number', default: 5000 },
      { key: 'acceptOpen', label: 'Accepter un menu déjà ouvert', type: 'boolean', default: true }
    ],
    async run (api) {
      const bot = api.bot
      const pattern = api.param('pattern')
      const re = pattern ? toRegExp(pattern) : null
      const ok = w => !re || re.test(chatToText(w.title))
      if (api.param('acceptOpen') && bot.currentWindow && ok(bot.currentWindow)) {
        api.locals.window = describeWindow(bot.currentWindow)
        return 'opened'
      }
      const res = await waitForEvent(bot, 'windowOpen', { filter: ok, timeout: api.param('timeout'), signal: api.signal })
      if (!res) return 'timeout'
      api.locals.window = describeWindow(res[0])
      return 'opened'
    }
  },
  {
    type: 'gui.click',
    category: 'Inventaire & GUI',
    label: 'Cliquer sur une case',
    description: 'Clique sur une case de la fenêtre ouverte (0 = première case en haut à gauche).',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'failed', label: 'Échec' }],
    params: [
      { key: 'slot', label: 'Case', type: 'number', default: 0 },
      BUTTON,
      { key: 'shift', label: 'Maj + clic', type: 'boolean', default: false },
      { key: 'delay', label: 'Attente après le clic (ms)', type: 'number', default: 300 }
    ],
    async run (api) {
      if (!api.bot.currentWindow) return 'failed'
      try {
        await click(api, Math.floor(api.param('slot')))
      } catch (err) {
        api.log(`Clic : ${errorMessage(err)}`, 'debug')
        return 'failed'
      }
      await api.sleep(api.param('delay'))
      api.locals.window = describeWindow(api.bot.currentWindow)
      return 'done'
    }
  },
  {
    type: 'gui.clickItem',
    category: 'Inventaire & GUI',
    label: 'Cliquer sur un objet du menu',
    description: 'Trouve un objet dans le menu ouvert par son nom ou son nom affiché (regex) et clique dessus.',
    outputs: [{ name: 'done', label: 'OK' }, { name: 'notFound', label: 'Introuvable' }],
    params: [
      { key: 'pattern', label: 'Nom ou nom affiché (regex)', type: 'string', default: 'diamond' },
      BUTTON,
      { key: 'shift', label: 'Maj + clic', type: 'boolean', default: false },
      { key: 'delay', label: 'Attente après le clic (ms)', type: 'number', default: 300 }
    ],
    async run (api) {
      const w = describeWindow(api.bot.currentWindow)
      if (!w) return 'notFound'
      const re = toRegExp(api.param('pattern'))
      const item = w.items.find(i => re.test(i.name) || re.test(i.displayName || ''))
      if (!item) return 'notFound'
      api.locals.clicked = item
      try {
        await click(api, item.slot)
      } catch (err) {
        api.log(`Clic : ${errorMessage(err)}`, 'debug')
        return 'notFound'
      }
      await api.sleep(api.param('delay'))
      api.locals.window = describeWindow(api.bot.currentWindow)
      return 'done'
    }
  },
  {
    type: 'gui.close',
    category: 'Inventaire & GUI',
    label: 'Fermer le menu',
    description: 'Ferme la fenêtre ouverte.',
    run (api) {
      const bot = api.bot
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    }
  }
]

module.exports.describeWindow = describeWindow
