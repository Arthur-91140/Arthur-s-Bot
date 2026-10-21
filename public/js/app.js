/* Tableau de bord : bots, fiche détaillée, rapports, journal, aide. */
'use strict'
/* global U, io, GraphEditor */

const { h } = U
const $ = id => document.getElementById(id)

const STATUS_LABEL = {
  online: 'En jeu',
  connecting: 'Connexion…',
  spawning: 'Apparition…',
  reconnecting: 'Reconnexion…',
  offline: 'Hors ligne'
}
const STATUS_ORDER = { online: 0, spawning: 1, connecting: 2, reconnecting: 3, offline: 4 }

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
  logPaused: false,
  logLevels: new Set(U.store('log-levels') || ['info', 'warn', 'error']),
  server: U.store('server'),
  ping: null,
  filter: 'all',
  search: '',
  sort: U.store('sort') || { key: 'name', dir: 1 },
  history: { tps: [], ping: [], online: [] },
  feed: [],
  mapDim: null,
  chatHistory: U.store('chat-history') || []
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
  if (name === 'dashboard') renderMap()
}

// --- Serveur ----------------------------------------------------------------------

function serverSettings () {
  return state.server || state.info.defaults.server
}

function serverLabel (s = serverSettings()) {
  return Number(s.port) === 25565 ? s.host : `${s.host}:${s.port}`
}

async function ping (target = serverSettings()) {
  try {
    return await U.api('GET', `/api/ping?host=${encodeURIComponent(target.host)}&port=${Number(target.port) || 25565}`)
  } catch (err) {
    return { online: false, error: err.message }
  }
}

async function refreshServer () {
  state.ping = { ...(state.ping || {}), pending: true }
  renderServerEntry()
  state.ping = { ...(await ping()), at: Date.now() }
  renderServerEntry()
}

/** Barres de réseau du menu multijoueur (5 = excellent, 0 = injoignable). */
function pingBars (latency, online = true) {
  let level = 0
  if (online && latency !== null && latency !== undefined) {
    level = latency < 150 ? 5 : latency < 300 ? 4 : latency < 600 ? 3 : latency < 1000 ? 2 : 1
  }
  return h('span', { class: `ping-bars l${level}`, title: online ? `${latency} ms` : 'Injoignable' },
    [1, 2, 3, 4, 5].map(i => h('i', { class: i <= level ? 'on' : null, style: { height: `${i * 2 + 2}px` } })))
}

function pingDetails (r) {
  if (!r.online) return [h('div', { class: 'motd error' }, `Serveur injoignable : ${r.error || 'pas de réponse'}`)]
  return [
    h('div', { class: 'motd' }, r.motd || 'Un serveur Minecraft'),
    h('div', { class: 'server-tags' },
      h('span', null, `${r.version} · protocole ${r.protocol}`),
      r.supported
        ? h('span', { class: 'ok' }, `bots en ${r.botVersion}`)
        : h('span', { class: 'warn' }, 'protocole non reconnu : version proche ou ViaVersion'),
      r.modded ? h('span', { class: 'warn' }, 'serveur moddé') : null)
  ]
}

function renderServerEntry () {
  const box = U.clear($('server-entry'))
  const r = state.ping
  const players = r && r.online && r.players ? `${r.players.online}/${r.players.max}` : '—'
  U.add(box,
    h('img', { class: 'server-icon', src: r && r.favicon ? r.favicon : U.grassIcon(), alt: '' }),
    h('div', { class: 'server-body' },
      h('div', { class: 'server-line' },
        h('span', { class: 'server-name' }, serverLabel()),
        h('span', { class: 'server-players', title: r && r.players && r.players.sample.length ? r.players.sample.join(', ') : null }, players),
        r && !r.pending ? pingBars(r.latency, r.online) : h('span', { class: 'muted tiny' }, 'ping…')),
      r && !r.pending ? pingDetails(r) : h('div', { class: 'motd muted' }, 'Interrogation du serveur…')),
    h('div', { class: 'server-actions' },
      h('button', { class: 'btn small', title: 'Interroger à nouveau', onclick: refreshServer }, 'Rafraîchir'),
      h('button', { class: 'btn small', onclick: openServerDialog }, 'Modifier')))
}

function openServerDialog () {
  const s = serverSettings()
  $('srv-host').value = s.host
  $('srv-port').value = s.port
  $('srv-version').value = s.version || 'auto'
  U.clear($('srv-test-result'))
  $('server-dialog').showModal()
  $('srv-host').select()
}

async function testServer () {
  const out = U.clear($('srv-test-result'))
  out.appendChild(h('div', { class: 'ping-card muted' }, 'Interrogation…'))
  const r = await ping({ host: $('srv-host').value.trim() || 'localhost', port: $('srv-port').value })
  U.add(U.clear(out), h('div', { class: 'ping-card' },
    r.favicon ? h('img', { src: r.favicon, class: 'favicon', alt: '' }) : null,
    h('div', { class: 'grow' }, pingDetails(r)),
    r.online ? pingBars(r.latency) : null))
  if (r.online && r.supported && $('srv-version').value === 'auto') $('srv-version').title = `Détectée : ${r.botVersion}`
}

function saveServer (ev) {
  ev.preventDefault()
  state.server = {
    host: $('srv-host').value.trim() || 'localhost',
    port: Number($('srv-port').value) || 25565,
    version: $('srv-version').value || 'auto'
  }
  U.store('server', state.server)
  $('server-dialog').close()
  refreshServer()
}

