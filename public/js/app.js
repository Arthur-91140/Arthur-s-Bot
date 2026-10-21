/* Tableau de bord : bots, fiche détaillée, rapports, journal, aide. */
'use strict'
/* global U, io, GraphEditor */

const { h } = U

const STATUS_LABEL = {
  online: 'En jeu',
  connecting: 'Connexion…',
  spawning: 'Apparition…',
  reconnecting: 'Reconnexion…',
  offline: 'Hors ligne'
}

const state = {
  info: null,
  bots: new Map(),
  selected: new Set(),
  openBot: null,
  drawerTab: U.store('drawer-tab') || 'console',
  graphs: [],
  reports: new Map(),
  openReport: null,
  logs: [],
  logPaused: false
}

let editor = null

// --- Onglets ---------------------------------------------------------------

function showTab (name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`))
  U.store('tab', name)
  if (name === 'editor' && editor) requestAnimationFrame(() => editor.renderLinks())
  if (name === 'logs') renderLogs()
  if (name === 'reports') loadReports()
}

// --- Serveur et création de bots -------------------------------------------------

function serverSettings () {
  return {
    host: document.getElementById('srv-host').value.trim() || 'localhost',
    port: Number(document.getElementById('srv-port').value) || 25565,
    version: document.getElementById('srv-version').value || 'auto'
  }
}

function saveServerSettings () {
  U.store('server', serverSettings())
}

async function ping () {
  const out = document.getElementById('ping-result')
  const s = serverSettings()
  U.clear(out).appendChild(h('div', { class: 'muted' }, 'Ping en cours…'))
  try {
    const r = await U.api('GET', `/api/ping?host=${encodeURIComponent(s.host)}&port=${s.port}`)
    U.clear(out)
    if (!r.online) {
      out.appendChild(h('div', { class: 'alert error' }, `Serveur injoignable : ${r.error}`))
      return
    }
    out.appendChild(h('div', { class: 'ping-card' },
      r.favicon ? h('img', { src: r.favicon, class: 'favicon', alt: '' }) : null,
      h('div', null,
        h('div', { class: 'motd' }, r.motd || '(pas de MOTD)'),
        h('div', { class: 'muted small' },
          `${r.version} • protocole ${r.protocol} • ${r.players ? `${r.players.online}/${r.players.max} joueurs` : '?'} • ${r.latency} ms`),
        r.supported
          ? h('div', { class: 'ok small' }, `✔ Version supportée par les bots (${r.botVersion})`)
          : h('div', { class: 'warn small' }, '⚠ Protocole non reconnu : essayez une version proche ou ViaVersion côté serveur'),
        r.modded ? h('div', { class: 'warn small' }, 'Serveur moddé (Forge/Fabric) : les mods côté client ne sont pas émulés.') : null)))
  } catch (err) {
    U.clear(out).appendChild(h('div', { class: 'alert error' }, err.message))
  }
}

async function createBots (ev) {
  ev.preventDefault()
  const f = ev.target
  const s = serverSettings()
  const count = Number(f.count.value) || 1
  const body = {
    ...s,
    username: f.username.value.trim(),
    namePattern: f.username.value.trim(),
    count,
    joinDelay: Number(f.joinDelay.value) || 0,
    auth: f.auth.value,
    mode: f.mode.value,
    autoReconnect: f.autoReconnect.checked,
    graph: f.graph.value || undefined,
    plugins: {
      autoRespawn: f.autoRespawn.checked,
      autoEat: f.autoEat.checked,
      autoArmor: f.autoArmor.checked,
      acceptResourcePack: f.acceptResourcePack.checked,
      authme: { enabled: f.authme.checked, password: f.authmePassword.value }
    }
  }
  if (!body.username) return U.toast('Indiquez un pseudo ou un motif (ex. Bot_{i})', 'warn')
  U.store('create-form', { username: body.username, count, joinDelay: body.joinDelay, auth: body.auth, mode: body.mode })
  try {
    const res = await U.api('POST', '/api/bots', body)
    if (res.created.length) U.toast(`${res.created.length} bot(s) créé(s)`, 'success')
    for (const e of res.errors) U.toast(e, 'error', 6000)
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

function fillSelects () {
  const versionSel = document.getElementById('srv-version')
  U.clear(versionSel)
  versionSel.appendChild(h('option', { value: 'auto' }, 'Auto (détection)'))
  for (const v of state.info.minecraft.versions) versionSel.appendChild(h('option', { value: v }, v))
  for (const id of ['create-mode', 'bulk-mode']) {
    const sel = document.getElementById(id)
    U.clear(sel)
    if (id === 'bulk-mode') sel.appendChild(h('option', { value: '' }, 'Mode…'))
    for (const m of state.info.modes) sel.appendChild(h('option', { value: m.name, title: m.description }, `${m.label}`))
  }
  const saved = U.store('server') || state.info.defaults.server
  document.getElementById('srv-host').value = saved.host
  document.getElementById('srv-port').value = saved.port
  versionSel.value = saved.version || 'auto'
  const form = U.store('create-form')
  const f = document.getElementById('create-form')
  if (form) {
    f.username.value = form.username
    f.count.value = form.count
    f.joinDelay.value = form.joinDelay
    f.auth.value = form.auth
    f.mode.value = form.mode
  } else {
    f.joinDelay.value = state.info.defaults.swarm.joinDelay
  }
  const p = state.info.defaults.bot.plugins
  f.autoRespawn.checked = p.autoRespawn
  f.autoEat.checked = p.autoEat
  f.autoArmor.checked = p.autoArmor
  f.acceptResourcePack.checked = p.acceptResourcePack
  f.authme.checked = p.authme.enabled
  f.authmePassword.value = p.authme.password
  f.autoReconnect.checked = state.info.defaults.bot.autoReconnect
}

function fillGraphSelects () {
  for (const id of ['create-graph', 'bulk-graph']) {
    const sel = document.getElementById(id)
    const current = sel.value
    U.clear(sel)
    sel.appendChild(h('option', { value: '' }, id === 'create-graph' ? 'Aucun' : 'Graphe…'))
    for (const g of state.graphs) sel.appendChild(h('option', { value: g.id }, g.name))
    sel.value = current
  }
}

async function loadGraphs () {
  try {
    state.graphs = await U.api('GET', '/api/graphs')
    fillGraphSelects()
    if (editor) editor.setGraphs(state.graphs)
    if (state.openBot) renderDrawer()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

// --- Cartes des bots ---------------------------------------------------------------

function bar (value, max, cls) {
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, (value / max) * 100))
  return h('div', { class: `bar ${cls}` }, h('div', { class: 'fill', style: { width: `${pct}%` } }), h('span', null, value ?? '-'))
}

function botCard (b) {
  const pos = b.position ? `${b.position.x} ${b.position.y} ${b.position.z}` : '—'
  const running = b.runtimes.filter(r => r.status === 'running').length
  return h('div', {
    class: `bot-card ${b.status}${state.selected.has(b.id) ? ' selected' : ''}${state.openBot === b.id ? ' open' : ''}`,
    dataset: { id: b.id },
    onclick: ev => {
      if (ev.target.closest('button, input')) return
      openDrawer(b.id)
    }
  },
  h('div', { class: 'card-head' },
    h('input', {
      type: 'checkbox',
      checked: state.selected.has(b.id),
      title: 'Sélectionner',
      onchange: ev => {
        if (ev.target.checked) state.selected.add(b.id)
        else state.selected.delete(b.id)
        renderBots()
      }
    }),
    h('span', { class: 'bot-name' }, b.id),
    h('span', { class: `pill ${b.status}` }, STATUS_LABEL[b.status] || b.status)),
  h('div', { class: 'bars' }, bar(b.health, 20, 'health'), bar(b.food, 20, 'food')),
  h('div', { class: 'card-line muted small' }, `📍 ${pos}`, b.dimension ? ` • ${b.dimension}` : ''),
  h('div', { class: 'card-line muted small' },
    `${b.version || 'auto'}`, b.ping !== null ? ` • ${b.ping} ms` : '', b.tps !== null ? ` • TPS ${b.tps}` : '', b.gameMode ? ` • ${b.gameMode}` : ''),
  h('div', { class: 'card-line small' }, h('span', { class: 'mode-tag' }, b.modeLabel), running ? h('span', { class: 'graph-tag' }, `⚙ ${running} graphe(s)`) : null),
  b.msaCode ? h('div', { class: 'alert warn small' }, `Microsoft : ${b.msaCode.uri} code ${b.msaCode.code}`) : null,
  b.status === 'offline' && (b.lastKick || b.lastError)
    ? h('div', { class: 'card-line error small', title: (b.lastKick && b.lastKick.reason) || b.lastError }, `⚠ ${((b.lastKick && b.lastKick.reason) || b.lastError).slice(0, 90)}`)
    : null,
  h('div', { class: 'card-actions' },
    b.status === 'offline'
      ? h('button', { class: 'btn small success', onclick: () => botAction(b.id, 'connect') }, 'Connecter')
      : h('button', { class: 'btn small', onclick: () => botAction(b.id, 'disconnect') }, 'Déconnecter'),
    h('button', { class: 'btn small', onclick: () => openDrawer(b.id) }, 'Détails'),
    h('button', { class: 'btn small danger-ghost', title: 'Supprimer', onclick: () => removeBot(b.id) }, '✕')))
}

function renderBots () {
  const grid = document.getElementById('bots-grid')
  const bots = [...state.bots.values()]
  for (const id of [...state.selected]) if (!state.bots.has(id)) state.selected.delete(id)
  U.clear(grid)
  if (!bots.length) {
    grid.appendChild(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '🤖'),
      h('p', null, 'Aucun bot pour l\'instant.'),
      h('p', { class: 'muted' }, 'Renseignez le serveur à gauche puis créez un bot ou un essaim (motif « Bot_{i} » + nombre).')))
  }
  for (const b of bots) grid.appendChild(botCard(b))
  const online = bots.filter(b => b.status === 'online').length
  document.getElementById('bots-count').textContent = `${bots.length} bot(s) • ${online} en jeu • ${state.selected.size} sélectionné(s)`
  document.getElementById('select-all').checked = bots.length > 0 && state.selected.size === bots.length
}

async function botAction (id, action, payload = {}) {
  try {
    return await U.api('POST', `/api/bots/${encodeURIComponent(id)}/${action}`, payload)
  } catch (err) {
    U.toast(err.message, 'error')
    return null
  }
}

async function removeBot (id) {
  try {
    await U.api('DELETE', `/api/bots/${encodeURIComponent(id)}`)
    state.selected.delete(id)
    if (state.openBot === id) closeDrawer()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

function bulkTargets () {
  return state.selected.size ? [...state.selected] : 'all'
}

async function bulk (action, payload = {}) {
  const targets = bulkTargets()
  if (action === 'remove' && !confirm(targets === 'all' ? 'Supprimer TOUS les bots ?' : `Supprimer ${targets.length} bot(s) ?`)) return
  try {
    const res = await U.api('POST', '/api/bulk', { targets, action, ...payload })
    const failed = res.results ? Object.entries(res.results).filter(([, r]) => !r.ok) : []
    U.toast(`${action} : ${res.count - failed.length}/${res.count}`, failed.length ? 'warn' : 'success')
    for (const [id, r] of failed.slice(0, 3)) U.toast(`${id} : ${r.error}`, 'error')
    if (action === 'remove') state.selected.clear()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

// --- Fiche d'un bot (tiroir) ------------------------------------------------------

function openDrawer (id) {
  state.openBot = id
  document.getElementById('drawer').classList.remove('hidden')
  renderDrawer(true)
  renderBots()
}

function closeDrawer () {
  state.openBot = null
  document.getElementById('drawer').classList.add('hidden')
  renderBots()
}

async function renderDrawer (full = false) {
  const b = state.bots.get(state.openBot)
  const drawer = document.getElementById('drawer')
  if (!b) {
    closeDrawer()
    return
  }
  const head = drawer.querySelector('.drawer-head')
  U.add(U.clear(head),
    h('div', null,
      h('div', { class: 'drawer-title' }, b.id, ' ', h('span', { class: `pill ${b.status}` }, STATUS_LABEL[b.status] || b.status)),
      h('div', { class: 'muted small' },
        `${b.host}:${b.port} • ${b.version || 'auto'} • auth ${b.auth === 'microsoft' ? 'Microsoft' : 'hors ligne'}`,
        b.uptime ? ` • en ligne depuis ${U.fmtDuration(b.uptime)}` : '')),
    h('button', { class: 'btn icon', onclick: closeDrawer, title: 'Fermer' }, '✕'))

  const stats = drawer.querySelector('.drawer-stats')
  const s = b.stats
  U.add(U.clear(stats),
    h('div', { class: 'bars' }, bar(b.health, 20, 'health'), bar(b.food, 20, 'food')),
    h('div', { class: 'stat-grid' },
      stat('Position', b.position ? `${b.position.x} ${b.position.y} ${b.position.z}` : '—'),
      stat('Regard', b.yaw !== null ? `${b.yaw}° / ${b.pitch}°` : '—'),
      stat('Monde', b.dimension || '—'),
      stat('Jeu', b.gameMode || '—'),
      stat('Ping', b.ping !== null ? `${b.ping} ms` : '—'),
      stat('TPS estimé', b.tps ?? '—'),
      stat('Joueurs', b.players ?? '—'),
      stat('En main', b.heldItem || '—'),
      stat('Menu ouvert', b.window || '—'),
      stat('Connexions', `${s.connections} (${s.reconnects} reco.)`),
      stat('Morts / kicks', `${s.deaths} / ${s.kicks}`),
      stat('Login', s.lastLoginMs ? `${s.lastLoginMs} ms` : '—'),
      stat('Messages', s.messages),
      stat('Téléportations', s.setbacks)),
    b.lastKick ? h('div', { class: 'alert warn small' }, `Dernier kick : ${b.lastKick.reason}`) : null,
    b.lastError ? h('div', { class: 'alert error small' }, `Dernière erreur : ${b.lastError}`) : null)

  const tabs = drawer.querySelector('.drawer-tabs')
  const names = { console: 'Console', controls: 'Contrôles', mode: 'Mode', inventory: 'Inventaire', gui: 'Menu', graphs: 'Comportements', plugins: 'Plugins', logs: 'Journal' }
  U.clear(tabs)
  for (const [key, label] of Object.entries(names)) {
    tabs.appendChild(h('button', {
      class: state.drawerTab === key ? 'active' : '',
      onclick: () => {
        state.drawerTab = key
        U.store('drawer-tab', key)
        renderDrawer(true)
      }
    }, label))
  }
  if (!full) {
    // rafraîchissements légers sans reconstruire les formulaires
    if (state.drawerTab === 'graphs') renderDrawerGraphs(drawer.querySelector('.drawer-body'), b)
    return
  }
  const body = U.clear(drawer.querySelector('.drawer-body'))
  switch (state.drawerTab) {
    case 'console': return renderConsole(body, b)
    case 'controls': return renderControls(body, b)
    case 'mode': return renderMode(body, b)
    case 'inventory': return renderInventory(body, b)
    case 'gui': return renderGui(body, b)
    case 'graphs': return renderDrawerGraphs(body, b)
    case 'plugins': return renderPlugins(body, b)
    case 'logs': return renderBotLogs(body, b)
  }
}

function stat (label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'muted tiny' }, label), h('span', null, String(value)))
}

function chatLine (c) {
  return h('div', { class: `chat-line ${c.type}` }, h('span', { class: 'time' }, U.fmtTime(c.t)), c.type === 'self' ? '» ' : '', c.message)
}

async function renderConsole (body, b) {
  const list = h('div', { class: 'chat-list', id: 'chat-list' })
  const input = h('input', { type: 'text', placeholder: 'Message ou /commande — Entrée pour envoyer, ↑ pour l\'historique' })
  const history = U.store('chat-history') || []
  let hIndex = history.length
  const send = async () => {
    const message = input.value
    if (!message.trim()) return
    history.push(message)
    if (history.length > 50) history.shift()
    U.store('chat-history', history)
    hIndex = history.length
    input.value = ''
    await botAction(b.id, 'chat', { message })
  }
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') send()
    if (ev.key === 'ArrowUp' && hIndex > 0) { input.value = history[--hIndex]; ev.preventDefault() }
    if (ev.key === 'ArrowDown') { input.value = hIndex < history.length - 1 ? history[++hIndex] : ''; hIndex = Math.min(hIndex, history.length) }
  })
  const allBots = h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'chat-all' }), h('span', null, 'Envoyer avec tous les bots sélectionnés'))
  U.add(body, list, h('div', { class: 'row' }, input, h('button', {
    class: 'btn primary',
    onclick: async () => {
      if (document.getElementById('chat-all').checked) {
        await bulk('chat', { message: input.value })
        input.value = ''
      } else send()
    }
  }, 'Envoyer')), allBots)
  try {
    const chat = await U.api('GET', `/api/bots/${encodeURIComponent(b.id)}/chat?limit=200`)
    for (const c of chat) list.appendChild(chatLine(c))
    list.scrollTop = list.scrollHeight
  } catch (err) {
    list.appendChild(h('div', { class: 'muted' }, err.message))
  }
  input.focus()
}

function holdButton (label, control, b) {
  const start = ev => { ev.preventDefault(); botAction(b.id, 'control', { control, state: true }) }
  const stop = () => botAction(b.id, 'control', { control, state: false })
  return h('button', { class: 'btn pad', onmousedown: start, onmouseup: stop, onmouseleave: ev => { if (ev.buttons) stop() }, ontouchstart: start, ontouchend: stop }, label)
}

function renderControls (body, b) {
  const num = (id, ph, value = '') => h('input', { id, type: 'number', placeholder: ph, value, class: 'num' })
  const pos = b.position || { x: 0, y: 64, z: 0 }
  U.add(body,
    h('h4', null, 'Déplacement (maintenir)'),
    h('div', { class: 'pad-grid' },
      h('span'), holdButton('▲', 'forward', b), h('span'),
      holdButton('◀', 'left', b), holdButton('▼', 'back', b), holdButton('▶', 'right', b)),
    h('div', { class: 'row' }, holdButton('Saut', 'jump', b), holdButton('Accroupi', 'sneak', b), holdButton('Sprint', 'sprint', b),
      h('button', { class: 'btn danger', onclick: () => botAction(b.id, 'stop') }, 'Stop')),
    h('h4', null, 'Aller à'),
    h('div', { class: 'row' }, num('g-x', 'X', Math.round(pos.x)), num('g-y', 'Y (vide=ignorer)', Math.round(pos.y)), num('g-z', 'Z', Math.round(pos.z)),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const y = document.getElementById('g-y').value
          botAction(b.id, 'goto', { x: Number(document.getElementById('g-x').value), y: y === '' ? null : Number(y), z: Number(document.getElementById('g-z').value) })
        }
      }, 'Y aller')),
    h('div', { class: 'row' }, h('input', { id: 'g-player', type: 'text', placeholder: 'Pseudo du joueur' }),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'gotoPlayer', { player: document.getElementById('g-player').value }) }, 'Rejoindre')),
    h('h4', null, 'Regard (degrés F3)'),
    h('div', { class: 'row' }, num('l-yaw', 'Yaw', b.yaw ?? 0), num('l-pitch', 'Pitch', b.pitch ?? 0),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'look', { yaw: document.getElementById('l-yaw').value, pitch: document.getElementById('l-pitch').value }) }, 'Tourner')),
    h('h4', null, 'Actions'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: async () => { const r = await botAction(b.id, 'attack', { kind: 'hostile' }); if (r) U.toast(r.target ? `Attaque ${r.target}` : 'Aucun monstre proche') } }, 'Attaquer un monstre'),
      h('button', { class: 'btn', onclick: async () => { const r = await botAction(b.id, 'attack', { kind: 'player' }); if (r) U.toast(r.target ? `Attaque ${r.target}` : 'Aucun joueur proche') } }, 'Attaquer un joueur'),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'useItem') }, 'Utiliser l\'objet'),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'swing') }, 'Agiter le bras'),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'armor') }, 'Équiper l\'armure'),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'respawn') }, 'Réapparaître'),
      h('button', { class: 'btn', onclick: () => botAction(b.id, 'reconnect') }, 'Reconnecter'),
      h('button', { class: 'btn danger-ghost', onclick: () => { if (confirm('Jeter tout l\'inventaire ?')) botAction(b.id, 'dropAll') } }, 'Tout jeter')))
}

function renderMode (body, b) {
  const select = h('select', null, state.info.modes.map(m => h('option', { value: m.name, selected: m.name === b.mode.name ? 'selected' : null }, `${m.label} — ${m.category}`)))
  const form = h('div', { class: 'mode-form' })
  let options = { ...b.mode.options }
  const renderForm = () => {
    const def = state.info.modes.find(m => m.name === select.value)
    U.clear(form)
    if (select.value !== b.mode.name) options = {}
    form.appendChild(h('p', { class: 'muted' }, def.description))
    if (!def.options.length) form.appendChild(h('p', { class: 'muted small' }, 'Aucune option.'))
    for (const o of def.options) form.appendChild(U.paramInput(o, options[o.key], v => { options[o.key] = v }))
  }
  select.addEventListener('change', renderForm)
  renderForm()
  U.add(body, h('div', { class: 'field' }, h('label', null, 'Mode prédéfini'), select), form,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { if (await botAction(b.id, 'mode', { mode: select.value, options })) U.toast('Mode appliqué', 'success') } }, 'Appliquer'),
      h('button', { class: 'btn', onclick: () => bulk('mode', { mode: select.value, options }) }, 'Appliquer à la sélection')))
}

async function renderInventory (body, b) {
  const grid = h('div', { class: 'inv-grid' })
  const refresh = async () => {
    U.clear(grid)
    try {
      const inv = await U.api('GET', `/api/bots/${encodeURIComponent(b.id)}/inventory`)
      const bySlot = new Map(inv.slots.map(s => [s.slot, s]))
      const section = (title, from, to) => {
        grid.appendChild(h('div', { class: 'inv-title muted small' }, title))
        const row = h('div', { class: 'slots' })
        for (let i = from; i <= to; i++) {
          const it = bySlot.get(i)
          const isHeld = i === 36 + inv.quickBarSlot
          row.appendChild(h('div', {
            class: `slot${it ? ' filled' : ''}${isHeld ? ' held' : ''}`,
            title: it ? `${it.displayName} (${it.name}) — case ${i}\nClic : prendre en main` : `case ${i}`,
            onclick: async () => {
              if (it && await botAction(b.id, 'equip', { item: it.name })) refresh()
              else if (i >= 36 && i <= 44) { await botAction(b.id, 'hotbar', { slot: i - 36 }); refresh() }
            }
          }, it ? h('span', { class: 'item-name' }, it.name.replace(/_/g, ' ')) : '', it && it.count > 1 ? h('span', { class: 'count' }, it.count) : null))
        }
        grid.appendChild(row)
      }
      section('Armure (5-8) et main secondaire (45)', 5, 8)
      section('', 45, 45)
      section('Inventaire (9-35)', 9, 35)
      section('Barre rapide (36-44)', 36, 44)
    } catch (err) {
      grid.appendChild(h('div', { class: 'muted' }, err.message))
    }
  }
  U.add(body, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: refresh }, '↻ Rafraîchir')), grid)
  refresh()
}

async function renderGui (body, b) {
  const box = h('div')
  const refresh = async () => {
    U.clear(box)
    try {
      const w = await U.api('GET', `/api/bots/${encodeURIComponent(b.id)}/window`)
      if (!w) {
        box.appendChild(h('p', { class: 'muted' }, 'Aucun menu ouvert. Ouvrez-en un via une commande (onglet Console) ou en utilisant un objet.'))
        return
      }
      box.appendChild(h('div', { class: 'gui-title' }, w.title || '(sans titre)', h('span', { class: 'muted small' }, ` ${w.type} • ${w.size} cases`)))
      const bySlot = new Map(w.slots.map(s => [s.slot, s]))
      const rows = h('div', { class: 'slots gui' })
      const shift = h('input', { type: 'checkbox' })
      for (let i = 0; i < w.size; i++) {
        const it = bySlot.get(i)
        rows.appendChild(h('div', {
          class: `slot${it ? ' filled' : ''}`,
          title: it ? `${it.displayName} (${it.name} x${it.count}) — case ${i}` : `case ${i}`,
          onclick: async () => {
            await botAction(b.id, 'click', { slot: i, button: 0, mode: shift.checked ? 1 : 0 })
            setTimeout(refresh, 400)
          },
          oncontextmenu: async ev => {
            ev.preventDefault()
            await botAction(b.id, 'click', { slot: i, button: 1, mode: 0 })
            setTimeout(refresh, 400)
          }
        }, h('span', { class: 'slot-index' }, i), it ? h('span', { class: 'item-name' }, (it.displayName || it.name).slice(0, 24)) : '', it && it.count > 1 ? h('span', { class: 'count' }, it.count) : null))
      }
      U.add(box, rows, h('div', { class: 'row' }, h('label', { class: 'check' }, shift, h('span', null, 'Maj + clic')),
        h('span', { class: 'muted small' }, 'Clic gauche / clic droit sur une case'),
        h('button', { class: 'btn danger-ghost', onclick: async () => { await botAction(b.id, 'closeWindow'); refresh() } }, 'Fermer le menu')))
    } catch (err) {
      box.appendChild(h('div', { class: 'muted' }, err.message))
    }
  }
  U.add(body, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: refresh }, '↻ Rafraîchir')), box)
  refresh()
}

function renderDrawerGraphs (body, b) {
  let box = body.querySelector('.graphs-box')
  if (!box) {
    const select = h('select', { id: 'drawer-graph' }, h('option', { value: '' }, 'Choisir un graphe…'), state.graphs.map(g => h('option', { value: g.id }, g.name)))
    const signal = h('input', { type: 'text', placeholder: 'Nom du signal (nœud « Signal reçu »)', value: 'go' })
    U.add(body,
      h('h4', null, 'Lancer un comportement'),
      h('div', { class: 'row' }, select, h('button', {
        class: 'btn success',
        onclick: async () => {
          if (!select.value) return
          try {
            await U.api('POST', '/api/run', { graphId: select.value, targets: [b.id] })
            U.toast('Comportement lancé', 'success')
          } catch (err) {
            U.toast(err.message, 'error')
          }
        }
      }, '▶ Lancer')),
      h('div', { class: 'row' }, signal, h('button', { class: 'btn', onclick: () => botAction(b.id, 'trigger', { name: signal.value }) }, 'Envoyer le signal')),
      h('h4', null, 'En cours'))
    box = h('div', { class: 'graphs-box' })
    body.appendChild(box)
  }
  U.clear(box)
  if (!b.runtimes.length) box.appendChild(h('p', { class: 'muted' }, 'Aucun comportement en cours.'))
  for (const r of b.runtimes) {
    box.appendChild(h('div', { class: 'runtime-row' },
      h('span', { class: 'dot online' }), h('span', null, r.name), h('span', { class: 'muted tiny' }, r.id),
      h('button', { class: 'btn small danger', onclick: () => U.api('POST', `/api/runtimes/${r.id}/stop`).catch(err => U.toast(err.message, 'error')) }, 'Arrêter')))
  }
}

function renderPlugins (body, b) {
  for (const p of state.info.plugins) {
    if (p.key === 'authme') continue
    body.appendChild(h('label', { class: 'check plugin' },
      h('input', { type: 'checkbox', checked: !!b.plugins[p.key], onchange: ev => botAction(b.id, 'plugins', { plugins: { [p.key]: ev.target.checked } }) }),
      h('span', null, h('b', null, p.label), h('br'), h('small', { class: 'muted' }, p.description))))
  }
  const auth = b.plugins.authme || {}
  const pw = h('input', { type: 'text', value: auth.password || '', placeholder: 'Mot de passe AuthMe' })
  U.add(body,
    h('label', { class: 'check plugin' },
      h('input', { type: 'checkbox', checked: !!auth.enabled, onchange: ev => botAction(b.id, 'plugins', { plugins: { authme: { enabled: ev.target.checked, password: pw.value } } }) }),
      h('span', null, h('b', null, 'AuthMe / LoginSecurity'), h('br'), h('small', { class: 'muted' }, 'Répond automatiquement à /register et /login'))),
    h('div', { class: 'row' }, pw, h('button', { class: 'btn', onclick: () => botAction(b.id, 'plugins', { plugins: { authme: { password: pw.value } } }) }, 'Enregistrer')))
}

async function renderBotLogs (body, b) {
  const list = h('div', { class: 'log-list compact' })
  body.appendChild(list)
  try {
    const lines = await U.api('GET', `/api/logs?source=${encodeURIComponent(b.id)}&limit=300`)
    for (const l of lines) list.appendChild(logLine(l))
    list.scrollTop = list.scrollHeight
  } catch (err) {
    list.appendChild(h('div', { class: 'muted' }, err.message))
  }
}

// --- Journal -------------------------------------------------------------------------

function logLine (l) {
  return h('div', { class: `log-line ${l.level}` }, h('span', { class: 'time' }, U.fmtTime(l.t)), h('span', { class: 'src' }, l.source), l.message)
}

function logFilter (l) {
  const src = document.getElementById('log-source').value
  const level = document.getElementById('log-level').value
  const q = document.getElementById('log-search').value.toLowerCase()
  const rank = { debug: 0, info: 1, warn: 2, error: 3 }
  if (src && l.source !== src && !l.source.startsWith(`${src}/`)) return false
  if (level && (rank[l.level] ?? 1) < rank[level]) return false
  if (q && !`${l.source} ${l.message}`.toLowerCase().includes(q)) return false
  return true
}

function renderLogs () {
  const list = U.clear(document.getElementById('log-list'))
  const lines = state.logs.filter(logFilter).slice(-1500)
  for (const l of lines) list.appendChild(logLine(l))
  list.scrollTop = list.scrollHeight
  const sel = document.getElementById('log-source')
  const current = sel.value
  const sources = new Set(['', 'manager', 'web', ...state.logs.map(l => l.source.split('/')[0])])
  U.clear(sel)
  for (const s of sources) sel.appendChild(h('option', { value: s }, s || 'Toutes les sources'))
  sel.value = current
}

function onLogs (lines) {
  state.logs.push(...lines)
  if (state.logs.length > 4000) state.logs.splice(0, state.logs.length - 4000)
  if (state.logPaused) return
  const tab = document.getElementById('tab-logs')
  if (tab.classList.contains('active')) {
    const list = document.getElementById('log-list')
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    for (const l of lines.filter(logFilter)) list.appendChild(logLine(l))
    while (list.childNodes.length > 1500) list.removeChild(list.firstChild)
    if (atBottom) list.scrollTop = list.scrollHeight
  }
  if (state.openBot && state.drawerTab === 'logs') {
    const list = document.querySelector('#drawer .log-list')
    if (list) {
      for (const l of lines.filter(x => x.source === state.openBot || x.source.startsWith(`${state.openBot}/`))) list.appendChild(logLine(l))
      list.scrollTop = list.scrollHeight
    }
  }
  for (const l of lines) {
    if (l.level === 'error' && /Erreur|Expulsé/.test(l.message)) U.toast(`${l.source} : ${l.message.slice(0, 140)}`, 'error', 5000)
  }
}

// --- Rapports -------------------------------------------------------------------------

async function loadReports () {
  try {
    const list = await U.api('GET', '/api/reports')
    state.reports = new Map(list.map(r => [r.id, r]))
    renderReports()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

const REPORT_STATUS = { running: 'En cours', passed: 'Réussi', failed: 'Échoué', stopped: 'Arrêté', error: 'Erreur' }

function renderReports () {
  const list = U.clear(document.getElementById('report-list'))
  const reports = [...state.reports.values()].sort((a, b) => b.startedAt - a.startedAt)
  if (!reports.length) list.appendChild(h('p', { class: 'muted' }, 'Aucun rapport. Les rapports sont créés par les graphes (nœuds « Tests ») et par les modes Testeur de commandes, GUI, Bâtisseur, Casseur et Observateur.'))
  const counts = { passed: 0, failed: 0, running: 0 }
  for (const r of reports) {
    if (counts[r.status] !== undefined) counts[r.status]++
    list.appendChild(h('div', {
      class: `report-row${state.openReport === r.id ? ' open' : ''}`,
      onclick: () => openReport(r.id)
    },
    h('span', { class: `pill ${r.status}` }, REPORT_STATUS[r.status] || r.status),
    h('div', { class: 'grow' }, h('div', null, r.name), h('div', { class: 'muted tiny' }, `${U.fmtTime(r.startedAt)} • ${U.fmtDuration(r.duration)} • ${r.source || r.kind}`)),
    h('span', { class: 'small' }, h('span', { class: 'ok' }, `✔ ${r.passed}`), ' ', h('span', { class: 'error' }, `✘ ${r.failed}`), r.errors ? h('span', { class: 'warn' }, ` ! ${r.errors}`) : null)))
  }
  document.getElementById('report-summary').textContent = `${reports.length} rapport(s) • ${counts.passed} réussi(s) • ${counts.failed} échoué(s) • ${counts.running} en cours`
}

function sparkline (values) {
  const nums = values.map(Number).filter(Number.isFinite)
  if (nums.length < 2) return null
  const w = 160
  const hh = 32
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const pts = nums.map((v, i) => `${(i / (nums.length - 1)) * w},${hh - ((v - min) / (max - min || 1)) * (hh - 4) - 2}`).join(' ')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${hh}`)
  svg.setAttribute('class', 'spark')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  line.setAttribute('points', pts)
  svg.appendChild(line)
  return svg
}

