'use strict'

const { toRegExp, waitForEvent } = require('../../core/utils')

const RECORD = { key: 'record', label: 'Enregistrer dans le rapport', type: 'boolean', default: true }

/**
 * Attend un message correspondant à `pattern`. Si `send` est fourni, l'écoute
 * démarre avant l'envoi pour ne rater aucune réponse.
 */
async function expectMessage (api, { pattern, failPattern, timeout, send }) {
  const re = pattern ? toRegExp(pattern) : null
  const failRe = failPattern ? toRegExp(failPattern) : null
  const responses = []
  let failed = null
  const started = Date.now()
  const waiting = waitForEvent(api.instance.events, 'message', {
    timeout,
    signal: api.signal,
    filter: ({ message }) => {
      responses.push(message)
      if (failRe && failRe.test(message)) {
        failed = message
        return true
      }
      return re ? re.test(message) : true
    }
  })
  if (send) api.instance.say(send)
  const res = await waiting
  const latency = Date.now() - started
  api.locals.responses = responses
  api.locals.latency = latency
  if (!res || failed) {
    api.locals.response = failed
    api.locals.match = null
    return { ok: false, latency, message: failed, timeout: !res }
  }
  const message = res[0].message
  api.locals.response = message
  api.locals.match = re ? [...message.match(re)] : [message]
  return { ok: true, latency, message }
}

const EVENTS = [
  { value: 'windowOpen', label: 'Menu ouvert' },
  { value: 'spawn', label: 'Apparition' },
  { value: 'death', label: 'Mort' },
  { value: 'hurt', label: 'Blessure' },
  { value: 'kicked', label: 'Expulsion' },
  { value: 'end', label: 'Déconnexion' },
  { value: 'forcedMove', label: 'Téléportation / setback' },
  { value: 'title', label: 'Titre' },
  { value: 'actionbar', label: 'Barre d\'action' },
  { value: 'playerJoined', label: 'Joueur connecté' },
  { value: 'playerLeft', label: 'Joueur déconnecté' }
]