// --- Création de bots ----------------------------------------------------------------

function openNewBot () {
  const s = serverSettings()
  $('create-server').textContent = `Serveur : ${serverLabel(s)} · version ${s.version === 'auto' ? 'détectée automatiquement' : s.version}`
  $('new-bot-dialog').showModal()
  $('c-username').focus()
  $('c-username').select()
}

async function createBots (ev) {
  ev.preventDefault()
  const f = ev.target
  const count = Number(f.count.value) || 1
  const body = {
    ...serverSettings(),
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
    if (res.created.length) {
      U.toast(`${res.created.length} bot${res.created.length > 1 ? 's' : ''} en route vers ${serverLabel()}`, 'success')
      $('new-bot-dialog').close()
    }
    for (const e of res.errors) U.toast(e, 'error', 6000)
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

function fillSelects () {
  const versionSel = $('srv-version')
  U.clear(versionSel)
  versionSel.appendChild(h('option', { value: 'auto' }, 'Auto (détection)'))
  for (const v of state.info.minecraft.versions) versionSel.appendChild(h('option', { value: v }, v))
  const sel = U.clear($('create-mode'))
  for (const m of state.info.modes) sel.appendChild(h('option', { value: m.name, title: m.description }, m.label))
  const form = U.store('create-form')
  const f = $('create-form')
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
  const sel = $('create-graph')
  const current = sel.value
  U.clear(sel)
  sel.appendChild(h('option', { value: '' }, 'Aucun'))
  for (const g of state.graphs) sel.appendChild(h('option', { value: g.id }, g.name))
  sel.value = current
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

// --- Indicateurs --------------------------------------------------------------------------

function avg (values) {
  const nums = values.filter(v => v !== null && v !== undefined && Number.isFinite(v))
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null
}

function sampleHistory () {
  const online = [...state.bots.values()].filter(b => b.status === 'online')
  const push = (key, v) => {
    const list = state.history[key]
    list.push(v)
    if (list.length > 120) list.shift()
  }
  push('tps', avg(online.map(b => b.tps)))
  push('ping', avg(online.map(b => b.ping)))
  push('online', online.length)
}

/** Courbe en escalier (les valeurs nulles créent un trou). */
function stepChart (values, { min = null, max = null, cls = '' } = {}) {
  const nums = values.filter(v => v !== null)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', `chart ${cls}`)
  svg.setAttribute('viewBox', '0 0 120 30')
  svg.setAttribute('preserveAspectRatio', 'none')
  if (nums.length < 2) return svg
  const lo = min ?? Math.min(...nums)
  const hi = Math.max(max ?? -Infinity, ...nums)
  const span = hi - lo || 1
  const step = 120 / Math.max(1, values.length - 1)
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v === null) {
      pen = false
      return
    }
    const x = (i * step).toFixed(1)
    const y = (28 - ((v - lo) / span) * 26).toFixed(1)
    d += pen ? ` H ${x} V ${y}` : ` M ${x} ${y}`
    pen = true
  })
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d.trim())
  svg.appendChild(path)
  return svg
}

