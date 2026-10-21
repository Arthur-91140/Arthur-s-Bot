/* Éditeur visuel de comportements (graphes de nœuds). */
'use strict'
/* global U */

const GRID = 10
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2

function uid (prefix = 'n') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3)
}

class GraphEditor {
  constructor (root, { getBots, getSelectedBots }) {
    this.root = root
    this.getBots = getBots
    this.getSelectedBots = getSelectedBots
    this.info = null
    this.defs = new Map()
    this.graphs = []
    this.graph = null
    this.view = { x: 80, y: 60, zoom: 1 }
    this.selected = new Set()
    this.selectedLink = null
    this.undoStack = []
    this.redoStack = []
    this.pendingSnapshot = null
    this.dirty = false
    this.clipboard = null
    this.nodeEls = new Map()
    this.errors = new Map()
    this.drag = null
    this.popup = null
    this.build()
  }

  // --- Construction de l'interface ----------------------------------------

  build () {
    const { h } = U
    const e = this.el = {}
    e.graphSelect = h('select', { title: 'Ouvrir un graphe enregistré', onchange: ev => this.openSaved(ev.target.value) })
    e.dirty = h('span', { class: 'dirty-mark', title: 'Modifications non enregistrées' })
    e.title = h('span', { class: 'graph-title' })
    e.fileInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: ev => this.importFile(ev.target.files[0]) })
    e.runInfo = h('span', { class: 'run-info' })
    e.zoomLabel = h('span', { class: 'zoom-label' }, '100 %')
    const btn = (label, title, fn, cls = '') => h('button', { class: `btn ${cls}`, title, onclick: fn }, label)
    e.toolbar = h('div', { class: 'editor-toolbar' },
      h('div', { class: 'group' }, e.graphSelect, e.title, e.dirty),
      h('div', { class: 'group' },
        btn('Nouveau', 'Nouveau graphe', () => this.newGraph()),
        btn('Enregistrer', 'Enregistrer (Ctrl+S)', () => this.save(), 'primary'),
        btn('Copie', 'Enregistrer une copie', () => this.save(true)),
        btn('Supprimer', 'Supprimer ce graphe du disque', () => this.removeSaved(), 'danger-ghost'),
        btn('Importer', 'Importer un fichier JSON', () => e.fileInput.click()),
        btn('Exporter', 'Télécharger en JSON', () => this.exportFile()),
        btn('Vérifier', 'Valider le graphe', () => this.validate(true))),
      h('div', { class: 'group' },
        btn('▶ Lancer', 'Exécuter ce graphe (même non enregistré) sur des bots', ev => this.showRunMenu(ev.currentTarget), 'success'),
        btn('■ Arrêter', 'Arrêter toutes les exécutions de ce graphe', () => this.stopRuns(), 'danger'),
        e.runInfo),
      h('div', { class: 'group' },
        btn('−', 'Dézoomer', () => this.zoomBy(1 / 1.2)), e.zoomLabel, btn('+', 'Zoomer', () => this.zoomBy(1.2)),
        btn('⤢', 'Tout afficher (F)', () => this.fit()),
        btn('↶', 'Annuler (Ctrl+Z)', () => this.undo()), btn('↷', 'Rétablir (Ctrl+Y)', () => this.redo())),
      e.fileInput)

    e.search = h('input', { type: 'search', placeholder: 'Rechercher un nœud…', oninput: () => this.renderPalette() })
    e.paletteList = h('div', { class: 'palette-list' })
    e.palette = h('aside', { class: 'palette' }, e.search, e.paletteList)

    const svgNS = 'http://www.w3.org/2000/svg'
    e.svg = document.createElementNS(svgNS, 'svg')
    e.svg.setAttribute('class', 'links')
    e.tempPath = document.createElementNS(svgNS, 'path')
    e.tempPath.setAttribute('class', 'link temp')
    e.nodes = h('div', { class: 'nodes' })
    e.world = h('div', { class: 'world' }, e.svg, e.nodes)
    e.box = h('div', { class: 'select-box', style: { display: 'none' } })
    e.hint = h('div', { class: 'canvas-hint' },
      'Glissez un nœud depuis la palette • double-clic : ajout rapide • glisser une sortie vers une entrée pour relier • molette : zoom • clic droit : menu')
    e.canvas = h('div', { class: 'canvas', tabindex: '0' }, e.world, e.box, e.hint)

    e.inspector = h('aside', { class: 'inspector' })
    this.root.appendChild(h('div', { class: 'editor' }, e.toolbar, h('div', { class: 'editor-body' }, e.palette, e.canvas, e.inspector)))

    const c = e.canvas
    c.addEventListener('mousedown', ev => this.onMouseDown(ev))
    window.addEventListener('mousemove', ev => this.onMouseMove(ev))
    window.addEventListener('mouseup', ev => this.onMouseUp(ev))
    c.addEventListener('wheel', ev => this.onWheel(ev), { passive: false })
    c.addEventListener('dblclick', ev => {
      if (ev.target.closest('.node')) return
      this.showQuickAdd(ev.clientX, ev.clientY)
    })
    c.addEventListener('contextmenu', ev => this.onContextMenu(ev))
    c.addEventListener('dragover', ev => ev.preventDefault())
    c.addEventListener('drop', ev => {
      ev.preventDefault()
      const type = ev.dataTransfer.getData('text/x-node-type')
      if (type) {
        const p = this.toWorld(ev.clientX, ev.clientY)
        this.addNode(type, p.x - 90, p.y - 15)
      }
    })
    document.addEventListener('keydown', ev => this.onKey(ev))
    e.inspector.addEventListener('focusin', () => { this.pendingSnapshot = this.snapshot() })
    window.addEventListener('beforeunload', ev => {
      if (this.dirty) {
        ev.preventDefault()
        ev.returnValue = ''
      }
    })
    this.applyView()
  }

  setInfo (info) {
    this.info = info
    this.defs = new Map(info.nodes.map(d => [d.type, d]))
    this.renderPalette()
    if (!this.graph) {
      const draft = U.store('editor-draft')
      if (draft && draft.nodes) {
        this.load(draft, { keepDirty: true })
      } else {
        this.newGraph(true)
      }
    }
  }

  setGraphs (list) {
    this.graphs = list
    const { h } = U
    U.clear(this.el.graphSelect)
    this.el.graphSelect.appendChild(h('option', { value: '' }, `Ouvrir… (${list.length})`))
    for (const g of list) {
      this.el.graphSelect.appendChild(h('option', { value: g.id, selected: this.graph && g.id === this.graph.id ? 'selected' : null }, `${g.name} (${g.nodes})`))
    }
  }

  isVisible () {
    return this.root.offsetParent !== null
  }

  // --- Palette ---------------------------------------------------------------

  renderPalette () {
    if (!this.info) return
    const { h } = U
    const q = this.el.search.value.trim().toLowerCase()
    const list = U.clear(this.el.paletteList)
    const collapsed = U.store('palette-collapsed') || {}
    for (const cat of this.info.categories) {
      const defs = this.info.nodes.filter(d => d.category === cat.name &&
        (!q || d.label.toLowerCase().includes(q) || d.type.includes(q) || d.description.toLowerCase().includes(q)))
      if (!defs.length) continue
      const isCollapsed = !q && collapsed[cat.name]
      const items = h('div', { class: 'palette-items' }, defs.map(d => h('div', {
        class: 'palette-item',
        draggable: 'true',
        title: d.description,
        style: { borderLeftColor: d.color },
        ondragstart: ev => ev.dataTransfer.setData('text/x-node-type', d.type),
        onclick: () => {
          const r = this.el.canvas.getBoundingClientRect()
          const p = this.toWorld(r.left + r.width / 2, r.top + r.height / 3)
          const spot = this.freeSpot(p.x - 100, p.y)
          this.addNode(d.type, spot.x, spot.y)
        }
      }, d.event ? '⚡ ' : '', d.label)))
      list.appendChild(h('div', { class: `palette-cat${isCollapsed ? ' collapsed' : ''}` },
        h('div', {
          class: 'palette-cat-title',
          style: { color: cat.color },
          onclick: () => {
            collapsed[cat.name] = !collapsed[cat.name]
            U.store('palette-collapsed', collapsed)
            this.renderPalette()
          }
        }, `${isCollapsed ? '▸' : '▾'} ${cat.name}`, h('span', { class: 'count' }, defs.length)),
        isCollapsed ? null : items))
    }
  }

  // --- Modèle -------------------------------------------------------------------

  emptyGraph () {
    return {
      id: '',
      name: 'Nouveau comportement',
      description: '',
      variables: {},
      nodes: [{ id: uid(), type: 'event.start', x: 60, y: 80, params: {} }],
      links: []
    }
  }

  snapshot () {
    return JSON.stringify({ g: this.graph })
  }

  checkpoint () {
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
  }

  markDirty () {
    this.dirty = true
    this.el.dirty.textContent = '●'
    this.saveDraft()
  }

  saveDraft () {
    clearTimeout(this._draftTimer)
    this._draftTimer = setTimeout(() => U.store('editor-draft', this.serialize()), 500)
  }

  restore (snap) {
    const { g } = JSON.parse(snap)
    this.graph = g
    this.selected.clear()
    this.selectedLink = null
    this.render()
    this.markDirty()
  }

  undo () {
    if (!this.undoStack.length) return
    this.redoStack.push(this.snapshot())
    this.restore(this.undoStack.pop())
  }

  redo () {
    if (!this.redoStack.length) return
    this.undoStack.push(this.snapshot())
    this.restore(this.redoStack.pop())
  }

  serialize () {
    return JSON.parse(JSON.stringify({ ...this.graph, view: { ...this.view } }))
  }

  load (graph, { keepDirty = false } = {}) {
    const g = JSON.parse(JSON.stringify(graph))
    g.nodes = (g.nodes || []).map(n => ({ x: 0, y: 0, params: {}, ...n }))
    g.links = (g.links || []).map(l => ({ id: l.id || uid('l'), fromPort: 'out', toPort: 'in', ...l }))
    g.variables = g.variables || {}
    this.graph = g
    this.selected.clear()
    this.selectedLink = null
    this.errors.clear()
    this.undoStack = []
    this.redoStack = []
    this.dirty = keepDirty
    this.el.dirty.textContent = keepDirty ? '●' : ''
    if (g.view) this.view = { ...g.view }
    this.render()
    if (!g.view) requestAnimationFrame(() => this.fit())
    this.updateRunInfo()
  }

  newGraph (silent = false) {
    if (!silent && this.dirty && !confirm('Abandonner les modifications non enregistrées ?')) return
    this.view = { x: 80, y: 60, zoom: 1 }
    this.load(this.emptyGraph())
    U.store('editor-draft', null)
  }

  async openSaved (id) {
    this.el.graphSelect.value = ''
    if (!id) return
    if (this.dirty && !confirm('Abandonner les modifications non enregistrées ?')) return
    try {
      const g = await U.api('GET', `/api/graphs/${encodeURIComponent(id)}`)
      this.load(g)
      U.store('editor-draft', null)
      U.toast(`Graphe « ${g.name} » ouvert`)
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  async save (asCopy = false) {
    const data = this.serialize()
    if (asCopy || !data.id) {
      const name = prompt('Nom du graphe :', asCopy ? `${data.name} (copie)` : data.name)
      if (!name) return
      data.name = name
      data.id = ''
      if (!asCopy) this.graph.name = name
    }
    try {
      const saved = await U.api(data.id ? 'PUT' : 'POST', data.id ? `/api/graphs/${encodeURIComponent(data.id)}` : '/api/graphs', data)
      this.graph.id = saved.id
      this.graph.name = saved.name
      this.dirty = false
      this.el.dirty.textContent = ''
      U.store('editor-draft', null)
      this.showValidation(saved.validation)
      this.renderInspector()
      this.renderTitle()
      U.toast(`Enregistré : ${saved.id}.json`, 'success')
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  async removeSaved () {
    if (!this.graph.id) return U.toast('Ce graphe n\'est pas encore enregistré', 'warn')
    if (!confirm(`Supprimer définitivement « ${this.graph.name} » (${this.graph.id}.json) ?`)) return
    try {
      await U.api('DELETE', `/api/graphs/${encodeURIComponent(this.graph.id)}`)
      U.toast('Graphe supprimé')
      this.graph.id = ''
      this.markDirty()
      this.renderTitle()
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  exportFile () {
    const data = this.serialize()
    U.download(`${data.id || 'comportement'}.json`, JSON.stringify(data, null, 2))
  }

  importFile (file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const g = JSON.parse(reader.result)
        if (!Array.isArray(g.nodes)) throw new Error('Fichier sans liste de nœuds')
        g.id = ''
        this.load(g, { keepDirty: true })
        U.toast(`Importé : ${g.name || file.name}`, 'success')
      } catch (err) {
        U.toast(`Import impossible : ${err.message}`, 'error')
      }
    }
    reader.readAsText(file)
    this.el.fileInput.value = ''
  }

  async validate (showToast = false) {
    try {
      const res = await U.api('POST', '/api/validate', this.serialize())
      this.showValidation(res)
      if (showToast) {
        if (res.errors.length) U.toast(`${res.errors.length} erreur(s)`, 'error')
        else if (res.warnings.length) U.toast(`${res.warnings.length} avertissement(s)`, 'warn')
        else U.toast('Graphe valide', 'success')
      }
      return res
    } catch (err) {
      U.toast(err.message, 'error')
      return null
    }
  }

  showValidation (res) {
    this.validation = res
    if (!this.selected.size) this.renderInspector()
  }

  // --- Exécution -------------------------------------------------------------

  showRunMenu (anchor) {
    const { h } = U
    const bots = this.getBots()
    if (!bots.length) return U.toast('Aucun bot : créez-en un dans le tableau de bord', 'warn')
    const pre = new Set(this.getSelectedBots())
    const boxes = bots.map(b => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', value: b.id, checked: pre.size ? pre.has(b.id) : b.status === 'online' }),
      h('span', { class: `dot ${b.status}` }), b.id))
    const menu = this.openPopup(anchor, h('div', { class: 'run-menu' },
      h('div', { class: 'popup-title' }, 'Lancer sur…'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => boxes.forEach(l => { l.firstChild.checked = true }) }, 'Tous'),
        h('button', { class: 'btn small', onclick: () => boxes.forEach(l => { l.firstChild.checked = false }) }, 'Aucun')),
      h('div', { class: 'check-list' }, boxes),
      h('button', {
        class: 'btn success full',
        onclick: async () => {
          const targets = boxes.filter(l => l.firstChild.checked).map(l => l.firstChild.value)
          this.closePopup()
          if (!targets.length) return
          await this.run(targets)
        }
      }, '▶ Lancer')))
    return menu
  }

  async run (targets) {
    const res = await this.validate()
    if (res && res.errors.length) return U.toast('Corrigez les erreurs avant de lancer', 'error')
    this.errors.clear()
    for (const el of this.nodeEls.values()) el.classList.remove('error')
    try {
      const data = this.serialize()
      if (!data.id) data.id = 'brouillon'
      const runs = await U.api('POST', '/api/run', { graph: data, targets })
      this.runGraphId = data.id
      U.toast(`Lancé sur ${runs.length} bot(s)`, 'success')
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  async stopRuns () {
    try {
      const res = await U.api('POST', '/api/runtimes/stop', { graphId: this.graph.id || 'brouillon' })
      U.toast(`${res.stopped} exécution(s) arrêtée(s)`)
    } catch (err) {
      U.toast(err.message, 'error')
    }
  }

  updateRunInfo () {
    const id = this.graph ? (this.graph.id || 'brouillon') : null
    let n = 0
    for (const b of this.getBots()) n += b.runtimes.filter(r => r.graphId === id && r.status === 'running').length
    this.el.runInfo.textContent = n ? `${n} en cours` : ''
    this.el.runInfo.classList.toggle('active', n > 0)
  }

  /** Surbrillance des nœuds exécutés (traces envoyées par le serveur). */
  trace (traces) {
    const id = this.graph ? (this.graph.id || 'brouillon') : null
    for (const t of traces) {
      if (t.graphId !== id) continue
      const el = this.nodeEls.get(t.nodeId)
      if (!el) continue
      if (t.error) {
        this.errors.set(t.nodeId, `${t.botId} : ${t.error}`)
        el.classList.add('error')
        el.title = this.errors.get(t.nodeId)
      }
      // retire puis remet la classe (après un reflow) pour rejouer l'animation
      el.classList.remove('flash')
      el.getBoundingClientRect()
      el.classList.add('flash')
    }
  }

  // --- Rendu -----------------------------------------------------------------

  renderTitle () {
    this.el.title.textContent = this.graph.name + (this.graph.id ? ` — ${this.graph.id}.json` : ' — non enregistré')
  }

  render () {
    U.clear(this.el.nodes)
    this.nodeEls.clear()
    for (const node of this.graph.nodes) this.renderNode(node)
    this.renderLinks()
    this.renderInspector()
    this.renderTitle()
    this.el.hint.style.display = this.graph.nodes.length > 2 ? 'none' : ''
  }

  summary (node, def) {
    const lines = []
    for (const p of def.params) {
      const v = node.params[p.key] === undefined ? p.default : node.params[p.key]
      if (v === '' || v === undefined || v === null) continue
      let text = typeof v === 'object' ? JSON.stringify(v) : String(v)
      if (p.type === 'boolean') text = v ? 'oui' : 'non'
      if (p.type === 'select') {
        const o = U.optionList(p.options).find(x => x.value === v)
        if (o) text = o.label
      }
      if (p.type === 'mode' && this.info) {
        const m = this.info.modes.find(x => x.name === v)
        if (m) text = m.label
      }
      lines.push([p.label, text])
      if (lines.length >= 3) break
    }
    return lines
  }

  renderNode (node) {
    const { h } = U
    const def = this.defs.get(node.type)
    let el
    if (!def) {
      el = h('div', { class: 'node unknown', dataset: { id: node.id } },
        h('div', { class: 'node-header' }, h('span', { class: 'port in', dataset: { port: 'in' } }), `Type inconnu : ${node.type}`))
    } else if (def.passive) {
      el = h('div', { class: 'node comment', dataset: { id: node.id } },
        h('div', { class: 'node-header', style: { background: def.color } }, '💬 ', def.label),
        h('div', { class: 'comment-text' }, node.params.text ?? def.params[0].default))
    } else {
      const outputs = def.outputs.map(o => h('div', { class: 'out-row' },
        h('span', { class: 'out-label' }, o.label),
        h('span', { class: 'port out', dataset: { port: o.name }, title: o.label || o.name })))
      el = h('div', { class: `node${def.event ? ' event' : ''}`, dataset: { id: node.id }, title: def.description },
        h('div', { class: 'node-header', style: { background: def.color } },
          def.input ? h('span', { class: 'port in', dataset: { port: 'in' }, title: 'Entrée' }) : null,
          h('span', { class: 'node-title' }, def.event ? '⚡ ' : '', def.label)),
        h('div', { class: 'node-body' },
          h('div', { class: 'node-summary' }, this.summary(node, def).map(([k, v]) =>
            h('div', { class: 'sum-line' }, h('span', { class: 'k' }, `${k} : `), h('span', { class: 'v' }, v.length > 38 ? v.slice(0, 36) + '…' : v)))),
          outputs.length ? h('div', { class: 'node-outputs' }, outputs) : null))
    }
    el.style.left = `${node.x}px`
    el.style.top = `${node.y}px`
    if (this.selected.has(node.id)) el.classList.add('selected')
    if (this.errors.has(node.id)) {
      el.classList.add('error')
      el.title = this.errors.get(node.id)
    }
    const old = this.nodeEls.get(node.id)
    if (old && old.parentNode) old.replaceWith(el)
    else this.el.nodes.appendChild(el)
    this.nodeEls.set(node.id, el)
    return el
  }

  portPos (nodeId, port, dir) {
    const el = this.nodeEls.get(nodeId)
    if (!el) return null
    const p = el.querySelector(`.port.${dir}[data-port="${CSS.escape(port)}"]`)
    if (!p) return null
    const r = p.getBoundingClientRect()
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2)
  }

  curve (a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2)
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
  }

  renderLinks () {
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = this.el.svg
    while (svg.firstChild) svg.removeChild(svg.firstChild)
    for (const link of this.graph.links) {
      const a = this.portPos(link.from, link.fromPort, 'out')
      const b = this.portPos(link.to, 'in', 'in')
      if (!a || !b) continue
      const hit = document.createElementNS(svgNS, 'path')
      hit.setAttribute('d', this.curve(a, b))
      hit.setAttribute('class', 'link-hit')
      hit.dataset.id = link.id
      const path = document.createElementNS(svgNS, 'path')
      path.setAttribute('d', this.curve(a, b))
      path.setAttribute('class', `link${this.selectedLink === link.id ? ' selected' : ''}`)
      const def = this.defs.get((this.graph.nodes.find(n => n.id === link.from) || {}).type)
      if (def) path.style.stroke = def.color
      svg.appendChild(path)
      svg.appendChild(hit)
    }
    svg.appendChild(this.el.tempPath)
  }

  renderInspector () {
    const { h } = U
    const box = U.clear(this.el.inspector)
    if (this.selected.size === 1) {
      const node = this.graph.nodes.find(n => this.selected.has(n.id))
      const def = node && this.defs.get(node.type)
      if (node && def) {
        box.appendChild(h('div', { class: 'insp-head', style: { borderColor: def.color } },
          h('div', { class: 'insp-cat', style: { color: def.color } }, def.category),
          h('h3', null, def.label),
          h('p', { class: 'muted' }, def.description)))
        if (this.errors.has(node.id)) box.appendChild(h('div', { class: 'alert error' }, this.errors.get(node.id)))
        for (const p of def.params) {
          box.appendChild(U.paramInput(p, node.params[p.key], (value, commit) => {
            node.params[p.key] = value
            if (commit && this.pendingSnapshot) {
              this.undoStack.push(this.pendingSnapshot)
              this.redoStack = []
              this.pendingSnapshot = this.snapshot()
            }
            this.renderNode(node)
            this.renderLinks()
            this.markDirty()
          }, { modes: this.info.modes }))
        }
        if (def.outputs.length) {
          box.appendChild(h('div', { class: 'muted small' }, 'Sorties : ', def.outputs.map(o => o.label || o.name).join(', ')))
        }
        box.appendChild(h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => this.duplicate() }, 'Dupliquer'),
          h('button', { class: 'btn small danger-ghost', onclick: () => this.deleteSelection() }, 'Supprimer')))
        box.appendChild(h('div', { class: 'muted tiny' }, `id : ${node.id} • type : ${node.type}`))
        return
      }
    }
    if (this.selected.size > 1) {
      box.appendChild(h('h3', null, `${this.selected.size} nœuds sélectionnés`))
      box.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => this.duplicate() }, 'Dupliquer'),
        h('button', { class: 'btn small danger-ghost', onclick: () => this.deleteSelection() }, 'Supprimer')))
      return
    }
    // Propriétés du graphe
    const g = this.graph
    box.appendChild(h('h3', null, 'Graphe'))
    box.appendChild(U.paramInput({ key: 'name', label: 'Nom', type: 'string' }, g.name, (v, commit) => {
      g.name = v
      this.renderTitle()
      this.markDirty()
      if (commit) this.checkpoint()
    }))
    box.appendChild(U.paramInput({ key: 'description', label: 'Description', type: 'text' }, g.description, v => {
      g.description = v
      this.markDirty()
    }))
    const varsField = U.paramInput({ key: 'variables', label: 'Variables initiales (JSON)', type: 'json', help: 'Ex. {"compteur": 0, "cible": "Steve"}' },
      JSON.stringify(g.variables || {}, null, 1), (v, commit) => {
        if (!commit) return
        try {
          g.variables = v.trim() ? JSON.parse(v) : {}
          varsField.classList.remove('invalid')
          this.markDirty()
        } catch (err) {
          varsField.classList.add('invalid')
          U.toast('JSON des variables invalide', 'error')
        }
      })
    box.appendChild(varsField)
    box.appendChild(h('div', { class: 'muted small' }, `${g.nodes.length} nœuds • ${g.links.length} liens`))
    if (this.validation) {
      for (const e of this.validation.errors) box.appendChild(h('div', { class: 'alert error' }, e))
      for (const w of this.validation.warnings) box.appendChild(h('div', { class: 'alert warn' }, w))
    }
    box.appendChild(h('details', { class: 'shortcuts' },
      h('summary', null, 'Raccourcis'),
      h('ul', null,
        ['Suppr : supprimer la sélection', 'Ctrl+C / Ctrl+V : copier / coller', 'Ctrl+D : dupliquer', 'Ctrl+Z / Ctrl+Y : annuler / rétablir',
          'Ctrl+S : enregistrer', 'Ctrl+A : tout sélectionner', 'F : tout afficher', 'Maj + glisser : sélection rectangulaire',
          'Glisser une entrée reliée : détacher le lien', 'Double-clic sur le fond : ajout rapide'].map(t => h('li', null, t)))))
  }

  // --- Vue (pan / zoom) ---------------------------------------------------------

  applyView () {
    const { x, y, zoom } = this.view
    this.el.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
    const size = GRID * 2 * zoom
    const big = size * 5
    this.el.canvas.style.backgroundSize = `${size}px ${size}px, ${size}px ${size}px, ${big}px ${big}px, ${big}px ${big}px`
    this.el.canvas.style.backgroundPosition = `${x}px ${y}px`
    this.el.zoomLabel.textContent = `${Math.round(zoom * 100)} %`
  }

  toWorld (clientX, clientY) {
    const r = this.el.canvas.getBoundingClientRect()
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom }
  }

  zoomAt (clientX, clientY, factor) {
    const r = this.el.canvas.getBoundingClientRect()
    const before = this.toWorld(clientX, clientY)
    this.view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor))
    this.view.x = clientX - r.left - before.x * this.view.zoom
    this.view.y = clientY - r.top - before.y * this.view.zoom
    this.applyView()
  }

  zoomBy (factor) {
    const r = this.el.canvas.getBoundingClientRect()
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor)
  }

  fit () {
    if (!this.graph.nodes.length) return
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const n of this.graph.nodes) {
      const el = this.nodeEls.get(n.id)
      const w = el ? el.offsetWidth : 200
      const hgt = el ? el.offsetHeight : 80
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + w)
      maxY = Math.max(maxY, n.y + hgt)
    }
    const r = this.el.canvas.getBoundingClientRect()
    if (!r.width) return
    const pad = 60
    const zoom = Math.min(1.2, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))))
    this.view = { zoom, x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (r.height - (maxY - minY) * zoom) / 2 - minY * zoom }
    this.applyView()
  }

  onWheel (ev) {
    ev.preventDefault()
    if (ev.ctrlKey || !ev.shiftKey) this.zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1)
    else {
      this.view.x -= ev.deltaY
      this.applyView()
    }
  }

  // --- Souris ----------------------------------------------------------------------

  onMouseDown (ev) {
    this.closePopup()
    this.el.canvas.focus({ preventScroll: true })
    const port = ev.target.closest('.port')
    const nodeEl = ev.target.closest('.node')
    const hit = ev.target.closest('.link-hit')
    if (ev.button === 1) {
      ev.preventDefault()
      this.drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false }
      return
    }
    if (ev.button !== 0) return

    if (port && nodeEl) {
      ev.preventDefault()
      const nodeId = nodeEl.dataset.id
      if (port.classList.contains('out')) {
        this.startLinkDrag(nodeId, port.dataset.port)
      } else {
        const existing = [...this.graph.links].reverse().find(l => l.to === nodeId)
        if (existing) {
          this.checkpoint()
          this.graph.links = this.graph.links.filter(l => l !== existing)
          this.markDirty()
          this.renderLinks()
          this.startLinkDrag(existing.from, existing.fromPort)
        }
      }
      if (this.drag) this.updateTempLink(ev.clientX, ev.clientY)
      return
    }
    if (hit) {
      this.selectedLink = hit.dataset.id
      this.selected.clear()
      this.refreshSelection()
      this.renderLinks()
      return
    }
    if (nodeEl) {
      ev.preventDefault()
      const id = nodeEl.dataset.id
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        if (this.selected.has(id)) this.selected.delete(id)
        else this.selected.add(id)
      } else if (!this.selected.has(id)) {
        this.selected = new Set([id])
      }
      this.selectedLink = null
      this.refreshSelection()
      const origins = new Map()
      for (const n of this.graph.nodes) if (this.selected.has(n.id)) origins.set(n.id, { x: n.x, y: n.y })
      this.drag = { kind: 'nodes', sx: ev.clientX, sy: ev.clientY, origins, before: this.snapshot(), moved: false }
      return
    }
    // fond du canevas
    if (ev.shiftKey) {
      this.drag = { kind: 'box', sx: ev.clientX, sy: ev.clientY, moved: false }
      return
    }
    this.drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false }
  }

  startLinkDrag (from, fromPort) {
    this.drag = { kind: 'link', from, fromPort, start: this.portPos(from, fromPort, 'out') }
    this.el.tempPath.style.display = ''
  }

  updateTempLink (clientX, clientY) {
    if (!this.drag || this.drag.kind !== 'link' || !this.drag.start) return
    this.el.tempPath.setAttribute('d', this.curve(this.drag.start, this.toWorld(clientX, clientY)))
  }

  onMouseMove (ev) {
    const d = this.drag
    if (!d) return
    const dx = ev.clientX - d.sx
    const dy = ev.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    switch (d.kind) {
      case 'pan':
        this.view.x = d.vx + dx
        this.view.y = d.vy + dy
        this.applyView()
        break
      case 'nodes': {
        if (!d.moved) return
        const snap = v => (ev.altKey ? v : Math.round(v / GRID) * GRID)
        for (const n of this.graph.nodes) {
          const o = d.origins.get(n.id)
          if (!o) continue
          n.x = snap(o.x + dx / this.view.zoom)
          n.y = snap(o.y + dy / this.view.zoom)
          const el = this.nodeEls.get(n.id)
          el.style.left = `${n.x}px`
          el.style.top = `${n.y}px`
        }
        this.renderLinks()
        break
      }
      case 'link':
        this.updateTempLink(ev.clientX, ev.clientY)
        break
      case 'box': {
        const r = this.el.canvas.getBoundingClientRect()
        Object.assign(this.el.box.style, {
          display: 'block',
          left: `${Math.min(ev.clientX, d.sx) - r.left}px`,
          top: `${Math.min(ev.clientY, d.sy) - r.top}px`,
          width: `${Math.abs(dx)}px`,
          height: `${Math.abs(dy)}px`
        })
        break
      }
    }
  }

  onMouseUp (ev) {
    const d = this.drag
    if (!d) return
    this.drag = null
    switch (d.kind) {
      case 'pan':
        if (!d.moved && ev.target.closest && ev.target.closest('.canvas')) {
          this.selected.clear()
          this.selectedLink = null
          this.refreshSelection()
          this.renderLinks()
        }
        break
      case 'nodes':
        if (d.moved) {
          this.undoStack.push(d.before)
          this.redoStack = []
          this.markDirty()
        }
        break
      case 'link': {
        this.el.tempPath.style.display = 'none'
        this.el.tempPath.setAttribute('d', '')
        const target = document.elementFromPoint(ev.clientX, ev.clientY)
        const nodeEl = target && target.closest('.node')
        if (nodeEl) {
          this.connect(d.from, d.fromPort, nodeEl.dataset.id)
        } else if (target && target.closest('.canvas')) {
          const from = d.from
          const fromPort = d.fromPort
          this.showQuickAdd(ev.clientX, ev.clientY, node => this.connect(from, fromPort, node.id), true)
        }
        break
      }
      case 'box': {
        this.el.box.style.display = 'none'
        const a = this.toWorld(Math.min(ev.clientX, d.sx), Math.min(ev.clientY, d.sy))
        const b = this.toWorld(Math.max(ev.clientX, d.sx), Math.max(ev.clientY, d.sy))
        for (const n of this.graph.nodes) {
          const el = this.nodeEls.get(n.id)
          const w = el ? el.offsetWidth : 200
          const hh = el ? el.offsetHeight : 60
          if (n.x < b.x && n.x + w > a.x && n.y < b.y && n.y + hh > a.y) this.selected.add(n.id)
        }
        this.refreshSelection()
        break
      }
    }
  }

  onContextMenu (ev) {
    ev.preventDefault()
    const nodeEl = ev.target.closest('.node')
    const { h } = U
    if (nodeEl) {
      const id = nodeEl.dataset.id
      if (!this.selected.has(id)) {
        this.selected = new Set([id])
        this.refreshSelection()
      }
      this.openPopupAt(ev.clientX, ev.clientY, h('div', { class: 'ctx-menu' },
        h('button', { onclick: () => { this.closePopup(); this.duplicate() } }, 'Dupliquer'),
        h('button', { onclick: () => { this.closePopup(); this.copy() } }, 'Copier'),
        h('button', { onclick: () => { this.closePopup(); this.disconnectSelection() } }, 'Retirer les liens'),
        h('button', { class: 'danger', onclick: () => { this.closePopup(); this.deleteSelection() } }, 'Supprimer')))
      return
    }
    const hit = ev.target.closest('.link-hit')
    if (hit) {
      this.selectedLink = hit.dataset.id
      this.deleteSelection()
      return
    }
    this.showQuickAdd(ev.clientX, ev.clientY)
  }

  // --- Clavier ---------------------------------------------------------------------

  onKey (ev) {
    if (!this.isVisible()) return
    const tag = (document.activeElement && document.activeElement.tagName) || ''
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      this.save()
      return
    }
    if (typing) return
    if (ev.key === 'Escape') {
      this.closePopup()
      this.selected.clear()
      this.selectedLink = null
      this.refreshSelection()
      this.renderLinks()
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault()
      this.deleteSelection()
    } else if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault()
      this.undo()
    } else if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) {
      ev.preventDefault()
      this.redo()
    } else if (mod && ev.key.toLowerCase() === 'c') {
      this.copy()
    } else if (mod && ev.key.toLowerCase() === 'v') {
      this.paste()
    } else if (mod && ev.key.toLowerCase() === 'd') {
      ev.preventDefault()
      this.duplicate()
    } else if (mod && ev.key.toLowerCase() === 'a') {
      ev.preventDefault()
      this.selected = new Set(this.graph.nodes.map(n => n.id))
      this.refreshSelection()
    } else if (ev.key === 'f' || ev.key === 'F') {
      this.fit()
    }
  }

  // --- Édition ---------------------------------------------------------------------

  refreshSelection () {
    for (const [id, el] of this.nodeEls) el.classList.toggle('selected', this.selected.has(id))
    this.renderInspector()
  }

  addNode (type, x, y, params = {}) {
    const def = this.defs.get(type)
    if (!def) return null
    this.checkpoint()
    const node = { id: uid(), type, x: Math.round(x / GRID) * GRID, y: Math.round(y / GRID) * GRID, params: {} }
    for (const p of def.params) node.params[p.key] = params[p.key] !== undefined ? params[p.key] : p.default
    this.graph.nodes.push(node)
    this.selected = new Set([node.id])
    this.renderNode(node)
    this.refreshSelection()
    this.renderLinks()
    this.markDirty()
    this.el.hint.style.display = 'none'
    return node
  }

  /** Cherche un emplacement libre près de (x, y) pour ne pas empiler les nœuds. */
  freeSpot (x, y) {
    const overlaps = (px, py) => this.graph.nodes.some(n => {
      const el = this.nodeEls.get(n.id)
      const w = el ? el.offsetWidth : 200
      const hh = el ? el.offsetHeight : 70
      return px < n.x + w + 10 && px + 200 > n.x - 10 && py < n.y + hh + 10 && py + 70 > n.y - 10
    })
    for (let i = 0; i < 40; i++) {
      const px = x + Math.floor(i / 8) * 230
      const py = y + (i % 8) * 50
      if (!overlaps(px, py)) return { x: px, y: py }
    }
    return { x, y }
  }

  connect (from, fromPort, to) {
    if (from === to) return
    const toDef = this.defs.get((this.graph.nodes.find(n => n.id === to) || {}).type)
    if (!toDef || !toDef.input) return U.toast('Ce nœud n\'a pas d\'entrée (les évènements démarrent les flux)', 'warn')
    if (this.graph.links.some(l => l.from === from && l.fromPort === fromPort && l.to === to)) return
    this.checkpoint()
    this.graph.links.push({ id: uid('l'), from, fromPort, to, toPort: 'in' })
    this.markDirty()
    this.renderLinks()
  }

  deleteSelection () {
    if (this.selectedLink) {
      this.checkpoint()
      this.graph.links = this.graph.links.filter(l => l.id !== this.selectedLink)
      this.selectedLink = null
      this.markDirty()
      this.renderLinks()
      return
    }
    if (!this.selected.size) return
    this.checkpoint()
    this.graph.nodes = this.graph.nodes.filter(n => !this.selected.has(n.id))
    this.graph.links = this.graph.links.filter(l => !this.selected.has(l.from) && !this.selected.has(l.to))
    for (const id of this.selected) {
      const el = this.nodeEls.get(id)
      if (el) el.remove()
      this.nodeEls.delete(id)
    }
    this.selected.clear()
    this.markDirty()
    this.renderLinks()
    this.renderInspector()
  }

  disconnectSelection () {
    this.checkpoint()
    this.graph.links = this.graph.links.filter(l => !this.selected.has(l.from) && !this.selected.has(l.to))
    this.markDirty()
    this.renderLinks()
  }

  copy () {
    if (!this.selected.size) return
    const nodes = this.graph.nodes.filter(n => this.selected.has(n.id))
    const links = this.graph.links.filter(l => this.selected.has(l.from) && this.selected.has(l.to))
    this.clipboard = JSON.parse(JSON.stringify({ nodes, links }))
    try {
      localStorage.setItem('arthur-clipboard', JSON.stringify(this.clipboard))
    } catch (err) { /* ignore */ }
    U.toast(`${nodes.length} nœud(s) copié(s)`)
  }

  paste (offset = 40) {
    let clip = this.clipboard
    try {
      clip = clip || JSON.parse(localStorage.getItem('arthur-clipboard'))
    } catch (err) { /* ignore */ }
    if (!clip || !clip.nodes.length) return
    this.checkpoint()
    const map = new Map()
    const added = []
    for (const n of clip.nodes) {
      const copy = { ...JSON.parse(JSON.stringify(n)), id: uid(), x: n.x + offset, y: n.y + offset }
      map.set(n.id, copy.id)
      this.graph.nodes.push(copy)
      added.push(copy)
    }
    for (const l of clip.links) this.graph.links.push({ ...l, id: uid('l'), from: map.get(l.from), to: map.get(l.to) })
    this.selected = new Set(added.map(n => n.id))
    clip.nodes = clip.nodes.map(n => ({ ...n, x: n.x + offset, y: n.y + offset }))
    for (const n of added) this.renderNode(n)
    this.refreshSelection()
    this.renderLinks()
    this.markDirty()
  }

  duplicate () {
    const saved = this.clipboard
    this.copy()
    this.paste()
    this.clipboard = saved
  }

  // --- Popups -----------------------------------------------------------------------

  openPopupAt (x, y, content) {
    this.closePopup()
    const el = U.h('div', { class: 'popup' }, content)
    document.body.appendChild(el)
    const w = el.offsetWidth
    const hgt = el.offsetHeight
    el.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`
    el.style.top = `${Math.min(y, window.innerHeight - hgt - 8)}px`
    this.popup = el
    setTimeout(() => {
      this._outside = ev => { if (this.popup && !this.popup.contains(ev.target)) this.closePopup() }
      document.addEventListener('mousedown', this._outside)
    })
    return el
  }

  openPopup (anchor, content) {
    const r = anchor.getBoundingClientRect()
    return this.openPopupAt(r.left, r.bottom + 4, content)
  }

  closePopup () {
    if (this.popup) this.popup.remove()
    this.popup = null
    if (this._outside) document.removeEventListener('mousedown', this._outside)
    this._outside = null
  }

  /** Recherche rapide d'un nœud à insérer à l'endroit cliqué. */
  showQuickAdd (clientX, clientY, onAdded, onlyWithInput = false) {
    const { h } = U
    const pos = this.toWorld(clientX, clientY)
    const input = h('input', { type: 'search', placeholder: 'Ajouter un nœud…' })
    const list = h('div', { class: 'quick-list' })
    let items = []
    let index = 0
    const pick = def => {
      this.closePopup()
      const node = this.addNode(def.type, pos.x, pos.y - 14)
      if (node && onAdded) onAdded(node)
    }
    const refresh = () => {
      const q = input.value.trim().toLowerCase()
      items = this.info.nodes.filter(d => !d.passive || !onlyWithInput)
        .filter(d => !onlyWithInput || d.input)
        .filter(d => !q || d.label.toLowerCase().includes(q) || d.type.includes(q) || d.category.toLowerCase().includes(q))
        .slice(0, 14)
      index = Math.min(index, Math.max(0, items.length - 1))
      U.clear(list)
      items.forEach((d, i) => list.appendChild(h('div', {
        class: `quick-item${i === index ? ' active' : ''}`,
        onmousedown: ev => { ev.preventDefault(); pick(d) }
      }, h('span', { class: 'swatch', style: { background: d.color } }), d.label, h('span', { class: 'muted small' }, ` ${d.category}`))))
    }
    input.addEventListener('input', () => { index = 0; refresh() })
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { index = Math.min(items.length - 1, index + 1); refresh(); ev.preventDefault() }
      if (ev.key === 'ArrowUp') { index = Math.max(0, index - 1); refresh(); ev.preventDefault() }
      if (ev.key === 'Enter' && items[index]) pick(items[index])
      if (ev.key === 'Escape') this.closePopup()
    })
    refresh()
    this.openPopupAt(clientX, clientY, h('div', { class: 'quick-add' }, input, list))
    input.focus()
  }
}

window.GraphEditor = GraphEditor
