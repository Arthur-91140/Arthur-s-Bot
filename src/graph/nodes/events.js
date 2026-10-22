'use strict'

const { toRegExp, isHostile, entityLabel, round } = require('../../core/utils')

const OUT = [{ name: 'out', label: '' }]

/** Abonnement à un évènement normalisé du bot (stable entre les reconnexions). */
function listen (api, event, handler) {
  const events = api.instance.events
  events.on(event, handler)
  return () => events.removeListener(event, handler)
}

function regexOrNull (pattern) {
  return pattern ? toRegExp(pattern) : null
}

module.exports = [
  {
    type: 'event.start',
    category: 'Évènements',
    label: 'Au démarrage',
    description: 'Se déclenche quand le graphe est lancé (attend que le bot soit en jeu si nécessaire).',
    input: false,
    outputs: OUT,
    params: [{ key: 'waitSpawn', label: 'Attendre que le bot soit en jeu', type: 'boolean', default: true }],
    subscribe (api, fire) {
      const ready = () => api.instance.status === 'online'
      if (!api.param('waitSpawn') || ready()) {
        const t = setImmediate(() => fire({}))
        return () => clearImmediate(t)
      }
      let done = false
      const off = listen(api, 'spawn', () => {
        if (done) return
        done = true
        off()
        fire({})
      })
      return off
    }
  },
  {
    type: 'event.spawn',
    category: 'Évènements',
    label: 'À l\'apparition',
    description: 'À chaque apparition du bot (connexion, réapparition après une mort, changement de monde).',
    input: false,
    outputs: OUT,
    params: [{ key: 'onlyFirst', label: 'Seulement après connexion', type: 'boolean', default: false }],
    subscribe (api, fire) {
      const onlyFirst = api.param('onlyFirst')
      return listen(api, 'spawn', ({ first }) => {
        if (!onlyFirst || first) fire({ first })
      })
    }
  },
  {
    type: 'event.chat',
    category: 'Évènements',
    label: 'Message reçu',
    description: 'Quand un message de chat ou système correspond au motif. Variables : event.message, event.username, event.match (groupes).',
    input: false,
    outputs: OUT,
    params: [
      { key: 'pattern', label: 'Motif (regex, vide = tout)', type: 'string', default: '' },
      { key: 'source', label: 'Source', type: 'select', default: 'all', options: [
        { value: 'all', label: 'Tous les messages' },
        { value: 'player', label: 'Joueurs (format <nom> msg)' },
        { value: 'system', label: 'Système / plugins' }
      ] }
    ],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      const source = api.param('source')
      if (source === 'player') {
        return listen(api, 'chat', ({ username, message }) => {
          const m = re ? message.match(re) : [message]
          if (m) fire({ username, message, match: [...m] })
        })
      }
      return listen(api, 'message', ({ message, position }) => {
        if (source === 'system' && position === 'chat') return
        const m = re ? message.match(re) : [message]
        if (m) fire({ message, match: [...m], position })
      })
    }
  },
  {
    type: 'event.whisper',
    category: 'Évènements',
    label: 'Message privé reçu',
    description: 'Quand un joueur chuchote au bot (/msg). Variables : event.username, event.message.',
    input: false,
    outputs: OUT,
    params: [{ key: 'pattern', label: 'Motif (regex)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      return listen(api, 'whisper', ({ username, message }) => {
        const m = re ? message.match(re) : [message]
        if (m) fire({ username, message, match: [...m] })
      })
    }
  },
  {
    type: 'event.interval',
    category: 'Évènements',
    label: 'Toutes les X ms',
    description: 'Déclenche périodiquement (seulement quand le bot est en jeu). Variable : event.count.',
    input: false,
    outputs: OUT,
    params: [
      { key: 'interval', label: 'Intervalle (ms)', type: 'number', default: 5000 },
      { key: 'allowOverlap', label: 'Autoriser le chevauchement', type: 'boolean', default: false }
    ],
    subscribe (api, fire) {
      let count = 0
      const timer = setInterval(() => {
        if (api.instance.status === 'online') fire({ count: ++count })
      }, Math.max(50, api.param('interval')))
      return () => clearInterval(timer)
    }
  },
  {
    type: 'event.death',
    category: 'Évènements',
    label: 'À la mort',
    description: 'Quand le bot meurt.',
    input: false,
    outputs: OUT,
    subscribe: (api, fire) => listen(api, 'death', () => fire({}))
  },
  {
    type: 'event.hurt',
    category: 'Évènements',
    label: 'Bot blessé',
    description: 'Quand le bot subit des dégâts. Variable : event.health.',
    input: false,
    outputs: OUT,
    subscribe: (api, fire) => listen(api, 'hurt', payload => fire(payload))
  },
  {
    type: 'event.health',
    category: 'Évènements',
    label: 'Vie basse',
    description: 'Quand la vie passe sous un seuil (déclenché une fois par passage).',
    input: false,
    outputs: OUT,
    params: [{ key: 'below', label: 'Seuil de vie', type: 'number', default: 10 }],
    subscribe (api, fire) {
      const below = api.param('below')
      let armed = true
      return listen(api, 'health', ({ health, food }) => {
        if (health < below && armed) {
          armed = false
          fire({ health, food })
        } else if (health >= below) {
          armed = true
        }
      })
    }
  },
  {
    type: 'event.playerJoined',
    category: 'Évènements',
    label: 'Joueur connecté',
    description: 'Quand un joueur rejoint le serveur. Variable : event.player.',
    input: false,
    outputs: OUT,
    params: [{ key: 'pattern', label: 'Filtre de nom (regex)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      return listen(api, 'playerJoined', ({ player }) => {
        if (!re || re.test(player)) fire({ player })
      })
    }
  },
  {
    type: 'event.playerLeft',
    category: 'Évènements',
    label: 'Joueur déconnecté',
    description: 'Quand un joueur quitte le serveur. Variable : event.player.',
    input: false,
    outputs: OUT,
    params: [{ key: 'pattern', label: 'Filtre de nom (regex)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      return listen(api, 'playerLeft', ({ player }) => {
        if (!re || re.test(player)) fire({ player })
      })
    }
  },
  {
    type: 'event.kicked',
    category: 'Évènements',
    label: 'Expulsé / déconnecté',
    description: 'Quand le bot est expulsé ou perd la connexion. Variable : event.reason.',
    input: false,
    outputs: [{ name: 'kicked', label: 'Expulsé' }, { name: 'ended', label: 'Déconnecté' }],
    subscribe (api, fire) {
      const off1 = listen(api, 'kicked', p => fire(p, 'kicked'))
      const off2 = listen(api, 'end', p => fire(p, 'ended'))
      return () => { off1(); off2() }
    }
  },
  {
    type: 'event.windowOpen',
    category: 'Évènements',
    label: 'Menu ouvert',
    description: 'Quand une fenêtre/GUI s\'ouvre. Variables : event.title, event.type, event.size.',
    input: false,
    outputs: OUT,
    params: [{ key: 'pattern', label: 'Filtre de titre (regex)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      return listen(api, 'windowOpen', p => {
        if (!re || re.test(p.title)) fire(p)
      })
    }
  },
  {
    type: 'event.title',
    category: 'Évènements',
    label: 'Titre affiché',
    description: 'Quand le serveur affiche un titre/sous-titre. Variables : event.text, event.type.',
    input: false,
    outputs: OUT,
    params: [{ key: 'pattern', label: 'Motif (regex)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = regexOrNull(api.param('pattern'))
      return listen(api, 'title', p => {
        if (!re || re.test(p.text)) fire(p)
      })
    }
  },
  {
    type: 'event.forcedMove',
    category: 'Évènements',
    label: 'Téléporté / repositionné',
    description: 'Quand le serveur force la position du bot (téléportation, setback d\'anti-cheat). Variables : event.x/y/z.',
    input: false,
    outputs: OUT,
    subscribe: (api, fire) => listen(api, 'forcedMove', p => fire(p))
  },
  {
    type: 'event.proximity',
    category: 'Évènements',
    label: 'Entité à proximité',
    description: 'Quand une entité correspondante entre dans le rayon. Variable : event.entity.',
    input: false,
    outputs: OUT,
    params: [
      { key: 'filter', label: 'Entité', type: 'select', default: 'player', options: [
        { value: 'player', label: 'Joueur' }, { value: 'hostile', label: 'Monstre' },
        { value: 'any', label: 'Toute entité vivante' }, { value: 'named', label: 'Nom précis' }
      ] },
      { key: 'name', label: 'Nom (si "Nom précis")', type: 'string', default: '' },
      { key: 'distance', label: 'Rayon', type: 'number', default: 5 }
    ],
    subscribe (api, fire) {
      const filter = api.param('filter')
      const name = api.param('name')
      const distance = api.param('distance')
      const inside = new Set()
      const timer = setInterval(() => {
        const bot = api.instance.bot
        if (!bot || !bot.entity || api.instance.status !== 'online') return
        const seen = new Set()
        for (const e of Object.values(bot.entities)) {
          if (e === bot.entity || !e.position) continue
          const ok = filter === 'player' ? e.type === 'player'
            : filter === 'hostile' ? isHostile(e)
              : filter === 'named' ? (e.username === name || e.name === name)
                : (e.type === 'player' || e.type === 'mob' || e.type === 'hostile' || e.type === 'animal' || e.type === 'passive')
          if (!ok) continue
          const d = e.position.distanceTo(bot.entity.position)
          if (d > distance) continue
          seen.add(e.id)
          if (!inside.has(e.id)) {
            fire({ entity: { id: e.id, name: entityLabel(e), type: e.type, x: round(e.position.x), y: round(e.position.y), z: round(e.position.z), distance: round(d) } })
          }
        }
        inside.clear()
        for (const id of seen) inside.add(id)
      }, 500)
      return () => clearInterval(timer)
    }
  },
  {
    type: 'event.custom',
    category: 'Évènements',
    label: 'Signal reçu',
    description: 'Déclenché par le nœud "Envoyer un signal", un bouton du tableau de bord ou l\'API. Variable : event.data.',
    input: false,
    outputs: OUT,
    params: [{ key: 'name', label: 'Nom du signal', type: 'string', default: 'go' }],
    subscribe (api, fire) {
      const name = api.param('name')
      return listen(api, 'custom', p => {
        if (p.name === name) fire({ name: p.name, data: p.data })
      })
    }
  }
]