function kpi (label, value, sub, extra, cls = '') {
  return h('div', { class: `kpi panel ${cls}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    sub ? h('div', { class: 'kpi-sub' }, sub) : null,
    extra)
}

function renderKpis () {
  const bots = [...state.bots.values()]
  const online = bots.filter(b => b.status === 'online')
  const tps = state.history.tps[state.history.tps.length - 1]
  const pingAvg = state.history.ping[state.history.ping.length - 1]
  const running = bots.reduce((n, b) => n + b.runtimes.filter(r => r.status === 'running').length, 0)
  const reports = [...state.reports.values()]
  const passed = reports.filter(r => r.status === 'passed').length
  const failed = reports.filter(r => r.status === 'failed' || r.status === 'error').length
  const lamps = h('div', { class: 'lamps' }, bots.slice(0, 48).map(b => h('span', { class: `led ${b.status}`, title: `${b.id} : ${STATUS_LABEL[b.status] || b.status}` })),
    bots.length > 48 ? h('span', { class: 'muted tiny' }, `+${bots.length - 48}`) : null)
  const tpsCls = tps === null || tps === undefined ? '' : tps >= 19 ? 'good' : tps >= 15 ? 'meh' : 'bad'
  U.add(U.clear($('kpis')),
    kpi('Bots en jeu', h('span', null, `${online.length}`, h('small', null, ` / ${bots.length}`)), null, lamps),
    kpi('TPS du serveur', tps ?? '—', 'moyenne mesurée par les bots', stepChart(state.history.tps, { min: 0, max: 20, cls: 'tps' }), tpsCls),
    kpi('Ping moyen', pingAvg !== null && pingAvg !== undefined ? h('span', null, `${Math.round(pingAvg)}`, h('small', null, ' ms')) : '—', null, stepChart(state.history.ping, { min: 0, cls: 'ping' })),
    kpi('Comportements', running, running ? 'graphes en cours' : 'aucun graphe en cours'),
    kpi('Tests', h('span', null, h('span', { class: 'ok' }, passed), h('small', null, ' ok · '), h('span', { class: failed ? 'error' : '' }, failed), h('small', null, ' ko')), `${reports.length} rapport${reports.length > 1 ? 's' : ''}`))
}

// --- Liste des bots -----------------------------------------------------------------

/** Jauge en 10 cases (comme les cœurs et la faim du jeu). */
function meter (value, max, kind, withLabel = false) {
  const cells = []
  const v = value === null || value === undefined ? 0 : Math.max(0, Math.min(max, value))
  const per = max / 10
  for (let i = 0; i < 10; i++) {
    const fill = v - i * per
    cells.push(h('i', { class: fill >= per ? 'on' : fill >= per / 2 ? 'half' : null }))
  }
  return h('span', { class: 'meter-wrap', title: `${kind === 'health' ? 'Vie' : 'Faim'} : ${value ?? '-'}/${max}` },
    h('span', { class: `meter ${kind}` }, cells),
    withLabel ? h('span', { class: 'meter-label' }, value ?? '-') : null)
}

function stateTag (status, labels = STATUS_LABEL) {
  return h('span', { class: `state ${status}` }, labels[status] || status)
}

function botRow (b) {
  const pos = b.position ? `${b.position.x} ${b.position.y} ${b.position.z}` : '—'
  const running = b.runtimes.filter(r => r.status === 'running').length
  const reason = b.status === 'offline' && ((b.lastKick && b.lastKick.reason) || b.lastError)
  const select = h('input', {
    type: 'checkbox',
    checked: state.selected.has(b.id),
    title: 'Sélectionner',
    onchange: ev => {
      if (ev.target.checked) state.selected.add(b.id)
      else state.selected.delete(b.id)
      renderBots()
    }
  })
  return h('tr', {
    class: [state.selected.has(b.id) ? 'selected' : '', state.openBot === b.id ? 'open' : ''].join(' ').trim() || null,
    dataset: { id: b.id },
    onclick: ev => {
      if (ev.target.closest('button, input')) return
      openDrawer(b.id)
    }
  },
  h('td', null, select),
  h('td', null, h('span', { class: 'name-cell' }, U.faceImg(b.id, 20), h('span', { class: `led ${b.status}` }), h('span', { class: 'name' }, b.id))),
  h('td', null, stateTag(b.status),
    reason ? h('span', { class: 'reason', title: reason }, reason) : null,
    b.msaCode ? h('span', { class: 'reason warn', title: b.msaCode.uri }, `Microsoft : code ${b.msaCode.code}`) : null),
  h('td', null, meter(b.health, 20, 'health')),
  h('td', null, meter(b.food, 20, 'food')),
  h('td', { class: 'num-cell', title: b.dimension || '' }, pos),
  h('td', { class: 'num-cell' }, b.ping !== null ? `${b.ping} ms` : '—'),
  h('td', { class: 'num-cell' }, b.tps ?? '—'),
  h('td', null, b.modeLabel, running ? h('span', { class: 'chip', title: 'Graphes en cours' }, `+${running} graphe${running > 1 ? 's' : ''}`) : null),
  h('td', null, h('span', { class: 'actions' },
    b.status === 'offline'
      ? h('button', { class: 'btn small success', title: 'Connecter ce bot', onclick: () => botAction(b.id, 'connect') }, 'Rejoindre')
      : h('button', { class: 'btn small', title: 'Déconnecter ce bot', onclick: () => botAction(b.id, 'disconnect') }, 'Quitter'),
    h('button', { class: 'btn small', onclick: () => openDrawer(b.id) }, 'Fiche'),
    h('button', { class: 'btn small danger-ghost', title: 'Supprimer ce bot', onclick: () => removeBot(b.id) }, '×'))))
}

function sortValue (b, key) {
  switch (key) {
    case 'status': return STATUS_ORDER[b.status] ?? 9
    case 'health': return b.health ?? -1
    case 'food': return b.food ?? -1
    case 'ping': return b.ping ?? 1e9
    case 'tps': return b.tps ?? -1
    case 'mode': return b.modeLabel || ''
    default: return b.id
  }
}

function visibleBots () {
  let list = [...state.bots.values()]
  if (state.filter === 'online') list = list.filter(b => b.status === 'online')
  if (state.filter === 'offline') list = list.filter(b => b.status !== 'online')
  const q = state.search.trim().toLowerCase()
  if (q) list = list.filter(b => b.id.toLowerCase().includes(q) || (b.modeLabel || '').toLowerCase().includes(q))
  const { key, dir } = state.sort
  return list.sort((a, b) => {
    const x = sortValue(a, key)
    const y = sortValue(b, key)
    const c = typeof x === 'string' ? x.localeCompare(y, 'fr', { numeric: true }) : x - y
    return (c || a.id.localeCompare(b.id, 'fr', { numeric: true })) * dir
  })
}

const COLUMNS = [['', null], ['Bot', 'name'], ['État', 'status'], ['Vie', 'health'], ['Faim', 'food'], ['Position', null], ['Ping', 'ping'], ['TPS', 'tps'], ['Mode', 'mode'], ['', null]]

function renderBots () {
  const box = $('bots-grid')
  const all = [...state.bots.values()]
  for (const id of [...state.selected]) if (!state.bots.has(id)) state.selected.delete(id)
  const online = all.filter(b => b.status === 'online').length
  const filters = [['all', 'Tous', all.length], ['online', 'En jeu', online], ['offline', 'Hors jeu', all.length - online]]
  U.add(U.clear($('status-filters')), filters.map(([key, label, n]) => h('button', {
    class: state.filter === key ? 'active' : null,
    onclick: () => {
      state.filter = key
      renderBots()
    }
  }, label, h('span', { class: 'n' }, n))))

  U.clear(box)
  const bots = visibleBots()
  if (!all.length) {
    box.appendChild(h('div', { class: 'empty' },
      h('img', { class: 'empty-face', src: U.face('Arthur'), alt: '' }),
      h('div', { class: 'empty-title' }, 'Aucun bot pour l\'instant'),
      h('p', null, 'Créez un bot (« Testeur ») ou tout un essaim (« Bot_{i} » et un nombre) pour commencer.'),
      h('button', { class: 'btn primary', onclick: openNewBot }, '+ Nouveau bot')))
  } else if (!bots.length) {
    box.appendChild(h('div', { class: 'empty' }, h('p', null, 'Aucun bot ne correspond au filtre.')))
  } else {
    box.appendChild(h('table', { class: 'roster' },
      h('thead', null, h('tr', null, COLUMNS.map(([label, key]) => h('th', {
        class: key ? `sortable${state.sort.key === key ? ' sorted' : ''}` : null,
        onclick: key ? () => {
          state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }
          U.store('sort', state.sort)
          renderBots()
        } : null
      }, label, key && state.sort.key === key ? h('span', { class: 'sort-dir' }, state.sort.dir > 0 ? ' ▲' : ' ▼') : null)))),
      h('tbody', null, bots.map(botRow))))
  }
  $('bots-count').textContent = `${state.selected.size ? `${state.selected.size} sélectionné${state.selected.size > 1 ? 's' : ''}` : 'Tout sélectionner'}`
  $('select-all').checked = all.length > 0 && state.selected.size === all.length
  const target = state.selected.size ? `${state.selected.size} bot${state.selected.size > 1 ? 's' : ''} sélectionné${state.selected.size > 1 ? 's' : ''}` : `tous les bots (${all.length})`
  $('bulk-target').textContent = `Cible : ${target}`
  $('chat-target').textContent = state.selected.size ? `${state.selected.size} bot${state.selected.size > 1 ? 's' : ''}` : `tous en jeu (${online})`
  const summary = $('top-summary')
  if (summary) summary.textContent = all.length ? `${serverLabel()} · ${online}/${all.length} en jeu` : serverLabel()
}

// --- Carte (vue de dessus) -----------------------------------------------------------------

function svgEl (tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

function renderMap () {
  const box = $('map')
  if (!box || !box.clientWidth) return
  const placed = [...state.bots.values()].filter(b => b.position && b.status === 'online')
  const dims = [...new Set(placed.map(b => b.dimension || 'overworld'))]
  if (!dims.includes(state.mapDim)) state.mapDim = dims.includes('overworld') ? 'overworld' : dims[0] || null
  const sel = $('map-dim')
  if (sel.dataset.dims !== dims.join(',')) {
    U.clear(sel)
    for (const d of dims) sel.appendChild(h('option', { value: d }, d))
    sel.dataset.dims = dims.join(',')
  }
  sel.value = state.mapDim || ''
  sel.style.display = dims.length > 1 ? '' : 'none'
  U.clear(box)
  const bots = placed.filter(b => (b.dimension || 'overworld') === state.mapDim)
  if (!bots.length) {
    box.appendChild(h('div', { class: 'map-empty' }, 'Aucun bot en jeu à afficher'))
    U.clear($('map-legend'))
    return
  }
  const W = box.clientWidth
  const H = box.clientHeight
  const xs = bots.map(b => b.position.x)
  const zs = bots.map(b => b.position.z)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2
  const span = Math.max(48, (Math.max(...xs) - Math.min(...xs)) * 1.3, (Math.max(...zs) - Math.min(...zs)) * 1.3)
  const scale = Math.min(W, H) / span
  const px = x => (x - cx) * scale + W / 2
  const pz = z => (z - cz) * scale + H / 2
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` })
  let step = 16
  while (step * scale < 10) step *= 4
  const x0 = Math.floor((cx - W / 2 / scale) / step) * step
  const z0 = Math.floor((cz - H / 2 / scale) / step) * step
  for (let x = x0; px(x) <= W; x += step) svg.appendChild(svgEl('line', { x1: Math.round(px(x)) + 0.5, y1: 0, x2: Math.round(px(x)) + 0.5, y2: H, class: x === 0 ? 'axis' : 'grid' }))
  for (let z = z0; pz(z) <= H; z += step) svg.appendChild(svgEl('line', { x1: 0, y1: Math.round(pz(z)) + 0.5, x2: W, y2: Math.round(pz(z)) + 0.5, class: z === 0 ? 'axis' : 'grid' }))
  const north = svgEl('text', { x: W - 12, y: 16, class: 'north' })
  north.textContent = 'N'
  svg.appendChild(north)
  const taken = []
  const freeLabelY = (x, y, w) => {
    let ly = y + 22
    while (taken.some(t => Math.abs(t.x - x) < (t.w + w) / 2 && Math.abs(t.y - ly) < 11)) ly += 11
    taken.push({ x, y: ly, w })
    return ly
  }
  for (const b of bots.sort((a, c) => (a.id === state.openBot) - (c.id === state.openBot))) {
    const x = Math.round(px(b.position.x))
    const y = Math.round(pz(b.position.z))
    const g = svgEl('g', { class: `map-bot${state.selected.has(b.id) ? ' selected' : ''}${state.openBot === b.id ? ' open' : ''}` })
    const title = svgEl('title')
    title.textContent = `${b.id} — ${b.position.x} ${b.position.y} ${b.position.z}`
    g.appendChild(title)
    g.appendChild(svgEl('rect', { x: x - 10, y: y - 10, width: 20, height: 20, class: 'frame' }))
    g.appendChild(svgEl('image', { href: U.face(b.id), x: x - 8, y: y - 8, width: 16, height: 16, style: 'image-rendering: pixelated' }))
    const label = svgEl('text', { x, y: freeLabelY(x, y, b.id.length * 7 + 6), class: 'label' })
    label.textContent = b.id
    g.appendChild(label)
    g.addEventListener('click', () => openDrawer(b.id))
    svg.appendChild(g)
  }
  box.appendChild(svg)
  U.add(U.clear($('map-legend')),
    h('span', null, `centre ${Math.round(cx)}, ${Math.round(cz)}`),
    h('span', null, `1 carreau = ${step} blocs`))
}