module.exports = [
  {
    type: 'test.assert',
    category: 'Tests',
    label: 'Vérifier',
    description: 'Enregistre une assertion dans le rapport (réussie si la condition est vraie).',
    outputs: [{ name: 'pass', label: 'Réussi' }, { name: 'fail', label: 'Échoué' }],
    params: [
      { key: 'condition', label: 'Condition', type: 'expression', default: 'bot.health > 0' },
      { key: 'message', label: 'Description', type: 'string', default: 'Le bot est vivant' }
    ],
    run (api) {
      const ok = !!api.param('condition')
      api.report.assert(ok, api.param('message'), api.node.id)
      return ok ? 'pass' : 'fail'
    }
  },
  {
    type: 'test.command',
    category: 'Tests',
    label: 'Commande + réponse attendue',
    description: 'Envoie un message/une commande et attend une réponse correspondant au motif. Variables : response, match, latency.',
    outputs: [{ name: 'ok', label: 'Réponse OK' }, { name: 'fail', label: 'Échec' }],
    params: [
      { key: 'send', label: 'Message / commande', type: 'string', default: '/list' },
      { key: 'pattern', label: 'Réponse attendue (regex)', type: 'string', default: 'online|en ligne|joueurs' },
      { key: 'failPattern', label: 'Réponse d\'échec (regex)', type: 'string', default: 'unknown (or incomplete )?command|commande inconnue|(do not|don\'t) have permission|pas la permission|no permission' },
      { key: 'timeout', label: 'Délai (ms)', type: 'number', default: 3000 },
      RECORD
    ],
    async run (api) {
      const send = api.param('send')
      const res = await expectMessage(api, {
        send,
        pattern: api.param('pattern'),
        failPattern: api.param('failPattern'),
        timeout: api.param('timeout')
      })
      if (api.param('record')) {
        const detail = res.ok ? `"${res.message}" en ${res.latency} ms` : res.timeout ? 'aucune réponse attendue' : `réponse d'échec "${res.message}"`
        api.report.assert(res.ok, `${send} → ${detail}`, api.node.id)
        if (res.ok) api.report.metric(`latence ${send}`, res.latency, api.node.id)
      }
      return res.ok ? 'ok' : 'fail'
    }
  },
  {
    type: 'test.expectMessage',
    category: 'Tests',
    label: 'Attendre un message',
    description: 'Attend un message de chat/système correspondant au motif. Variables : response, match, latency.',
    outputs: [{ name: 'matched', label: 'Reçu' }, { name: 'timeout', label: 'Délai dépassé' }],
    params: [
      { key: 'pattern', label: 'Motif (regex)', type: 'string', default: 'Bienvenue' },
      { key: 'timeout', label: 'Délai (ms)', type: 'number', default: 5000 },
      { ...RECORD, default: false }
    ],
    async run (api) {
      const pattern = api.param('pattern')
      const res = await expectMessage(api, { pattern, timeout: api.param('timeout') })
      if (api.param('record')) api.report.assert(res.ok, `Message "${pattern}" ${res.ok ? `reçu en ${res.latency} ms` : 'non reçu'}`, api.node.id)
      return res.ok ? 'matched' : 'timeout'
    }
  },
  {
    type: 'test.expectEvent',
    category: 'Tests',
    label: 'Attendre un évènement',
    description: 'Attend un évènement du bot (menu, mort, expulsion, téléportation...). Variable : payload.',
    outputs: [{ name: 'happened', label: 'Survenu' }, { name: 'timeout', label: 'Délai dépassé' }],
    params: [
      { key: 'event', label: 'Évènement', type: 'select', default: 'windowOpen', options: EVENTS },
      { key: 'timeout', label: 'Délai (ms)', type: 'number', default: 5000 },
      { ...RECORD, default: false }
    ],
    async run (api) {
      const event = api.param('event')
      const started = Date.now()
      const res = await waitForEvent(api.instance.events, event, { timeout: api.param('timeout'), signal: api.signal })
      api.locals.payload = res ? res[0] : null
      api.locals.latency = Date.now() - started
      if (api.param('record')) api.report.assert(!!res, `Évènement ${event} ${res ? 'survenu' : 'non survenu'}`, api.node.id)
      return res ? 'happened' : 'timeout'
    }
  },
  {
    type: 'test.metric',
    category: 'Tests',
    label: 'Mesurer',
    description: 'Enregistre une valeur dans le rapport (TPS, ping, latence, compteur...).',
    params: [
      { key: 'name', label: 'Nom', type: 'string', default: 'tps' },
      { key: 'value', label: 'Valeur (expression)', type: 'expression', default: 'bot.tps' }
    ],
    run (api) {
      api.report.metric(api.param('name'), api.param('value'), api.node.id)
    }
  },
  {
    type: 'test.timerStart',
    category: 'Tests',
    label: 'Démarrer un chrono',
    description: 'Démarre un chronomètre nommé.',
    params: [{ key: 'name', label: 'Nom', type: 'string', default: 'chrono' }],
    run (api) {
      api.runtime.timers[api.param('name')] = Date.now()
    }
  },
  {
    type: 'test.timerStop',
    category: 'Tests',
    label: 'Arrêter un chrono',
    description: 'Mesure le temps écoulé depuis "Démarrer un chrono" (variable elapsed, en ms).',
    params: [
      { key: 'name', label: 'Nom', type: 'string', default: 'chrono' },
      { ...RECORD, label: 'Enregistrer comme métrique' }
    ],
    run (api) {
      const name = api.param('name')
      const start = api.runtime.timers[name]
      const elapsed = start ? Date.now() - start : null
      api.locals.elapsed = elapsed
      if (elapsed !== null && api.param('record')) api.report.metric(name, elapsed, api.node.id)
    }
  },
  {
    type: 'test.note',
    category: 'Tests',
    label: 'Noter dans le rapport',
    description: 'Ajoute une ligne libre au rapport.',
    params: [{ key: 'message', label: 'Texte', type: 'string', default: 'Étape atteinte' }],
    run (api) {
      api.report.entry(api.param('message'), api.node.id)
    }
  },
  {
    type: 'test.finish',
    category: 'Tests',
    label: 'Fin du test',
    description: 'Termine le rapport avec un statut (auto = selon les assertions) et arrête le graphe.',
    outputs: [],
    params: [
      { key: 'status', label: 'Statut', type: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Automatique' }, { value: 'passed', label: 'Réussi' }, { value: 'failed', label: 'Échoué' }
      ] },
      { key: 'message', label: 'Message', type: 'string', default: '' },
      { key: 'stopGraph', label: 'Arrêter le graphe', type: 'boolean', default: true }
    ],
    run (api) {
      api.report.finish(api.param('status'), api.param('message'))
      if (api.param('stopGraph')) api.runtime.stop('Fin du test', 'finished')
      return null
    }
  }
]