async function openReport (id) {
  state.openReport = id
  renderReports()
  const box = U.clear(document.getElementById('report-detail'))
  let r
  try {
    r = await U.api('GET', `/api/reports/${id}`)
  } catch (err) {
    box.appendChild(h('div', { class: 'alert error' }, err.message))
    return
  }
  const metrics = new Map()
  for (const m of r.metrics) {
    if (!metrics.has(m.name)) metrics.set(m.name, [])
    metrics.get(m.name).push(m.value)
  }
  U.add(box,
    h('div', { class: 'report-head' },
      h('div', null, h('h3', null, r.name), h('div', { class: 'muted small' },
        `${REPORT_STATUS[r.status] || r.status} • début ${U.fmtTime(r.startedAt)} • durée ${U.fmtDuration(r.duration)}${r.botId ? ` • bot ${r.botId}` : ''}${r.message ? ` • ${r.message}` : ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => U.download(`rapport-${r.id}.json`, JSON.stringify(r, null, 2)) }, 'Exporter'),
        h('button', { class: 'btn small', onclick: () => openReport(id) }, '↻'),
        h('button', { class: 'btn small danger-ghost', onclick: async () => { await U.api('DELETE', `/api/reports/${id}`); state.reports.delete(id); state.openReport = null; U.clear(box); renderReports() } }, 'Supprimer'))),
    r.assertions.length ? h('h4', null, `Vérifications (${r.passed} ✔ / ${r.failed} ✘)`) : null,
    r.assertions.length ? h('div', { class: 'table' }, r.assertions.map(a => h('div', { class: `trow ${a.ok ? 'ok' : 'error'}` }, h('span', null, a.ok ? '✔' : '✘'), h('span', { class: 'time' }, U.fmtTime(a.t)), h('span', { class: 'grow' }, a.message)))) : null,
    metrics.size ? h('h4', null, 'Mesures') : null,
    metrics.size ? h('div', { class: 'table' }, [...metrics].map(([name, vals]) => {
      const nums = vals.map(Number).filter(Number.isFinite)
      const avg = nums.length ? Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 100) / 100 : '-'
      return h('div', { class: 'trow' }, h('span', { class: 'grow' }, name),
        h('span', { class: 'small' }, `n=${vals.length} • min ${nums.length ? Math.min(...nums) : '-'} • moy ${avg} • max ${nums.length ? Math.max(...nums) : '-'} • dernier ${vals[vals.length - 1]}`),
        sparkline(vals))
    })) : null,
    r.entries.length ? h('h4', null, 'Journal') : null,
    r.entries.length ? h('div', { class: 'table' }, r.entries.map(e => h('div', { class: 'trow' }, h('span', { class: 'time' }, U.fmtTime(e.t)), h('span', { class: 'grow' }, e.message)))) : null,
    r.errors.length ? h('h4', null, 'Erreurs') : null,
    r.errors.length ? h('div', { class: 'table' }, r.errors.map(e => h('div', { class: 'trow error' }, h('span', { class: 'time' }, U.fmtTime(e.t)), h('span', { class: 'grow' }, e.message)))) : null)
}

// --- Aide -----------------------------------------------------------------------------

function renderHelp () {
  const box = U.clear(document.getElementById('help-content'))
  const f = state.info.functions
  U.add(box,
    h('h2', null, 'Bien démarrer'),
    h('ol', null,
      h('li', null, 'Tableau de bord : indiquez l\'adresse du serveur, cliquez sur « Ping » pour vérifier la version.'),
      h('li', null, 'Créez un bot (pseudo) ou un essaim (motif « Bot_{i} » + nombre). Serveur en online-mode : choisissez l\'auth Microsoft.'),
      h('li', null, 'Choisissez un mode prédéfini (fiche du bot → Mode) ou programmez un comportement dans l\'éditeur.'),
      h('li', null, 'Lancez le graphe sur un ou plusieurs bots ; les nœuds exécutés clignotent en direct, les erreurs s\'affichent en rouge.'),
      h('li', null, 'Les nœuds « Tests » produisent des rapports (onglet Rapports), utilisables en CI avec « arthur-bot run ».')),
    h('h2', null, 'Expressions'),
    h('p', null, 'Les champs « expr » et les champs numériques acceptent des expressions. Dans un texte, insérez une valeur avec ', h('code', null, '{{ expression }}'), '.'),
    h('pre', null, 'bot.health < 10 && hasItem(\'bread\')\n"Salut " + event.username\ncompteur % 10 == 0 ? "dizaine" : "autre"\nmatch(event.message, "(\\\\w+) a rejoint")[1]\ndistanceTo(0, 64, 0) > 20'),
    h('h3', null, 'Variables disponibles'),
    h('ul', null,
      h('li', null, h('code', null, 'bot.*'), ' : username, health, food, x, y, z, blockX/Y/Z, yaw, pitch, dimension, gameMode, ping, tps, players, playerNames, heldItem, isDay, timeOfDay, windowTitle, emptySlots, moving, online'),
      h('li', null, h('code', null, 'event.*'), ' : données de l\'évènement déclencheur (message, username, match, player, reason, count, health, title…)'),
      h('li', null, h('code', null, 'nom'), ' : variable du graphe ou du flux (index d\'une boucle, found, entity, response, latency, window…)'),
      h('li', null, h('code', null, 'shared.nom'), ' : variable partagée entre tous les bots')),
    h('h3', null, 'Fonctions'),
    h('p', null, h('b', null, 'Bot : '), f.bot.map(x => h('code', null, x)).reduce((a, c) => a.concat(c, ' '), [])),
    h('p', null, h('b', null, 'Générales : '), f.builtins.map(x => h('code', null, `${x}()`)).reduce((a, c) => a.concat(c, ' '), [])),
    h('p', null, h('b', null, 'Méthodes : '), 'texte.toLowerCase(), toUpperCase(), trim(), includes(), startsWith(), endsWith(), split(), slice(), replace() ; liste.includes(), join(), slice() ; nombre.toFixed()'),
    h('h2', null, 'Modes prédéfinis'),
    h('div', { class: 'table' }, state.info.modes.map(m => h('div', { class: 'trow' }, h('b', { class: 'w160' }, m.label), h('span', { class: 'muted small w100' }, m.category), h('span', { class: 'grow' }, m.description)))),
    h('h2', null, 'Ligne de commande'),
    h('pre', null, 'npm start                          # interface web + console\nnode bin/arthur-bot.js run graphs/exemple-test-commandes.json --host localhost --port 25565 --junit rapport.xml\nnode bin/arthur-bot.js ping play.monserveur.fr:25565\nnode bin/arthur-bot.js nodes       # liste des nœuds'),
    h('p', { class: 'muted small' }, `Arthur's Bot ${state.info.version} • Minecraft Java ${state.info.minecraft.oldest} → ${state.info.minecraft.latest} • ${state.info.nodes.length} nœuds • ${state.info.modes.length} modes`))
}

// --- Démarrage ----------------------------------------------------------------------------

async function init () {
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)))
  try {
    state.info = await U.api('GET', '/api/info')
  } catch (err) {
    document.body.prepend(h('div', { class: 'alert error' }, `Impossible de contacter le serveur : ${err.message}. Si l'interface est protégée, ajoutez ?token=… à l'adresse.`))
    return
  }
  fillSelects()
  renderHelp()
  editor = new GraphEditor(document.getElementById('editor-root'), {
    getBots: () => [...state.bots.values()],
    getSelectedBots: () => [...state.selected]
  })
  editor.setInfo(state.info)

  document.getElementById('srv-host').addEventListener('change', saveServerSettings)
  document.getElementById('srv-port').addEventListener('change', saveServerSettings)
  document.getElementById('srv-version').addEventListener('change', saveServerSettings)
  document.getElementById('ping-btn').addEventListener('click', ping)
  document.getElementById('create-form').addEventListener('submit', createBots)
  document.getElementById('select-all').addEventListener('change', ev => {
    state.selected = ev.target.checked ? new Set(state.bots.keys()) : new Set()
    renderBots()
  })
  document.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', () => bulk(b.dataset.bulk)))
  const bulkChat = document.getElementById('bulk-chat')
  const sendBulkChat = () => {
    if (!bulkChat.value.trim()) return
    bulk('chat', { message: bulkChat.value })
    bulkChat.value = ''
  }
  bulkChat.addEventListener('keydown', ev => { if (ev.key === 'Enter') sendBulkChat() })
  document.getElementById('bulk-chat-btn').addEventListener('click', sendBulkChat)
  document.getElementById('bulk-mode').addEventListener('change', ev => {
    if (ev.target.value) bulk('mode', { mode: ev.target.value, options: {} })
    ev.target.value = ''
  })
  document.getElementById('bulk-graph').addEventListener('change', async ev => {
    if (!ev.target.value) return
    try {
      const runs = await U.api('POST', '/api/run', { graphId: ev.target.value, targets: bulkTargets() })
      U.toast(`Graphe lancé sur ${runs.length} bot(s)`, 'success')
    } catch (err) {
      U.toast(err.message, 'error')
    }
    ev.target.value = ''
  })
  document.getElementById('bulk-signal-btn').addEventListener('click', async () => {
    const name = document.getElementById('bulk-signal').value.trim()
    if (!name) return
    const res = await U.api('POST', '/api/trigger', { name, targets: bulkTargets() }).catch(err => U.toast(err.message, 'error'))
    if (res) U.toast(`Signal « ${name} » envoyé à ${res.count} bot(s)`)
  })
  document.getElementById('stop-all-graphs').addEventListener('click', async () => {
    const res = await U.api('POST', '/api/runtimes/stop', {}).catch(err => U.toast(err.message, 'error'))
    if (res) U.toast(`${res.stopped} exécution(s) arrêtée(s)`)
  })
  for (const id of ['log-source', 'log-level', 'log-search']) document.getElementById(id).addEventListener('input', renderLogs)
  document.getElementById('log-pause').addEventListener('change', ev => {
    state.logPaused = ev.target.checked
    if (!state.logPaused) renderLogs()
  })
  document.getElementById('log-clear').addEventListener('click', () => {
    state.logs = []
    renderLogs()
  })
  document.getElementById('reports-clear').addEventListener('click', async () => {
    await U.api('DELETE', '/api/reports')
    state.openReport = null
    U.clear(document.getElementById('report-detail'))
    loadReports()
  })

  try {
    state.logs = await U.api('GET', '/api/logs?limit=1500')
  } catch (err) { /* ignore */ }
  await loadGraphs()
  loadReports()

  const socket = io({ auth: { token: U.token } })
  const conn = document.getElementById('conn-status')
  socket.on('connect', () => { conn.className = 'conn ok'; conn.title = 'Connecté au serveur' })
  socket.on('disconnect', () => { conn.className = 'conn ko'; conn.title = 'Déconnecté du serveur' })
  socket.on('bots', list => {
    state.bots = new Map(list.map(b => [b.id, b]))
    renderBots()
    if (state.openBot) renderDrawer(false)
    editor.updateRunInfo()
  })
  socket.on('logs', onLogs)
  socket.on('chats', chats => {
    const list = document.getElementById('chat-list')
    if (!list || !state.openBot || state.drawerTab !== 'console') return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    for (const c of chats) if (c.botId === state.openBot) list.appendChild(chatLine(c))
    while (list.childNodes.length > 400) list.removeChild(list.firstChild)
    if (atBottom) list.scrollTop = list.scrollHeight
  })
  socket.on('traces', traces => editor.trace(traces))
  socket.on('graphs', loadGraphs)
  socket.on('report', r => {
    const prev = state.reports.get(r.id)
    state.reports.set(r.id, r)
    if (document.getElementById('tab-reports').classList.contains('active')) {
      renderReports()
      if (state.openReport === r.id) openReport(r.id)
    }
    if (prev && prev.status === 'running' && r.status !== 'running') {
      U.toast(`Rapport « ${r.name} » : ${REPORT_STATUS[r.status] || r.status} (${r.passed} ✔ / ${r.failed} ✘)`, r.status === 'passed' ? 'success' : r.status === 'failed' ? 'error' : 'info', 5000)
    }
  })
  socket.on('reportsCleared', loadReports)

  showTab(U.store('tab') || 'dashboard')
}

init()