// --- Fil d'évènements ------------------------------------------------------------------------

const SYSTEM_SOURCES = new Set(['manager', 'web', 'system', 'ci', 'autostart'])
const FEED_RE = /^(Connecté|Déconnecté|Apparu|Expulsé|Le bot est mort|Comportement|Mode :|Reconnexion)/

function addToFeed (lines) {
  let changed = false
  for (const l of lines) {
    if (l.level === 'debug') continue
    if (l.level === 'info' && !FEED_RE.test(l.message)) continue
    state.feed.push(l)
    changed = true
  }
  if (state.feed.length > 80) state.feed.splice(0, state.feed.length - 80)
  if (changed) renderFeed()
}

function renderFeed () {
  const box = U.clear($('feed'))
  if (!state.feed.length) {
    box.appendChild(h('div', { class: 'muted small feed-empty' }, 'Connexions, morts, expulsions et erreurs apparaîtront ici.'))
    return
  }
  for (const l of [...state.feed].reverse()) {
    const [who, graph] = l.source.split('/')
    const bot = SYSTEM_SOURCES.has(who) ? null : who
    box.appendChild(h('div', { class: `feed-item ${l.level}${bot ? ' clickable' : ''}`, onclick: bot && state.bots.has(bot) ? () => openDrawer(bot) : null },
      bot ? U.faceImg(bot, 16) : h('span', { class: 'feed-dot' }),
      h('div', { class: 'feed-text' },
        h('div', { class: 'feed-meta' }, h('span', null, who), h('span', null, U.fmtTime(l.t))),
        h('div', null,
          graph ? h('span', { class: 'feed-graph' }, `${graph} — `) : null,
          l.message.length > 160 ? `${l.message.slice(0, 158)}…` : l.message))))
  }
}

