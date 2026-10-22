'use strict'

const { toRegExp, waitForEvent, errorMessage } = require('../../core/utils')

const OUT = [{ name: 'out', label: '' }]

function listen (api, event, handler) {
  const events = api.instance.events
  events.on(event, handler)
  return () => events.removeListener(event, handler)
}

const FORMATS = [
  { value: 'text', label: 'Texte UTF-8' },
  { value: 'utf-list', label: 'Chaînes Java (BungeeCord), une par ligne' },
  { value: 'json', label: 'JSON' },
  { value: 'hex', label: 'Hexadécimal' }
]

module.exports = [
  {
    type: 'event.dialog',
    category: 'Protocole',
    label: 'Boîte de dialogue reçue',
    description: 'Quand le serveur ouvre une boîte de dialogue (Minecraft 1.21.6+, commande /dialog ou plugin). Variables : event.title, event.type, event.body, event.buttons (libellés), event.inputs.',
    input: false,
    outputs: OUT,
    params: [{ key: 'title', label: 'Titre (regex, vide = toutes)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = api.param('title') ? toRegExp(api.param('title')) : null
      return listen(api, 'dialog', d => {
        if (!re || re.test(d.title)) fire(d)
      })
    }
  },
  {
    type: 'action.dialog',
    category: 'Protocole',
    label: 'Répondre à la boîte de dialogue',
    description: 'Clique sur un bouton de la boîte de dialogue ouverte, après avoir rempli ses champs. Gère les commandes et les actions personnalisées (custom_click_action).',
    outputs: [{ name: 'done', label: 'Cliqué' }, { name: 'none', label: 'Pas de dialogue / bouton' }],
    params: [
      { key: 'button', label: 'Bouton (libellé ou numéro, 0 = premier)', type: 'string', default: '0' },
      { key: 'values', label: 'Champs à remplir (JSON { "clé": valeur })', type: 'json', default: '{}' },
      { key: 'wait', label: 'Attendre un dialogue (ms, 0 = non)', type: 'number', default: 0 }
    ],
    async run (api) {
      const instance = api.instance
      if (!instance.protocol.dialog && api.param('wait') > 0) {
        await waitForEvent(instance.events, 'dialog', { timeout: api.param('wait'), signal: api.signal })
      }
      if (!instance.protocol.dialog) return 'none'
      try {
        const res = instance.dialogClick(api.param('button'), api.param('values') || {})
        api.locals.result = res
        return 'done'
      } catch (err) {
        api.log(errorMessage(err), 'warn')
        return 'none'
      }
    }
  },
  {
    type: 'event.serverInfo',
    category: 'Protocole',
    label: 'Information du serveur reçue',
    description: 'Code de conduite (1.21.9+), liens du serveur et détails de rapport (1.21+) envoyés par le serveur. Variables : event.text, event.links, event.details.',
    input: false,
    outputs: OUT,
    params: [{ key: 'kind', label: 'Information', type: 'select', default: 'codeOfConduct', options: [
      { value: 'codeOfConduct', label: 'Code de conduite' },
      { value: 'serverLinks', label: 'Liens du serveur' },
      { value: 'reportDetails', label: 'Détails de rapport' }
    ] }],
    subscribe (api, fire) {
      return listen(api, api.param('kind'), payload => fire(payload))
    }
  },
  {
    type: 'event.transfer',
    category: 'Protocole',
    label: 'Transfert demandé',
    description: 'Quand le serveur envoie le bot vers un autre serveur (paquet de transfert, 1.20.5+). Le bot le suit si l\'option « Suivre les transferts » est active. Variables : event.host, event.port.',
    input: false,
    outputs: OUT,
    subscribe: (api, fire) => listen(api, 'transfer', payload => fire(payload))
  },
  {
    type: 'event.pluginMessage',
    category: 'Protocole',
    label: 'Message de plugin reçu',
    description: 'Message sur un canal de plugin (custom_payload). Variables : event.channel, event.text, event.strings (format BungeeCord), event.hex, event.size.',
    input: false,
    outputs: OUT,
    params: [{ key: 'channel', label: 'Canal (regex, ex. bungeecord:main)', type: 'string', default: '' }],
    subscribe (api, fire) {
      const re = api.param('channel') ? toRegExp(api.param('channel')) : null
      return listen(api, 'pluginMessage', m => {
        if (!re || re.test(m.channel)) fire(m)
      })
    }
  },
  {
    type: 'action.pluginMessage',
    category: 'Protocole',
    label: 'Envoyer un message de plugin',
    description: 'Envoie des données sur un canal de plugin, pour tester la messagerie entre votre plugin et le client (ex. BungeeCord, canaux personnalisés).',
    outputs: [{ name: 'done', label: 'Envoyé' }, { name: 'failed', label: 'Échec' }],
    params: [
      { key: 'channel', label: 'Canal', type: 'string', default: 'bungeecord:main' },
      { key: 'format', label: 'Format', type: 'select', default: 'utf-list', options: FORMATS },
      { key: 'data', label: 'Données', type: 'text', default: 'GetServer' },
      { key: 'register', label: 'Déclarer le canal avant (minecraft:register)', type: 'boolean', default: false }
    ],
    run (api) {
      try {
        api.instance.sendPluginMessage(api.param('channel'), api.param('data'), api.param('format'), api.param('register'))
        return 'done'
      } catch (err) {
        api.log(`Message de plugin : ${errorMessage(err)}`, 'warn')
        return 'failed'
      }
    }
  }
]
