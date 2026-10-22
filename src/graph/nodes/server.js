'use strict'

const { errorMessage, waitForEvent } = require('../../core/utils')

const DONE_FAILED = [{ name: 'done', label: 'OK' }, { name: 'failed', label: 'Échec' }]

const RESULT_VAR = { key: 'variable', label: 'Ranger le résultat dans', type: 'variable', default: 'resultat' }

/** Réglages du serveur modifiables par le protocole de gestion (nom de méthode → libellé). */
const SETTINGS = [
  { value: 'view_distance', label: 'Distance de vue (chunks)' },
  { value: 'simulation_distance', label: 'Distance de simulation (chunks)' },
  { value: 'max_players', label: 'Joueurs max' },
  { value: 'allow_flight', label: 'Vol autorisé (true/false)' },
  { value: 'difficulty', label: 'Difficulté (peaceful, easy, normal, hard)' },
  { value: 'game_mode', label: 'Mode de jeu par défaut (survival, creative…)' },
  { value: 'force_game_mode', label: 'Forcer le mode de jeu (true/false)' },
  { value: 'pause_when_empty_seconds', label: 'Pause quand vide (secondes, 0 = jamais)' },
  { value: 'player_idle_timeout', label: 'Expulsion des inactifs (minutes)' },
  { value: 'spawn_protection_radius', label: 'Rayon de protection du spawn' },
  { value: 'entity_broadcast_range', label: 'Portée d\'affichage des entités (%)' },
  { value: 'accept_transfers', label: 'Accepter les transferts (true/false)' },
  { value: 'motd', label: 'MOTD' }
]

const NOTIFICATIONS = [
  { value: 'players/joined', label: 'Un joueur se connecte' },
  { value: 'players/left', label: 'Un joueur se déconnecte' },
  { value: 'server/saving', label: 'Début de sauvegarde' },
  { value: 'server/saved', label: 'Fin de sauvegarde' },
  { value: 'server/started', label: 'Serveur démarré' },
  { value: 'server/stopping', label: 'Arrêt du serveur' },
  { value: 'gamerules/updated', label: 'Règle de jeu modifiée' },
  { value: 'any', label: 'N\'importe laquelle' }
]

/** Convertit le texte saisi vers le type attendu par le serveur (nombre, booléen, texte). */
function typed (value) {
  if (typeof value !== 'string') return value
  const v = value.trim()
  if (v === 'true' || v === 'false') return v === 'true'
  if (v !== '' && Number.isFinite(Number(v))) return Number(v)
  return v
}

async function manage (api, method, params) {
  const result = await api.manager.server.manage(method, params)
  api.locals.result = result
  const name = api.param('variable')
  if (name) api.setVar(name, result)
  return result
}