// --- Menus d'actions groupées -----------------------------------------------------------------

function openBulkMenu (btn) {
  const kind = btn.dataset.menu
  if (kind === 'mode') {
    U.menu(btn, [{ title: 'Appliquer un mode' },
      ...state.info.modes.map(m => ({ label: m.label, hint: m.category, onClick: () => bulk('mode', { mode: m.name, options: {} }) }))])
  } else if (kind === 'graph') {
    U.menu(btn, [{ title: 'Lancer un graphe' },
      ...(state.graphs.length ? state.graphs.map(g => ({ label: g.name, hint: `${g.nodes} nœuds`, onClick: () => runGraphOn(g.id) })) : [{ label: 'Aucun graphe enregistré', disabled: true, onClick: () => {} }]),
      '-',
      { label: 'Arrêter tous les graphes', danger: true, onClick: stopAllGraphs }])
  } else if (kind === 'signal') {
    const input = h('input', { type: 'text', value: U.store('signal') || 'go', placeholder: 'Nom du signal' })
    const send = async () => {
      const name = input.value.trim()
      if (!name) return
      U.store('signal', name)
      U.closePopup()
      const res = await U.api('POST', '/api/trigger', { name, targets: bulkTargets() }).catch(err => U.toast(err.message, 'error'))
      if (res) U.toast(`Signal « ${name} » envoyé à ${res.count} bot${res.count > 1 ? 's' : ''}`)
    }
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') send() })
    U.popup(btn, h('div', { class: 'signal-pop' },
      h('div', { class: 'popup-title' }, 'Envoyer un signal'),
      h('p', { class: 'small' }, 'Déclenche les nœuds « Signal reçu » des graphes en cours.'),
      h('div', { class: 'row' }, input, h('button', { class: 'btn small primary', onclick: send }, 'Envoyer'))))
  }
}

async function runGraphOn (graphId) {
  try {
    const runs = await U.api('POST', '/api/run', { graphId, targets: bulkTargets() })
    U.toast(`Graphe lancé sur ${runs.length} bot${runs.length > 1 ? 's' : ''}`, 'success')
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

async function stopAllGraphs () {
  const res = await U.api('POST', '/api/runtimes/stop', {}).catch(err => U.toast(err.message, 'error'))
  if (res) U.toast(`${res.stopped} exécution${res.stopped > 1 ? 's' : ''} arrêtée${res.stopped > 1 ? 's' : ''}`)
}

// --- Barre de chat ------------------------------------------------------------------------------

function setupChatbar () {
  const input = $('bulk-chat')
  let index = state.chatHistory.length
  $('chatbar').addEventListener('submit', ev => {
    ev.preventDefault()
    const message = input.value
    if (!message.trim()) return
    state.chatHistory.push(message)
    if (state.chatHistory.length > 50) state.chatHistory.shift()
    U.store('chat-history', state.chatHistory)
    index = state.chatHistory.length
    bulk('chat', { message })
    input.value = ''
  })
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowUp' && index > 0) {
      input.value = state.chatHistory[--index]
      ev.preventDefault()
    } else if (ev.key === 'ArrowDown') {
      index = Math.min(state.chatHistory.length, index + 1)
      input.value = state.chatHistory[index] || ''
      ev.preventDefault()
    } else if (ev.key === 'Escape') {
      input.blur()
    }
  })
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

