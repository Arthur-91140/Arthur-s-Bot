/* global U, state, $ */
'use strict'

// Outils du serveur testé : connexion RCON et protocole de gestion (Minecraft 1.21.9+),
// panneau de gestion (état, sauvegarde, message, réglages, règles de jeu) et console RCON.
// Chargé avant app.js : les fonctions utilisent state et $ au moment de l'appel.

// eslint-disable-next-line no-unused-vars -- utilisé par app.js
const ToolsUI = (() => {
  const h = U.h

  /** Réglages proposés dans le panneau de gestion (méthode serversettings/<clé>). */
  const SETTINGS = [
    ['view_distance', 'Distance de vue', 'number', 'chunks envoyés aux joueurs'],
    ['simulation_distance', 'Distance de simulation', 'number', 'chunks où le monde évolue'],
    ['max_players', 'Joueurs max', 'number'],
    ['pause_when_empty_seconds', 'Pause quand vide (s)', 'number', '0 = jamais : utile pour des mesures stables'],
    ['player_idle_timeout', 'Expulsion des inactifs (min)', 'number', '0 = jamais'],
    ['allow_flight', 'Vol autorisé', 'boolean', 'requis pour l\'explorateur volant hors créatif'],
    ['difficulty', 'Difficulté', ['peaceful', 'easy', 'normal', 'hard']],
    ['game_mode', 'Mode de jeu par défaut', ['survival', 'creative', 'adventure', 'spectator']],
    ['force_game_mode', 'Forcer le mode de jeu', 'boolean'],
    ['spawn_protection_radius', 'Protection du spawn (blocs)', 'number'],
    ['entity_broadcast_range', 'Portée des entités (%)', 'number'],
    ['accept_transfers', 'Accepter les transferts', 'boolean'],
    ['motd', 'MOTD', 'text']
  ]

  const QUICK_COMMANDS = ['list', 'time set day', 'weather clear', 'gamemode creative @a', 'kill @e[type=item]', 'save-all']

  let tab = 'connection'
  const consoleLines = []
  const commandHistory = U.store('rcon-history') || []
  let historyIndex = -1

  function tools () {
    return state.serverTools || { settings: { rcon: {}, management: {} }, rcon: {}, management: null }
  }

  /** Ligne d'état sous l'entrée du serveur (tableau de bord). */
  function statusLine () {
    const t = tools()
    const m = t.management
    const parts = []
    if (m) {
      if (m.connected) {
        const seen = m.players.length
        const bots = m.players.filter(p => state.bots.has(p)).length
        parts.push(h('span', { class: 'ok', title: m.players.join(', ') || 'aucun joueur' }, `gestion : ${seen} joueur${seen > 1 ? 's' : ''} vu${seen > 1 ? 's' : ''} par le serveur${bots ? ` (${bots} bot${bots > 1 ? 's' : ''})` : ''}`))
        if (m.saving) parts.push(h('span', { class: 'warn' }, 'sauvegarde en cours…'))
        else if (m.lastSave) parts.push(h('span', null, `sauvegardé à ${U.fmtTime(m.lastSave)}`))
      } else {
        parts.push(h('span', { class: 'warn', title: m.error || '' }, `gestion : ${m.error ? `hors ligne — ${m.error}` : 'connexion…'}`))
      }
    }
    if (t.settings.rcon && t.settings.rcon.enabled) parts.push(h('span', { class: 'ok' }, 'RCON prêt'))
    if (!parts.length) parts.push(h('span', null, 'RCON et protocole de gestion : non configurés'))
    return h('div', { class: 'server-tags tools-line' }, parts)
  }

  function open (which = null) {
    if (which) tab = which
    render()
    const d = $('tools-dialog')
    if (!d.open) d.showModal()
  }

  function render () {
    const d = $('tools-dialog')
    const body = U.clear(d.querySelector('.tools-body'))
    const tabs = U.clear(d.querySelector('.tools-tabs'))
    const items = [['connection', 'Connexion'], ['manage', 'Gestion du serveur'], ['console', 'Console RCON']]
    for (const [key, label] of items) {
      tabs.appendChild(h('button', { type: 'button', class: tab === key ? 'active' : null, onclick: () => { tab = key; render() } }, label))
    }
    if (tab === 'connection') renderConnection(body)
    else if (tab === 'manage') renderManage(body)
    else renderConsole(body)
  }

  /** Rafraîchit l'onglet ouvert quand l'état change (sans écraser une saisie en cours). */
  function onState () {
    const d = $('tools-dialog')
    if (!d || !d.open) return
    if (tab === 'manage' && !d.contains(document.activeElement)) renderManageStatus()
    if (tab === 'connection') renderConnectionStatus()
  }

  // --- Connexion ------------------------------------------------------------------

  function renderConnection (body) {
    const t = tools()
    const m = t.settings.management || {}
    const r = t.settings.rcon || {}
    const host = state.server ? state.server.host : 'localhost'
    const form = h('form', { class: 'tools-form', onsubmit: save },
      h('fieldset', null,
        h('legend', null, 'Protocole de gestion — Minecraft 1.21.9+'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mEnabled', checked: !!m.enabled }), h('span', null, 'Activer')),
        h('div', { class: 'row' },
          field('Hôte', h('input', { name: 'mHost', type: 'text', value: m.host || host }), 'grow'),
          field('Port', h('input', { name: 'mPort', type: 'number', value: m.port || '', placeholder: '25585' }), 'w120')),
        field('Secret', h('input', { name: 'mSecret', type: 'password', autocomplete: 'off', placeholder: m.hasSecret ? '•••••••• (inchangé)' : 'management-server-secret' })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'mTls', checked: m.tls !== false }), h('span', null, 'TLS (management-server-tls-enabled, activé par défaut)')),
        h('p', { class: 'muted tiny' }, 'Dans server.properties : management-server-enabled=true, management-server-port, et le secret généré par le serveur (management-server-secret). Donne les joueurs vus par le serveur, les connexions en direct, les sauvegardes, les réglages et les règles de jeu.')),
      h('fieldset', null,
        h('legend', null, 'RCON — toutes versions'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'rEnabled', checked: !!r.enabled }), h('span', null, 'Activer')),
        h('div', { class: 'row' },
          field('Hôte', h('input', { name: 'rHost', type: 'text', value: r.host || host }), 'grow'),
          field('Port', h('input', { name: 'rPort', type: 'number', value: r.port || 25575 }), 'w120')),
        field('Mot de passe', h('input', { name: 'rPassword', type: 'password', autocomplete: 'off', placeholder: r.hasPassword ? '•••••••• (inchangé)' : 'rcon.password' })),
        h('p', { class: 'muted tiny' }, 'Dans server.properties : enable-rcon=true, rcon.port et rcon.password. Sert aux commandes de préparation (graphes, campagnes, explorateur volant, déblocage du promeneur).')),
      h('div', { id: 'tools-conn-status', class: 'tools-status' }),
      h('div', { class: 'screen-actions' },
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', type: 'button', onclick: () => $('tools-dialog').close() }, 'Fermer'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer et connecter')))
    body.appendChild(form)
    renderConnectionStatus()
  }

  function renderConnectionStatus () {
    const box = $('tools-conn-status')
    if (!box) return
    const t = tools()
    const m = t.management
    U.add(U.clear(box),
      m
        ? h('div', { class: `alert ${m.connected ? 'ok' : 'warn'}` }, m.connected
          ? `Protocole de gestion connecté (${m.url}) — serveur ${m.version ? m.version.name : '?'}`
          : `Protocole de gestion : ${m.error || 'connexion en cours…'}`)
        : null,
      t.settings.rcon && t.settings.rcon.enabled
        ? h('div', { class: 'alert ok' }, `RCON configuré (${t.settings.rcon.host}:${t.settings.rcon.port}) — testez-le dans la console`)
        : null)
  }

  function field (label, input, cls = '') {
    return h('div', { class: `field ${cls}` }, h('label', null, label), input)
  }

  async function save (ev) {
    ev.preventDefault()
    const f = ev.target
    const body = {
      management: { enabled: f.mEnabled.checked, host: f.mHost.value.trim(), port: Number(f.mPort.value) || 0, tls: f.mTls.checked },
      rcon: { enabled: f.rEnabled.checked, host: f.rHost.value.trim(), port: Number(f.rPort.value) || 25575 }
    }
    if (f.mSecret.value) body.management.secret = f.mSecret.value
    if (f.rPassword.value) body.rcon.password = f.rPassword.value
    try {
      state.serverTools = await U.api('PUT', '/api/server-tools', body)
      U.toast('Réglages enregistrés', 'success')
      render()
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  // --- Gestion ---------------------------------------------------------------------

  function renderManage (body) {
    const m = tools().management
    if (!m || !m.connected) {
      body.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, 'Protocole de gestion non connecté'),
        h('p', null, 'Il demande un serveur Minecraft 1.21.9 ou plus récent, avec management-server-enabled=true. Renseignez son port et son secret dans l\'onglet Connexion.'),
        h('button', { class: 'btn', onclick: () => { tab = 'connection'; render() } }, 'Configurer')))
      return
    }
    body.appendChild(h('div', { id: 'tools-manage-status' }))
    renderManageStatus()
    const message = h('input', { type: 'text', placeholder: 'Message système à tous les joueurs' })
    body.appendChild(h('div', { class: 'tools-actions' },
      h('button', { class: 'btn', onclick: () => call('server/save', [true], 'Sauvegarde demandée') }, 'Sauvegarder le monde'),
      message,
      h('button', {
        class: 'btn',
        onclick: () => {
          if (!message.value.trim()) return
          call('server/system_message', [{ message: { literal: message.value.trim() }, overlay: false }], 'Message envoyé')
          message.value = ''
        }
      }, 'Envoyer')))
    const settingsBox = h('div', { class: 'tools-settings' }, h('div', { class: 'muted small' }, 'Lecture des réglages…'))
    body.appendChild(h('h4', null, 'Réglages du serveur'))
    body.appendChild(settingsBox)
    loadSettings(settingsBox)
    const rulesBox = h('div', { class: 'tools-rules' }, h('div', { class: 'muted small' }, 'Lecture des règles de jeu…'))
    const filter = h('input', { type: 'search', placeholder: 'Filtrer les règles…', oninput: () => filterRules(rulesBox, filter.value) })
    body.appendChild(h('div', { class: 'row tools-rules-head' }, h('h4', { class: 'grow' }, 'Règles de jeu'), filter))
    body.appendChild(rulesBox)
    loadRules(rulesBox)
  }

  function renderManageStatus () {
    const box = $('tools-manage-status')
    if (!box) return
    const m = tools().management
    if (!m) return
    U.add(U.clear(box),
      h('div', { class: 'tools-summary' },
        h('span', null, `Serveur ${m.version ? `${m.version.name} (protocole ${m.version.protocol})` : '?'}`),
        h('span', { class: m.started ? 'ok' : 'warn' }, m.started ? 'démarré' : 'arrêté'),
        h('span', null, `${m.joinsPerMinute} connexion${m.joinsPerMinute > 1 ? 's' : ''} dans la dernière minute`),
        m.saving ? h('span', { class: 'warn' }, 'sauvegarde en cours…') : m.lastSave ? h('span', null, `dernière sauvegarde ${U.fmtTime(m.lastSave)}`) : null),
      h('div', { class: 'tools-players' },
        m.players.length
          ? m.players.map(p => h('span', { class: `player-chip${state.bots.has(p) ? ' bot' : ''}`, title: state.bots.has(p) ? 'Bot d\'Arthur\'s Bot' : 'Joueur' }, U.faceImg(p, 16), p))
          : h('span', { class: 'muted small' }, 'Aucun joueur connecté selon le serveur.')))
  }

  async function call (method, params, success) {
    try {
      const res = await U.api('POST', '/api/management/call', { method, params })
      if (success) U.toast(success, 'success')
      return res.result
    } catch (err) {
      U.toast(err.message, 'error')
      throw err
    }
  }

  async function loadSettings (box) {
    const rows = []
    for (const [key, label, type, help] of SETTINGS) {
      let value
      try {
        value = (await U.api('POST', '/api/management/call', { method: `serversettings/${key}`, params: [] })).result
      } catch (err) {
        continue
      }
      let input
      if (type === 'boolean') input = h('input', { type: 'checkbox', checked: !!value })
      else if (Array.isArray(type)) input = h('select', null, type.map(v => h('option', { value: v, selected: v === value ? 'selected' : null }, v)))
      else input = h('input', { type: type === 'number' ? 'number' : 'text', value: typeof value === 'object' ? JSON.stringify(value) : value })
      const apply = h('button', {
        class: 'btn small',
        onclick: async () => {
          const v = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value
          try {
            const res = await call(`serversettings/${key}/set`, [v])
            U.toast(`${label} : ${JSON.stringify(res)}`, 'success')
          } catch (err) { /* déjà signalé */ }
        }
      }, 'Appliquer')
      rows.push(h('div', { class: 'tools-setting' }, h('div', { class: 'grow' }, h('div', null, label), help ? h('small', { class: 'muted' }, help) : null), input, apply))
    }
    U.add(U.clear(box), rows.length ? rows : h('div', { class: 'muted small' }, 'Aucun réglage lisible.'))
  }

  async function loadRules (box) {
    let rules
    try {
      rules = (await U.api('POST', '/api/management/call', { method: 'gamerules', params: [] })).result || []
    } catch (err) {
      U.add(U.clear(box), h('div', { class: 'alert error' }, err.message))
      return
    }
    rules.sort((a, b) => a.key.localeCompare(b.key))
    U.add(U.clear(box), rules.map(r => {
      const input = r.type === 'boolean'
        ? h('input', { type: 'checkbox', checked: !!r.value })
        : h('input', { type: 'number', value: r.value, class: 'w90' })
      const send = async () => {
        const value = r.type === 'boolean' ? input.checked : Number(input.value)
        try {
          await call('gamerules/update', [{ key: r.key, value }])
          U.toast(`${r.key.replace('minecraft:', '')} = ${value}`, 'success')
        } catch (err) { /* déjà signalé */ }
      }
      input.addEventListener('change', send)
      return h('label', { class: 'tools-rule', title: r.key, dataset: { key: r.key } }, h('span', { class: 'grow mono' }, r.key.replace('minecraft:', '')), input)
    }))
  }

  function filterRules (box, text) {
    const q = text.trim().toLowerCase()
    for (const el of box.children) el.hidden = q && !el.dataset.key.toLowerCase().includes(q)
  }

  // --- Console RCON --------------------------------------------------------------------

  function renderConsole (body) {
    const t = tools()
    if (!t.settings.rcon || !t.settings.rcon.enabled) {
      body.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, 'RCON désactivé'),
        h('p', null, 'Activez enable-rcon=true dans server.properties, puis renseignez le port et le mot de passe dans l\'onglet Connexion.'),
        h('button', { class: 'btn', onclick: () => { tab = 'connection'; render() } }, 'Configurer')))
      return
    }
    const out = h('div', { class: 'rcon-out mono', id: 'rcon-out' })
    for (const l of consoleLines) out.appendChild(rconLine(l))
    const input = h('input', { type: 'text', class: 'grow mono', placeholder: 'Commande (sans /), ↑ pour l\'historique', autocomplete: 'off' })
    const send = async cmd => {
      const command = String(cmd || input.value).trim().replace(/^\//, '')
      if (!command) return
      input.value = ''
      historyIndex = -1
      if (commandHistory[commandHistory.length - 1] !== command) commandHistory.push(command)
      while (commandHistory.length > 50) commandHistory.shift()
      U.store('rcon-history', commandHistory)
      push({ kind: 'cmd', text: command })
      try {
        const res = await U.api('POST', '/api/rcon', { command })
        push({ kind: 'res', text: res.response || '(pas de réponse)' })
      } catch (err) {
        push({ kind: 'err', text: err.message })
      }
    }
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        send()
      } else if (ev.key === 'ArrowUp' && commandHistory.length) {
        ev.preventDefault()
        historyIndex = historyIndex < 0 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1)
        input.value = commandHistory[historyIndex]
      } else if (ev.key === 'ArrowDown' && historyIndex >= 0) {
        ev.preventDefault()
        historyIndex = Math.min(commandHistory.length, historyIndex + 1)
        input.value = commandHistory[historyIndex] || ''
        if (historyIndex >= commandHistory.length) historyIndex = -1
      }
    })
    U.add(body,
      h('div', { class: 'rcon-quick' }, QUICK_COMMANDS.map(c => h('button', { class: 'btn small', onclick: () => send(c) }, c))),
      out,
      h('div', { class: 'row' }, h('span', { class: 'prompt' }, '>'), input, h('button', { class: 'btn primary', onclick: () => send() }, 'Exécuter')))
    out.scrollTop = out.scrollHeight
    requestAnimationFrame(() => input.focus())
  }

  function rconLine (l) {
    return h('div', { class: `rcon-line ${l.kind}` }, l.kind === 'cmd' ? `> ${l.text}` : l.text)
  }

  function push (line) {
    consoleLines.push(line)
    while (consoleLines.length > 300) consoleLines.shift()
    const out = $('rcon-out')
    if (out) {
      out.appendChild(rconLine(line))
      out.scrollTop = out.scrollHeight
    }
  }

  return { open, statusLine, onState }
})()
