'use strict'

const { randomBetween } = require('../../core/utils')

const yieldTick = () => new Promise(resolve => setImmediate(resolve))

module.exports = [
  {
    type: 'flow.if',
    category: 'Logique',
    label: 'Si',
    description: 'Teste une condition. Ex. : bot.health < 10 && hasItem(\'bread\')',
    outputs: [{ name: 'true', label: 'Vrai' }, { name: 'false', label: 'Faux' }],
    params: [{ key: 'condition', label: 'Condition', type: 'expression', default: 'true' }],
    run: api => (api.param('condition') ? 'true' : 'false')
  },
  {
    type: 'flow.wait',
    category: 'Logique',
    label: 'Attendre',
    description: 'Met le flux en pause.',
    params: [{ key: 'ms', label: 'Durée (ms)', type: 'number', default: 1000 }],
    async run (api) {
      await api.sleep(api.param('ms'))
    }
  },
  {
    type: 'flow.waitRandom',
    category: 'Logique',
    label: 'Attente aléatoire',
    description: 'Pause d\'une durée aléatoire (comportement plus « humain »).',
    params: [
      { key: 'min', label: 'Min (ms)', type: 'number', default: 500 },
      { key: 'max', label: 'Max (ms)', type: 'number', default: 2000 }
    ],
    async run (api) {
      const min = api.param('min')
      await api.sleep(randomBetween(min, Math.max(min, api.param('max'))))
    }
  },
  {
    type: 'flow.waitUntil',
    category: 'Logique',
    label: 'Attendre que',
    description: 'Attend qu\'une condition devienne vraie (vérifiée régulièrement).',
    outputs: [{ name: 'ok', label: 'Vrai' }, { name: 'timeout', label: 'Délai dépassé' }],
    params: [
      { key: 'condition', label: 'Condition', type: 'expression', default: 'bot.health >= 20' },
      { key: 'timeout', label: 'Délai max (ms, 0 = infini)', type: 'number', default: 10000 },
      { key: 'every', label: 'Vérifier toutes les (ms)', type: 'number', default: 250 }
    ],
    async run (api) {
      const timeout = api.param('timeout')
      const every = Math.max(50, api.param('every'))
      const start = Date.now()
      while (!api.param('condition')) {
        if (timeout > 0 && Date.now() - start >= timeout) return 'timeout'
        await api.sleep(every)
      }
      return 'ok'
    }
  },
  {
    type: 'flow.sequence',
    category: 'Logique',
    label: 'Séquence',
    description: 'Exécute les sorties dans l\'ordre, chacune jusqu\'au bout avant la suivante.',
    outputs: [
      { name: 'then1', label: '1' }, { name: 'then2', label: '2' },
      { name: 'then3', label: '3' }, { name: 'then4', label: '4' }
    ],
    async run (api) {
      for (const port of ['then1', 'then2', 'then3', 'then4']) await api.exec(port)
      return null
    }
  },
  {
    type: 'flow.repeat',
    category: 'Logique',
    label: 'Répéter',
    description: 'Exécute "Corps" N fois puis continue sur "Fin". La variable de boucle contient l\'indice (0, 1, 2...).',
    outputs: [{ name: 'body', label: 'Corps' }, { name: 'done', label: 'Fin' }],
    params: [
      { key: 'count', label: 'Nombre de fois', type: 'number', default: 3 },
      { key: 'variable', label: 'Variable d\'indice', type: 'variable', default: 'index' }
    ],
    async run (api) {
      const count = api.param('count')
      const name = api.param('variable') || 'index'
      for (let i = 0; i < count; i++) {
        api.locals[name] = i
        await api.exec('body')
        await yieldTick()
      }
      return 'done'
    }
  },
  {
    type: 'flow.while',
    category: 'Logique',
    label: 'Tant que',
    description: 'Répète "Corps" tant que la condition est vraie (avec une limite de sécurité).',
    outputs: [{ name: 'body', label: 'Corps' }, { name: 'done', label: 'Fin' }],
    params: [
      { key: 'condition', label: 'Condition', type: 'expression', default: 'index < 5' },
      { key: 'max', label: 'Itérations max', type: 'number', default: 1000 },
      { key: 'variable', label: 'Variable d\'indice', type: 'variable', default: 'index' }
    ],
    async run (api) {
      const max = api.param('max')
      const name = api.param('variable') || 'index'
      let i = 0
      api.locals[name] = 0
      while (i < max && api.param('condition')) {
        await api.exec('body')
        api.locals[name] = ++i
        await yieldTick()
      }
      return 'done'
    }
  },
  {
    type: 'flow.forEachPlayer',
    category: 'Logique',
    label: 'Pour chaque joueur',
    description: 'Parcourt les joueurs connectés (variable "player").',
    outputs: [{ name: 'body', label: 'Corps' }, { name: 'done', label: 'Fin' }],
    params: [
      { key: 'includeBots', label: 'Inclure les bots gérés', type: 'boolean', default: false },
      { key: 'variable', label: 'Variable', type: 'variable', default: 'player' }
    ],
    async run (api) {
      const bot = api.bot
      const name = api.param('variable') || 'player'
      const includeBots = api.param('includeBots')
      const players = Object.keys(bot.players).filter(p =>
        p !== bot.username && (includeBots || !api.manager.isManaged(p)))
      for (const player of players) {
        api.locals[name] = player
        await api.exec('body')
      }
      return 'done'
    }
  },
  {
    type: 'flow.chance',
    category: 'Logique',
    label: 'Probabilité',
    description: 'Prend la sortie "Oui" avec la probabilité indiquée.',
    outputs: [{ name: 'yes', label: 'Oui' }, { name: 'no', label: 'Non' }],
    params: [{ key: 'percent', label: 'Probabilité (%)', type: 'number', default: 50 }],
    run: api => (Math.random() * 100 < api.param('percent') ? 'yes' : 'no')
  },
  {
    type: 'flow.random',
    category: 'Logique',
    label: 'Au hasard',
    description: 'Choisit une des sorties connectées au hasard.',
    outputs: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }, { name: 'c', label: 'C' }, { name: 'd', label: 'D' }],
    run (api) {
      const ports = api.connectedPorts()
      return ports.length ? ports[Math.floor(Math.random() * ports.length)] : null
    }
  },
  {
    type: 'flow.cooldown',
    category: 'Logique',
    label: 'Délai de récupération',
    description: 'Laisse passer au plus une fois par période (anti-spam d\'un évènement).',
    outputs: [{ name: 'pass', label: 'Passe' }, { name: 'blocked', label: 'Bloqué' }],
    params: [{ key: 'ms', label: 'Période (ms)', type: 'number', default: 5000 }],
    run (api) {
      const now = Date.now()
      const last = api.nodeState.last || 0
      if (now - last < api.param('ms')) return 'blocked'
      api.nodeState.last = now
      return 'pass'
    }
  },
  {
    type: 'flow.once',
    category: 'Logique',
    label: 'Une seule fois',
    description: 'La première exécution sort par "Première", les suivantes par "Ensuite".',
    outputs: [{ name: 'first', label: 'Première' }, { name: 'next', label: 'Ensuite' }],
    run (api) {
      if (api.nodeState.done) return 'next'
      api.nodeState.done = true
      return 'first'
    }
  },
  {
    type: 'flow.counter',
    category: 'Logique',
    label: 'Tous les N passages',
    description: 'Sort par "Atteint" un passage sur N (ex. : toutes les 10 répétitions).',
    outputs: [{ name: 'hit', label: 'Atteint' }, { name: 'miss', label: 'Sinon' }],
    params: [{ key: 'every', label: 'N', type: 'number', default: 10 }],
    run (api) {
      api.nodeState.count = (api.nodeState.count || 0) + 1
      return api.nodeState.count % Math.max(1, api.param('every')) === 0 ? 'hit' : 'miss'
    }
  },
  {
    type: 'flow.trigger',
    category: 'Logique',
    label: 'Envoyer un signal',
    description: 'Déclenche les nœuds "Signal reçu" de ce bot ou de tous les bots (coordination d\'essaim).',
    params: [
      { key: 'name', label: 'Nom du signal', type: 'string', default: 'go' },
      { key: 'target', label: 'Destinataires', type: 'select', default: 'self', options: [
        { value: 'self', label: 'Ce bot' }, { value: 'all', label: 'Tous les bots' }, { value: 'others', label: 'Les autres bots' }
      ] },
      { key: 'data', label: 'Données (expression)', type: 'expression', default: '' }
    ],
    run (api) {
      const target = api.param('target')
      const ids = target === 'self' ? [api.instance.id]
        : api.manager.list().map(b => b.id).filter(id => target === 'all' || id !== api.instance.id)
      api.manager.trigger(api.param('name'), api.param('data'), ids)
    }
  },
  {
    type: 'flow.stop',
    category: 'Logique',
    label: 'Arrêter le graphe',
    description: 'Arrête complètement ce comportement sur ce bot.',
    outputs: [],
    run (api) {
      api.runtime.stop('Nœud "Arrêter le graphe"')
      return null
    }
  },
  {
    type: 'flow.log',
    category: 'Logique',
    label: 'Journaliser',
    description: 'Écrit un message dans les logs. Utilisez {{ expression }} pour insérer des valeurs.',
    params: [
      { key: 'message', label: 'Message', type: 'string', default: 'Position : {{ bot.x }} {{ bot.y }} {{ bot.z }}' },
      { key: 'level', label: 'Niveau', type: 'select', default: 'info', options: ['debug', 'info', 'warn', 'error'] }
    ],
    run (api) {
      api.log(api.param('message'), api.param('level'))
    }
  }
]