const BULK_LABEL = {
  connect: 'Connexion', disconnect: 'Déconnexion', reconnect: 'Reconnexion', stop: 'Arrêt des mouvements',
  chat: 'Message', mode: 'Changement de mode', remove: 'Suppression'
}

// Actions qui n'ont de sens que pour un bot en jeu : sans sélection, on ne vise que ceux-là.
const ONLINE_ONLY = new Set(['chat', 'stop'])

async function bulk (action, payload = {}) {
  let targets = bulkTargets()
  if (targets === 'all' && ONLINE_ONLY.has(action)) {
    targets = [...state.bots.values()].filter(b => b.status === 'online').map(b => b.id)
    if (!targets.length) return U.toast('Aucun bot en jeu', 'warn')
  }
  if (action === 'remove' && !confirm(targets === 'all' ? 'Supprimer TOUS les bots ?' : `Supprimer ${targets.length} bot(s) ?`)) return
  try {
    const res = await U.api('POST', '/api/bulk', { targets, action, ...payload })
    const failed = res.results ? Object.entries(res.results).filter(([, r]) => !r.ok) : []
    const label = BULK_LABEL[action] || action
    if (action !== 'chat' || failed.length) {
      U.toast(`${res.count - failed.length} bot${res.count > 1 ? 's' : ''} sur ${res.count}`, failed.length ? 'warn' : 'success', 3500, label)
    }
    for (const [id, r] of failed.slice(0, 3)) U.toast(`${id} : ${r.error}`, 'error')
    if (action === 'remove') state.selected.clear()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

// --- Fiche d'un bot (tiroir) ------------------------------------------------------

function openDrawer (id) {
  state.openBot = id
  $('drawer').classList.remove('hidden')
  renderDrawer(true)
  renderBots()
  renderMap()
}

function closeDrawer () {
  state.openBot = null
  $('drawer').classList.add('hidden')
  renderBots()
  renderMap()
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
      h('div', { class: 'drawer-title' }, U.faceImg(b.id, 32), h('span', null, b.id, h('br'), h('span', { class: 'drawer-state' }, h('span', { class: `led ${b.status}` }), stateTag(b.status)))),
      h('div', { class: 'drawer-sub' },
        `${b.host}:${b.port} · ${b.version || 'auto'} · auth ${b.auth === 'microsoft' ? 'Microsoft' : 'hors ligne'}`,
        b.uptime ? ` · en ligne depuis ${U.fmtDuration(b.uptime)}` : '')),
    h('button', { class: 'btn icon', onclick: closeDrawer, title: 'Fermer (Échap)' }, '×'))

  const stats = drawer.querySelector('.drawer-stats')
  const s = b.stats
  U.add(U.clear(stats),
    hud(b),
    h('div', { class: 'stat-grid inset' },
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
    b.lastKick ? h('div', { class: 'alert warn' }, `Dernier kick : ${b.lastKick.reason}`) : null,
    b.lastError ? h('div', { class: 'alert error' }, `Dernière erreur : ${b.lastError}`) : null)

  const tabs = drawer.querySelector('.drawer-tabs')
  const names = { console: 'Console', controls: 'Contrôles', mode: 'Mode', inventory: 'Inventaire', gui: 'Menu', graphs: 'Graphes', plugins: 'Plugins', logs: 'Journal' }
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

/** Reproduction du HUD du jeu : vie, faim, expérience et barre d'objets. */
function hud (b) {
  const hotbar = b.hotbar || Array(9).fill(null)
  const progress = b.xp ? Math.max(0, Math.min(1, b.xp.progress)) : 0
  return h('div', { class: `hud${b.status === 'online' ? '' : ' off'}` },
    h('div', { class: 'hud-bars' }, meter(b.health, 20, 'health', true), meter(b.food, 20, 'food reverse', true)),
    h('div', { class: 'xp', title: b.xp ? `Niveau ${b.xp.level} — ${Math.round(progress * 100)} %` : 'Expérience' },
      h('div', { class: 'xp-fill', style: { width: `${progress * 100}%` } }),
      b.xp && b.xp.level ? h('span', { class: 'xp-level' }, b.xp.level) : null),
    h('div', { class: 'hotbar' }, hotbar.map((it, i) => h('div', {
      class: `hud-slot${i === b.quickBarSlot ? ' active' : ''}`,
      title: it ? `${it.name} ×${it.count} — case ${i + 1}` : `Case ${i + 1} vide`,
      onclick: () => botAction(b.id, 'hotbar', { slot: i })
    }, it ? h('span', { class: 'hud-item' }, it.name.replace(/_/g, ' ')) : null, it && it.count > 1 ? h('span', { class: 'count' }, it.count) : null))))
}

function stat (label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'k' }, label), h('span', { class: 'v', title: String(value) }, String(value)))
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

const LOG_LEVEL = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', chat: 'CHAT' }

/** Une ligne au format de la console d'un serveur : [12:00:00 INFO] [source] message */
function logLine (l) {
  return h('div', { class: `log-line ${l.level}` },
    h('span', { class: 'lvl' }, `[${U.fmtTime(l.t)} ${LOG_LEVEL[l.level] || l.level.toUpperCase()}]`),
    h('span', { class: 'src' }, `[${l.source}]`), l.message)
}