module.exports = [
  {
    type: 'server.rcon',
    category: 'Serveur',
    label: 'Commande RCON',
    description: 'Exécute une commande sur la console du serveur (préparation d\'un test : gamemode, tp, give, fill…). Variable : result (réponse du serveur).',
    outputs: DONE_FAILED,
    params: [
      { key: 'command', label: 'Commande (sans /)', type: 'string', default: 'gamemode creative {{ bot.username }}' },
      { ...RESULT_VAR, default: 'reponse' }
    ],
    async run (api) {
      const command = api.param('command')
      try {
        const response = await api.manager.server.runRcon(command)
        api.locals.result = response
        const name = api.param('variable')
        if (name) api.setVar(name, response)
        api.log(`RCON ${command} → ${response || '(pas de réponse)'}`, 'debug')
        return 'done'
      } catch (err) {
        api.log(`RCON ${command} : ${errorMessage(err)}`, 'warn')
        return 'failed'
      }
    }
  },
  {
    type: 'server.manage',
    category: 'Serveur',
    label: 'Gérer le serveur',
    description: 'Agit sur le serveur par le protocole de gestion (Minecraft 1.21.9+) : sauvegarde, message système, expulsion, règle de jeu ou réglage. Variable : result.',
    outputs: DONE_FAILED,
    params: [
      { key: 'action', label: 'Action', type: 'select', default: 'message', options: [
        { value: 'message', label: 'Message système à tous' },
        { value: 'save', label: 'Sauvegarder le monde' },
        { value: 'kick', label: 'Expulser un joueur' },
        { value: 'gamerule', label: 'Changer une règle de jeu' },
        { value: 'setting', label: 'Changer un réglage' },
        { value: 'read', label: 'Lire un réglage' },
        { value: 'call', label: 'Appeler une méthode' }
      ] },
      { key: 'text', label: 'Message / motif d\'expulsion', type: 'string', default: 'Test en cours' },
      { key: 'player', label: 'Joueur (expulsion)', type: 'string', default: '' },
      { key: 'setting', label: 'Réglage', type: 'select', default: 'view_distance', options: SETTINGS },
      { key: 'gamerule', label: 'Règle de jeu (ex. minecraft:keep_inventory)', type: 'string', default: 'minecraft:keep_inventory' },
      { key: 'value', label: 'Valeur', type: 'string', default: '' },
      { key: 'method', label: 'Méthode (appel libre)', type: 'string', default: 'minecraft:server/status' },
      { key: 'params', label: 'Paramètres JSON (appel libre)', type: 'json', default: '[]' },
      RESULT_VAR
    ],
    async run (api) {
      try {
        switch (api.param('action')) {
          case 'message':
            await manage(api, 'server/system_message', [{ message: { literal: api.param('text') }, overlay: false }])
            break
          case 'save':
            await manage(api, 'server/save', [true])
            break
          case 'kick': {
            const player = api.param('player')
            if (!player) throw new Error('joueur à expulser non renseigné')
            const kicked = await manage(api, 'players/kick', [[{ player: { name: player }, message: { literal: api.param('text') } }]])
            if (!kicked || !kicked.length) throw new Error(`${player} n'est pas connecté`)
            break
          }
          case 'gamerule':
            await manage(api, 'gamerules/update', [{ key: api.param('gamerule'), value: typed(api.param('value')) }])
            break
          case 'setting':
            await manage(api, `serversettings/${api.param('setting')}/set`, [typed(api.param('value'))])
            break
          case 'read':
            await manage(api, `serversettings/${api.param('setting')}`, [])
            break
          default: {
            const params = api.param('params')
            await manage(api, api.param('method'), params === null ? [] : params)
          }
        }
        return 'done'
      } catch (err) {
        api.log(`Gestion du serveur : ${errorMessage(err)}`, 'warn')
        return 'failed'
      }
    }
  },
  {
    type: 'event.server',
    category: 'Évènements',
    label: 'Notification du serveur',
    description: 'Quand le serveur signale un évènement par le protocole de gestion (1.21.9+) : connexion, sauvegarde… Variables : event.kind, event.player.',
    input: false,
    outputs: [{ name: 'out', label: '' }],
    params: [
      { key: 'kind', label: 'Notification', type: 'select', default: 'players/joined', options: NOTIFICATIONS },
      { key: 'ignoreBots', label: 'Ignorer les bots d\'Arthur\'s Bot', type: 'boolean', default: true }
    ],
    subscribe (api, fire) {
      const kind = api.param('kind')
      const ignoreBots = api.param('ignoreBots')
      const server = api.manager.server
      const handler = n => {
        if (!n.t) return // connexion / déconnexion du protocole lui-même
        if (kind !== 'any' && n.kind !== kind) return
        if (ignoreBots && n.player && api.manager.isManaged(n.player)) return
        fire({ kind: n.kind, player: n.player, label: n.label })
      }
      server.on('notification', handler)
      return () => server.removeListener('notification', handler)
    }
  },
  {
    type: 'test.serverSees',
    category: 'Tests',
    label: 'Vérifier : vu par le serveur',
    description: 'Vérifie que le serveur compte bien ce joueur parmi les connectés (protocole de gestion 1.21.9+). Détecte les connexions fantômes.',
    outputs: [{ name: 'pass', label: 'Réussi' }, { name: 'fail', label: 'Échoué' }],
    params: [
      { key: 'player', label: 'Joueur', type: 'string', default: '{{ bot.username }}' },
      { key: 'expect', label: 'Attendu', type: 'select', default: 'online', options: [
        { value: 'online', label: 'Connecté' }, { value: 'offline', label: 'Déconnecté' }
      ] },
      { key: 'timeout', label: 'Délai (ms)', type: 'number', default: 5000 }
    ],
    async run (api) {
      const server = api.manager.server
      const player = api.param('player')
      const want = api.param('expect') === 'online'
      const matches = () => {
        const list = server.serverPlayers()
        return list ? list.includes(player) === want : null
      }
      if (matches() === null) {
        api.report.assert(false, `${player} : protocole de gestion indisponible`, api.node.id)
        return 'fail'
      }
      if (!matches()) {
        await waitForEvent(server, 'state', { timeout: api.param('timeout'), signal: api.signal, filter: () => matches() === true })
      }
      const ok = matches() === true
      api.report.assert(ok, `${player} ${want ? 'connecté' : 'déconnecté'} côté serveur`, api.node.id)
      return ok ? 'pass' : 'fail'
    }
  }
]
