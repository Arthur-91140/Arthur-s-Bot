'use strict'

const { Movements, goals } = require('mineflayer-pathfinder')
const { withTimeout, abortError, isAbortError, errorMessage } = require('./utils')

/**
 * Configure le pathfinder. Par défaut le bot ne casse ni ne pose de blocs pour se
 * déplacer, afin de ne pas fausser les tests (protections, logs de blocs...).
 */
function applyMovements (bot, { canDig = false, scaffold = false, sprint = true, parkour = true } = {}) {
  const movements = new Movements(bot)
  movements.canDig = !!canDig
  movements.allow1by1towers = !!scaffold
  movements.allowSprinting = sprint !== false
  movements.allowParkour = parkour !== false
  if (!scaffold) movements.scafoldingBlocks = []
  bot.pathfinder.setMovements(movements)
  return movements
}

/**
 * Déplace le bot vers un objectif. Ne lève une erreur que si le signal est
 * interrompu ; sinon renvoie { ok, error }.
 */
async function gotoGoal (bot, goal, { timeout = 60000, signal } = {}) {
  if (!bot || !bot.pathfinder) throw new Error('Pathfinder indisponible (bot hors ligne ?)')
  let onAbort = null
  const aborted = new Promise((resolve, reject) => {
    if (!signal) return
    onAbort = () => {
      try { bot.pathfinder.stop() } catch (err) { /* ignore */ }
      reject(abortError())
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await withTimeout(Promise.race([bot.pathfinder.goto(goal), aborted]), timeout, 'Délai de déplacement dépassé')
    // goto() se résout aussi quand aucun chemin n'existe (chemin vide) : on vérifie l'arrivée.
    if (!goal.dynamic && !isAtGoal(bot, goal)) return { ok: false, error: 'Aucun chemin vers la destination (bot bloqué ?)' }
    return { ok: true }
  } catch (err) {
    if (isAbortError(err)) throw err
    try { bot.pathfinder.stop() } catch (e) { /* ignore */ }
    return { ok: false, error: errorMessage(err) }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function isAtGoal (bot, goal) {
  if (!bot.entity) return false
  const p = bot.entity.position.floored()
  return goal.isEnd(p) || goal.isEnd(p.offset(0, 1, 0))
}

function stopMoving (bot) {
  if (!bot) return
  try {
    if (bot.pathfinder) bot.pathfinder.stop()
    if (bot.pvp && bot.pvp.target) bot.pvp.forceStop()
    bot.clearControlStates()
  } catch (err) {
    // le bot est peut-être déjà déconnecté
  }
}

module.exports = { applyMovements, gotoGoal, stopMoving, goals, Movements }