function logFilter (l) {
  const src = $('log-source').value
  const q = $('log-search').value.toLowerCase()
  if (src && l.source !== src && !l.source.startsWith(`${src}/`)) return false
  if (!state.logLevels.has(l.level === 'chat' ? 'info' : l.level)) return false
  if (q && !`${l.source} ${l.message}`.toLowerCase().includes(q)) return false
  return true
}

/** Puces de niveau avec le nombre de lignes de chaque niveau. */
function renderLogLevels () {
  const counts = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const l of state.logs) counts[l.level === 'chat' ? 'info' : l.level] = (counts[l.level === 'chat' ? 'info' : l.level] || 0) + 1
  U.add(U.clear($('log-levels')), Object.keys(counts).map(level => h('button', {
    class: `lvl-${level}${state.logLevels.has(level) ? ' active' : ''}`,
    title: state.logLevels.has(level) ? 'Masquer ce niveau' : 'Afficher ce niveau',
    onclick: () => {
      if (state.logLevels.has(level)) state.logLevels.delete(level)
      else state.logLevels.add(level)
      U.store('log-levels', [...state.logLevels])
      renderLogs()
    }
  }, LOG_LEVEL[level], h('span', { class: 'n' }, counts[level]))))
}

function renderLogs () {
  renderLogLevels()
  const list = U.clear($('log-list'))
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
  addToFeed(lines)
  if (state.logs.length > 4000) state.logs.splice(0, state.logs.length - 4000)
  if (state.logPaused) return
  const tab = document.getElementById('tab-logs')
  if (tab.classList.contains('active')) {
    const list = $('log-list')
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    for (const l of lines.filter(logFilter)) list.appendChild(logLine(l))
    clearTimeout(onLogs.timer)
    onLogs.timer = setTimeout(renderLogLevels, 500)
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
    renderKpis()
  } catch (err) {
    U.toast(err.message, 'error')
  }
}

const REPORT_STATUS = { running: 'En cours', passed: 'Réussi', failed: 'Échoué', stopped: 'Arrêté', error: 'Erreur' }

function renderReports () {
  const list = U.clear(document.getElementById('report-list'))
  const reports = [...state.reports.values()].sort((a, b) => b.startedAt - a.startedAt)
  if (!reports.length) list.appendChild(h('div', { class: 'empty small' }, 'Aucun rapport pour l\'instant. Ils sont créés par les nœuds « Tests » des graphes et par les modes Testeur de commandes, Testeur de menus, Bâtisseur, Casseur et Observateur.'))
  const counts = { passed: 0, failed: 0, running: 0 }
  for (const r of reports) {
    if (counts[r.status] !== undefined) counts[r.status]++
    list.appendChild(h('div', {
      class: `report-row${state.openReport === r.id ? ' open' : ''}`,
      onclick: () => openReport(r.id)
    },
    stateTag(r.status, REPORT_STATUS),
    h('div', { class: 'grow' }, h('div', null, r.name), h('div', { class: 'muted tiny' }, `${U.fmtTime(r.startedAt)} • ${U.fmtDuration(r.duration)} • ${r.source || r.kind}`)),
    h('span', { class: 'counts' }, h('span', { class: 'ok' }, `${r.passed} ok`), ' · ', h('span', { class: r.failed ? 'error' : 'muted' }, `${r.failed} ko`), r.errors ? h('span', { class: 'warn' }, ` · ${r.errors} err`) : null)))
  }
  const failedAll = reports.filter(r => r.status === 'failed' || r.status === 'error').length
  U.add(U.clear($('report-summary')),
    h('div', { class: 'tile ok' }, h('b', null, counts.passed), 'réussis'),
    h('div', { class: `tile${failedAll ? ' bad' : ''}` }, h('b', null, failedAll), 'échoués'),
    h('div', { class: `tile${counts.running ? ' run' : ''}` }, h('b', null, counts.running), 'en cours'))
  if (!state.openReport) renderReportPlaceholder()
}

function renderReportPlaceholder () {
  U.add(U.clear($('report-detail')), h('div', { class: 'empty' },
    h('div', { class: 'empty-title' }, 'Aucun rapport ouvert'),
    h('p', null, 'Choisissez un rapport dans la liste pour voir ses vérifications, ses mesures et son journal.')))
}

