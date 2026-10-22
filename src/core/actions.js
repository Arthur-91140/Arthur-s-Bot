'use strict'

const { errorMessage } = require('./utils')

function required (value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`Paramètre manquant : ${name}`)
  return value
}

/** Lance une action longue sans bloquer la requête ; le résultat va dans les logs du bot. */
function background (instance, promise, label) {
  promise
    .then(res => {
      if (res && res.ok === false) instance.log.warn(`${label} : échec (${res.error})`)
      else instance.log.info(`${label} : terminé`)
    })
    .catch(err => instance.log.warn(`${label} : ${errorMessage(err)}`))
  return { started: true }
}

/**
 * Actions applicables à un bot, partagées par l'API REST, les actions groupées
 * et la console. Chaque action reçoit (instance, payload).
 */
const ACTIONS = {
  connect: b => b.connect(),
  disconnect: b => b.disconnect(),
  reconnect: b => b.reconnect(),
  chat: (b, p) => b.say(required(p.message, 'message')),
  mode: (b, p) => b.setMode(required(p.mode, 'mode'), p.options || {}),
  control: (b, p) => b.control(required(p.control, 'control'), p.state !== false, Number(p.duration) || 0),
  goto: (b, p) => background(b, b.goto(p.x, p.y, p.z, Number(p.range) || 1), `Trajet vers ${p.x} ${p.y ?? '~'} ${p.z}`),
  gotoPlayer: (b, p) => background(b, b.gotoPlayer(required(p.player, 'player'), Number(p.range) || 2), `Trajet vers ${p.player}`),
  stop: b => b.stopMovement(),
  look: (b, p) => b.look(Number(p.yaw) || 0, Number(p.pitch) || 0),
  attack: (b, p) => ({ target: b.attackNearest(p.kind || 'hostile') }),
  dropAll: async b => ({ dropped: await b.dropAll() }),
  respawn: b => b.respawn(),
  useItem: b => b.useItem(),
  swing: b => b.swing(),
  equip: async (b, p) => ({ item: await b.equip(required(p.item, 'item'), p.destination || 'hand') }),
  hotbar: (b, p) => b.setHotbar(p.slot),
  armor: b => b.equipArmor(),
  click: (b, p) => b.clickSlot(required(p.slot, 'slot'), p.button || 0, p.mode || 0),
  closeWindow: b => b.closeWindow(),
  plugins: (b, p) => b.setPlugins(p.plugins || p),
  trigger: (b, p) => b.manager.trigger(required(p.name, 'name'), p.data, [b.id]),
  inventory: b => b.getInventory(),
  window: b => b.getWindow(),
  state: b => b.getState(),
  dialog: (b, p) => b.dialogClick(p.button ?? 0, p.values || {}),
  pluginMessage: (b, p) => b.sendPluginMessage(required(p.channel, 'channel'), p.data ?? '', p.format || 'text', !!p.register),
  protocol: b => b.protocolInfo()
}

async function runAction (instance, action, payload = {}) {
  const fn = ACTIONS[action]
  if (!fn) throw new Error(`Action inconnue : ${action}`)
  // Bot hébergé par un processus ouvrier : l'action y est exécutée.
  if (instance.remote) return instance.runAction(action, payload)
  const result = await fn(instance, payload)
  return result === undefined ? { ok: true } : result
}

/** Applique une action à plusieurs bots ; renvoie le résultat ou l'erreur de chacun. */
async function runBulk (manager, targets, action, payload = {}) {
  const bots = manager.resolve(targets)
  const results = {}
  await Promise.all(bots.map(async b => {
    try {
      results[b.id] = { ok: true, result: await runAction(b, action, payload) }
    } catch (err) {
      results[b.id] = { ok: false, error: errorMessage(err) }
    }
  }))
  return { count: bots.length, results }
}

module.exports = { ACTIONS, runAction, runBulk }
