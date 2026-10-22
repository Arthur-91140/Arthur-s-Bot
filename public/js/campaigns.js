/* global U, state, $, showTab, openReport, serverSettings */
'use strict'

// Onglet Campagnes : scénarios de charge relançables (groupes de bots, préparation RCON,
// réglages du serveur, durée, critères de réussite) et suivi de la campagne en cours.
// Chargé avant app.js : les fonctions utilisent state et $ au moment de l'appel.

// eslint-disable-next-line no-unused-vars -- utilisé par app.js
const CampaignsUI = (() => {
  const h = U.h

  const SETTINGS = [
    ['view_distance', 'Distance de vue'],
    ['simulation_distance', 'Distance de simulation'],
    ['pause_when_empty_seconds', 'Pause quand vide (s)'],
    ['allow_flight', 'Vol autorisé (true/false)'],
    ['max_players', 'Joueurs max']
  ]

  const CRITERIA = [
    ['minAvgTps', 'TPS moyen minimum', 'ex. 18'],
    ['minLowTps', 'TPS minimum à tout instant', 'ex. 15'],
    ['minOnlineRatio', 'Part des bots en jeu (0 à 1)', 'ex. 0.95'],
    ['maxKicks', 'Expulsions maximum', 'ex. 0'],
    ['maxDeaths', 'Morts maximum', 'vide = non vérifié'],
    ['maxAvgLoginMs', 'Temps de connexion moyen max (ms)', 'ex. 3000'],
    ['maxLoopLag', 'Retard de boucle du programme max (ms)', 'ex. 250']
  ]

  let list = []
  let current = null // campagne en cours d'édition
  let dirty = false
  let ticker = null

  function blank () {
    return {
      id: '',
      name: 'Nouvelle campagne',
      description: '',
      server: { host: '', port: 0, version: '' },
      groups: [{ count: 10, namePattern: 'Charge_{i}', mode: 'wander', modeOptions: {}, graph: '' }],
      interleave: true,
      joinDelay: 1000,
      warmup: 15,
      duration: 120,
      connectTimeout: 0,
      autoReconnect: false,
      keepBots: false,
      setup: [],
      teardown: [],
      settings: {},
      criteria: { minAvgTps: 18, minLowTps: null, minOnlineRatio: 0.95, maxKicks: 0, maxDeaths: null, maxAvgLoginMs: null, maxLoopLag: 250, graphsPassed: true, serverSeesAll: false }
    }
  }

  async function load (selectId = null) {
    try {
      list = await U.api('GET', '/api/campaigns')
    } catch (err) {
      U.toast(err.message, 'error')
      return
    }
    renderList()
    const id = selectId || (current && current.id) || U.store('campaign') || (list[0] && list[0].id)
    if (id && list.some(c => c.id === id) && (!current || current.id !== id || selectId)) await select(id)
    else if (!current) renderEditor()
  }

  async function select (id) {
    if (dirty && current && !confirm('Abandonner les modifications non enregistrées ?')) return
    try {
      current = await U.api('GET', `/api/campaigns/${id}`)
      dirty = false
      U.store('campaign', id)
    } catch (err) {
      U.toast(err.message, 'error')
      return
    }
    renderList()
    renderEditor()
  }

  function renderList () {
    const box = U.clear($('campaign-list'))
    if (!list.length) box.appendChild(h('div', { class: 'muted small' }, 'Aucune campagne enregistrée.'))
    for (const c of list) {
      box.appendChild(h('div', {
        class: `report-row${current && current.id === c.id ? ' open' : ''}`,
        onclick: () => select(c.id)
      },
      h('div', { class: 'grow' }, h('div', null, c.name), h('div', { class: 'muted tiny' }, `${c.bots} bot${c.bots > 1 ? 's' : ''} • ${U.fmtDuration((c.duration || 0) * 1000)}`))))
    }
  }

  function mark () {
    dirty = true
    const save = $('campaign-save')
    if (save) save.classList.add('primary')
  }

  /** Champ lié à une propriété de la campagne en cours d'édition. */
  function bind (get, set, attrs = {}, parse = v => v) {
    const input = h(attrs.textarea ? 'textarea' : 'input', { type: attrs.type || 'text', placeholder: attrs.placeholder || '', class: attrs.class || null, rows: attrs.rows || null })
    if (attrs.type === 'checkbox') input.checked = !!get()
    else input.value = get() ?? ''
    input.addEventListener(attrs.type === 'checkbox' ? 'change' : 'input', () => {
      set(attrs.type === 'checkbox' ? input.checked : parse(input.value))
      mark()
    })
    return input
  }

  const numOrNull = v => (v === '' || v === null || !Number.isFinite(Number(v)) ? null : Number(v))

  function field (label, input, cls = '', help = null) {
    return h('div', { class: `field ${cls}` }, h('label', null, label), input, help ? h('small', null, help) : null)
  }

  function renderEditor () {
    const box = U.clear($('campaign-editor'))
    renderRun()
    if (!current) {
      box.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, 'Aucune campagne ouverte'),
        h('p', null, 'Une campagne décrit un test de charge complet : quels bots, combien, avec quels comportements, pendant combien de temps, et à quels critères il est réussi. Elle se relance en un clic ou en CI avec « arthur-bot campaign ».'),
        h('button', { class: 'btn primary', onclick: () => { current = blank(); dirty = true; renderEditor() } }, '+ Nouvelle campagne')))
      return
    }
    const c = current
    const modes = state.info.modes
    const graphs = state.graphs
    const groupsBox = h('div', { class: 'camp-groups' })
    const renderGroups = () => {
      U.clear(groupsBox)
      groupsBox.appendChild(h('div', { class: 'camp-group head' }, h('span', null, 'Nombre'), h('span', null, 'Motif de nom'), h('span', null, 'Mode'), h('span', null, 'Graphe'), h('span', null, '')))
      c.groups.forEach((g, i) => {
        const modeSel = h('select', null, modes.map(m => h('option', { value: m.name, selected: m.name === g.mode ? 'selected' : null }, m.label)))
        modeSel.addEventListener('change', () => { g.mode = modeSel.value; g.modeOptions = {}; mark() })
        const graphSel = h('select', null, h('option', { value: '' }, 'Aucun'), graphs.map(gr => h('option', { value: gr.id, selected: gr.id === g.graph ? 'selected' : null }, gr.name)))
        graphSel.addEventListener('change', () => { g.graph = graphSel.value; mark() })
        groupsBox.appendChild(h('div', { class: 'camp-group' },
          bind(() => g.count, v => { g.count = Math.max(1, Number(v) || 1) }, { type: 'number' }),
          bind(() => g.namePattern, v => { g.namePattern = v }, { placeholder: 'Charge_{i}' }),
          modeSel,
          graphSel,
          h('button', { class: 'btn small', title: g.mix ? `Population mixte définie dans le fichier : ${g.mix.map(m => `${m.weight} ${m.mode}`).join(', ')}` : 'Options du mode', onclick: () => editModeOptions(g) }, g.mix ? `Mixte (${g.mix.length})` : 'Options'),
          h('button', { class: 'btn small danger-ghost', title: 'Retirer ce groupe', disabled: c.groups.length < 2, onclick: () => { c.groups.splice(i, 1); mark(); renderGroups() } }, '×')))
      })
      groupsBox.appendChild(h('button', { class: 'btn small', onclick: () => { c.groups.push({ count: 5, namePattern: `Groupe${c.groups.length + 1}_{i}`, mode: 'idle', modeOptions: {}, graph: '' }); mark(); renderGroups() } }, '+ Groupe'))
    }
    renderGroups()

    const settingsRows = SETTINGS.map(([key, label]) => field(label, bind(() => (c.settings[key] !== undefined ? c.settings[key] : ''), v => {
      if (v === '') delete c.settings[key]
      else c.settings[key] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v
    }, { placeholder: 'inchangé' }), 'w-third'))

    const criteriaRows = CRITERIA.map(([key, label, ph]) => field(label, bind(() => c.criteria[key], v => { c.criteria[key] = numOrNull(v) }, { placeholder: ph, type: 'text' }), 'w-third'))

    U.add(box,
      h('div', { class: 'camp-head' },
        h('div', { class: 'grow' },
          bind(() => c.name, v => { c.name = v }, { class: 'camp-name' }),
          bind(() => c.description, v => { c.description = v }, { placeholder: 'Description (ce que la campagne vérifie)', class: 'camp-desc' })),
        h('div', { class: 'row' },
          h('button', { class: 'btn', id: 'campaign-save', onclick: save }, 'Enregistrer'),
          h('button', { class: 'btn success', onclick: run }, '▶ Lancer'))),
      h('h4', null, 'Bots'),
      groupsBox,
      h('div', { class: 'row wrap' },
        h('label', { class: 'check' }, bind(() => c.interleave, v => { c.interleave = v }, { type: 'checkbox' }), h('span', null, 'Mélanger les groupes à la connexion (population mixte)')),
        h('label', { class: 'check' }, bind(() => c.autoReconnect, v => { c.autoReconnect = v }, { type: 'checkbox' }), h('span', null, 'Reconnexion automatique')),
        h('label', { class: 'check' }, bind(() => c.keepBots, v => { c.keepBots = v }, { type: 'checkbox' }), h('span', null, 'Garder les bots à la fin'))),
      h('div', { class: 'row wrap' },
        field('Délai entre connexions (ms)', bind(() => c.joinDelay, v => { c.joinDelay = Number(v) || 0 }, { type: 'number' }), 'w-quarter'),
        field('Mise en route (s)', bind(() => c.warmup, v => { c.warmup = Number(v) || 0 }, { type: 'number' }), 'w-quarter', 'avant les mesures'),
        field('Durée de mesure (s)', bind(() => c.duration, v => { c.duration = Number(v) || 60 }, { type: 'number' }), 'w-quarter'),
        field('Délai de connexion (s)', bind(() => c.connectTimeout, v => { c.connectTimeout = Number(v) || 0 }, { type: 'number' }), 'w-quarter', '0 = automatique')),
      h('div', { class: 'row wrap' },
        field('Serveur (vide = serveur actuel)', bind(() => c.server.host, v => { c.server.host = v }, { placeholder: serverSettings().host }), 'grow'),
        field('Port', bind(() => c.server.port || '', v => { c.server.port = Number(v) || 0 }, { type: 'number', placeholder: String(serverSettings().port) }), 'w120'),
        field('Version', bind(() => c.server.version, v => { c.server.version = v }, { placeholder: 'auto' }), 'w120')),
      h('h4', null, 'Préparation et nettoyage'),
      h('div', { class: 'row wrap' },
        field('Commandes RCON avant le test (une par ligne)', bind(() => c.setup.join('\n'), v => { c.setup = v.split('\n') }, { textarea: true, rows: 4, class: 'mono', placeholder: 'time set day\nweather clear\ngamerule ...' }), 'grow'),
        field('Commandes RCON après le test', bind(() => c.teardown.join('\n'), v => { c.teardown = v.split('\n') }, { textarea: true, rows: 4, class: 'mono', placeholder: 'kill @e[type=item]' }), 'grow')),
      h('div', { class: 'row wrap' }, settingsRows),
      h('p', { class: 'muted tiny' }, 'Réglages appliqués par le protocole de gestion (1.21.9+) pendant la campagne, puis rétablis à la fin.'),
      h('h4', null, 'Critères de réussite'),
      h('div', { class: 'row wrap' }, criteriaRows),
      h('div', { class: 'row wrap' },
        h('label', { class: 'check' }, bind(() => c.criteria.graphsPassed, v => { c.criteria.graphsPassed = v }, { type: 'checkbox' }), h('span', null, 'Les graphes de test doivent réussir')),
        h('label', { class: 'check' }, bind(() => c.criteria.serverSeesAll, v => { c.criteria.serverSeesAll = v }, { type: 'checkbox' }), h('span', null, 'Le serveur doit voir tous les bots en jeu (1.21.9+)'))),
      h('div', { class: 'camp-foot' },
        h('span', { class: 'muted tiny grow' }, c.id ? `En CI : arthur-bot campaign ${c.id} --junit rapport.xml` : 'Enregistrez la campagne pour la lancer en CI.'),
        h('button', { class: 'btn small', onclick: () => U.download(`${c.id || 'campagne'}.json`, JSON.stringify(c, null, 2)) }, 'Exporter'),
        h('button', { class: 'btn small', onclick: () => { current = { ...JSON.parse(JSON.stringify(c)), id: '', name: `${c.name} (copie)` }; dirty = true; renderEditor() } }, 'Dupliquer'),
        c.id ? h('button', { class: 'btn small danger-ghost', onclick: remove }, 'Supprimer') : null))
  }

  /** Options du mode d'un groupe (mêmes champs que dans la fiche d'un bot). */
  function editModeOptions (g) {
    const def = state.info.modes.find(m => m.name === g.mode)
    if (!def || !def.options.length) {
      U.toast('Ce mode n\'a pas d\'options', 'info')
      return
    }
    const d = $('camp-options-dialog')
    const body = U.clear(d.querySelector('.camp-options-body'))
    d.querySelector('.screen-title').textContent = `Options : ${def.label}`
    for (const opt of def.options) {
      body.appendChild(U.paramInput(opt, g.modeOptions[opt.key], v => { g.modeOptions[opt.key] = v; mark() }, { modes: state.info.modes }))
    }
    d.showModal()
  }

  async function save () {
    if (!current) return null
    try {
      const saved = current.id
        ? await U.api('PUT', `/api/campaigns/${current.id}`, current)
        : await U.api('POST', '/api/campaigns', current)
      current = saved
      dirty = false
      U.store('campaign', saved.id)
      U.toast('Campagne enregistrée', 'success')
      await load(saved.id)
      return saved
    } catch (err) {
      U.toast(err.message, 'error')
      return null
    }
  }

  async function remove () {
    if (!current || !current.id || !confirm(`Supprimer la campagne « ${current.name} » ?`)) return
    try {
      await U.api('DELETE', `/api/campaigns/${current.id}`)
      current = null
      dirty = false
      U.store('campaign', null)
      await load()
      renderEditor()
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  async function run () {
    if (dirty || !current.id) {
      const saved = await save()
      if (!saved) return
    }
    try {
      state.campaign = await U.api('POST', `/api/campaigns/${current.id}/run`, { server: serverSettings() })
      U.toast(`Campagne « ${current.name} » lancée`, 'success')
      renderRun()
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  async function stop () {
    try {
      await U.api('POST', '/api/campaigns/stop')
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  // --- Suivi de la campagne en cours ----------------------------------------------------

  function renderRun () {
    const box = $('campaign-run')
    if (!box) return
    const r = state.campaign
    clearInterval(ticker)
    if (!r) {
      U.clear(box).hidden = true
      return
    }
    box.hidden = false
    const active = r.phase !== 'done'
    const draw = () => {
      const remaining = r.phaseEndsAt ? Math.max(0, r.phaseEndsAt - Date.now()) : null
      U.add(U.clear(box),
        h('div', { class: 'camp-run-head' },
          h('span', { class: `led ${active ? 'running' : r.status === 'passed' ? 'ok' : 'offline'}` }),
          h('b', { class: 'grow' }, r.name),
          h('span', { class: `state ${active ? 'running' : r.status}` }, active ? r.phaseLabel : (r.status === 'passed' ? 'Réussie' : r.status === 'failed' ? 'Échouée' : r.status === 'stopped' ? 'Arrêtée' : 'Erreur')),
          active
            ? h('button', { class: 'btn small danger-ghost', onclick: stop }, 'Arrêter')
            : h('button', { class: 'btn small', onclick: () => { showTab('reports'); openReport(r.reportId) } }, 'Voir le rapport')),
        h('div', { class: 'camp-steps' }, ['preparing', 'connecting', 'warmup', 'measuring', 'finishing'].map(p => {
          const order = ['preparing', 'connecting', 'warmup', 'measuring', 'finishing', 'done']
          const cls = order.indexOf(r.phase) > order.indexOf(p) ? 'done' : r.phase === p ? 'on' : ''
          return h('span', { class: `camp-step ${cls}` }, { preparing: 'Préparation', connecting: 'Connexion', warmup: 'Mise en route', measuring: 'Mesure', finishing: 'Nettoyage' }[p])
        })),
        h('div', { class: 'camp-run-info' },
          h('span', null, `${r.online}/${r.expected} bots en jeu`),
          remaining !== null && active ? h('span', null, `${U.fmtDuration(remaining)} restantes`) : null,
          h('span', null, `démarrée à ${U.fmtTime(r.startedAt)}`),
          r.samples ? h('span', null, `${r.samples} mesures`) : null,
          r.message ? h('span', { class: 'warn' }, r.message) : null))
    }
    draw()
    if (active) ticker = setInterval(draw, 1000)
  }

  function onUpdate (run) {
    const before = state.campaign
    state.campaign = run
    renderRun()
    if (before && before.phase !== 'done' && run && run.phase === 'done') {
      U.toast(`${run.name} : ${run.status === 'passed' ? 'réussie' : run.status === 'failed' ? 'échouée' : run.status}`, run.status === 'passed' ? 'success' : 'error', 6000, 'Campagne terminée')
    }
  }

  function create () {
    if (dirty && current && !confirm('Abandonner les modifications non enregistrées ?')) return
    current = blank()
    dirty = true
    renderList()
    renderEditor()
  }

  return { load, renderEditor, onUpdate, renderRun, create }
})()