/** Barre de réussite façon barre d'expérience : part verte = vérifications réussies. */
function passBar (r) {
  const total = r.passed + r.failed
  if (!total) return null
  return h('div', { class: 'pass-bar', title: `${r.passed} réussies sur ${total}` },
    h('div', { class: 'pass-fill', style: { width: `${(r.passed / total) * 100}%` } }),
    h('span', null, `${Math.round((r.passed / total) * 100)} %`))
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
        h('button', { class: 'btn small danger-ghost', onclick: async () => { await U.api('DELETE', `/api/reports/${id}`); state.reports.delete(id); state.openReport = null; renderReports() } }, 'Supprimer'))),
    passBar(r),
    r.assertions.length ? h('h4', null, `Vérifications — ${r.passed} ok, ${r.failed} ko`) : null,
    r.assertions.length ? h('div', { class: 'table' }, r.assertions.map(a => h('div', { class: `trow ${a.ok ? 'ok' : 'error'}` }, h('span', null, a.ok ? 'OK' : 'KO'), h('span', { class: 'time' }, U.fmtTime(a.t)), h('span', { class: 'grow' }, a.message)))) : null,
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
    h('pre', null, 'bot.health < 10 && hasItem(\'bread\')\n"Salut " + event.username\ncompteur % 10 == 0 ? "dizaine" : "autre"\nmatch(event.message, "(\\w+) a rejoint")[1]\ndistanceTo(0, 64, 0) > 20'),
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
  // Raccourcis : 1 à 5 = onglets (barre d'inventaire), T ou / = chat, N = nouveau bot, Échap = fermer la fiche.
  const tabKeys = ['dashboard', 'editor', 'reports', 'logs', 'help']
  document.addEventListener('keydown', ev => {
    // Échap ferme la fiche, même depuis sa console (sauf menu ou fenêtre ouverts).
    if (ev.key === 'Escape') {
      if (document.querySelector('.popup, dialog[open]') || document.activeElement === $('bulk-chat')) return
      if (state.openBot) {
        if (document.activeElement) document.activeElement.blur()
        closeDrawer()
      }
      return
    }
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (document.querySelector('dialog[open]')) return
    if (/^[1-5]$/.test(ev.key)) showTab(tabKeys[Number(ev.key) - 1])
    const onDashboard = $('tab-dashboard').classList.contains('active')
    if (onDashboard && (ev.key === 't' || ev.key === 'T' || ev.key === '/')) {
      ev.preventDefault()
      $('bulk-chat').focus()
      if (ev.key === '/') $('bulk-chat').value = '/'
    }
    if (onDashboard && (ev.key === 'n' || ev.key === 'N')) {
      ev.preventDefault()
      openNewBot()
    }
  })
  try {
    state.info = await U.api('GET', '/api/info')
  } catch (err) {
    document.body.prepend(h('div', { class: 'alert error' }, `Impossible de contacter le serveur : ${err.message}. Si l'interface est protégée, ajoutez ?token=… à l'adresse.`))
    return
  }
  fillSelects()
  renderHelp()
  editor = new GraphEditor($('editor-root'), {
    getBots: () => [...state.bots.values()],
    getSelectedBots: () => [...state.selected]
  })
  editor.setInfo(state.info)

  renderServerEntry()
  refreshServer()
  setInterval(() => {
    if ($('tab-dashboard').classList.contains('active') && !document.hidden) refreshServer()
  }, 20000)
  $('srv-test').addEventListener('click', testServer)
  $('server-form').addEventListener('submit', saveServer)
  $('srv-cancel').addEventListener('click', () => $('server-dialog').close())
  $('new-bot-btn').addEventListener('click', openNewBot)
  $('create-form').addEventListener('submit', createBots)
  $('create-cancel').addEventListener('click', () => $('new-bot-dialog').close())
  for (const d of document.querySelectorAll('dialog')) {
    // clic sur le fond assombri = fermer
    d.addEventListener('click', ev => { if (ev.target === d) d.close() })
  }
  $('select-all').addEventListener('change', ev => {
    state.selected = ev.target.checked ? new Set(state.bots.keys()) : new Set()
    renderBots()
    renderMap()
  })
  $('bot-search').addEventListener('input', ev => {
    state.search = ev.target.value
    renderBots()
  })
  document.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', () => bulk(b.dataset.bulk)))
  document.querySelectorAll('[data-menu]').forEach(b => b.addEventListener('click', () => openBulkMenu(b)))
  setupChatbar()
  $('map-dim').addEventListener('change', ev => {
    state.mapDim = ev.target.value
    renderMap()
  })
  window.addEventListener('resize', () => renderMap())
  $('feed-clear').addEventListener('click', () => {
    state.feed = []
    renderFeed()
  })
  for (const id of ['log-source', 'log-search']) $(id).addEventListener('input', renderLogs)
  $('log-pause').addEventListener('change', ev => {
    state.logPaused = ev.target.checked
    if (!state.logPaused) renderLogs()
  })
  $('log-clear').addEventListener('click', () => {
    state.logs = []
    renderLogs()
  })
  $('reports-clear').addEventListener('click', async () => {
    await U.api('DELETE', '/api/reports')
    state.openReport = null
    loadReports()
  })

  try {
    state.logs = await U.api('GET', '/api/logs?limit=1500')
  } catch (err) { /* ignore */ }
  addToFeed(state.logs)
  renderFeed()
  await loadGraphs()
  loadReports()

  const socket = io({ auth: { token: U.token } })
  const conn = document.getElementById('conn-status')
  socket.on('connect', () => { conn.className = 'led conn ok'; conn.title = 'Connecté au serveur' })
  socket.on('disconnect', () => { conn.className = 'led conn ko'; conn.title = 'Déconnecté du serveur' })
  socket.on('bots', list => {
    state.bots = new Map(list.map(b => [b.id, b]))
    sampleHistory()
    renderBots()
    renderKpis()
    renderMap()
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
    if ($('tab-reports').classList.contains('active')) {
      renderReports()
      if (state.openReport === r.id) openReport(r.id)
    }
    renderKpis()
    if (prev && prev.status === 'running' && r.status !== 'running') {
      U.toast(`${r.name} : ${r.passed} ok, ${r.failed} ko`, r.status === 'passed' ? 'success' : r.status === 'failed' ? 'error' : 'info', 5000, `Test ${(REPORT_STATUS[r.status] || r.status).toLowerCase()}`)
    }
  })
  socket.on('reportsCleared', loadReports)

  showTab(U.store('tab') || 'dashboard')
}

init()
