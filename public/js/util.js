/* Utilitaires partagés par le tableau de bord et l'éditeur. */
'use strict'

const U = (() => {
  let token = ''
  try {
    const fromUrl = new URLSearchParams(location.search).get('token')
    if (fromUrl) sessionStorage.setItem('arthur-token', fromUrl)
    token = fromUrl || sessionStorage.getItem('arthur-token') || ''
  } catch (err) {
    token = new URLSearchParams(location.search).get('token') || ''
  }

  /** Création d'éléments : h('div', { class: 'x', onclick: fn }, 'texte', enfant) */
  function h (tag, attrs, ...children) {
    const el = document.createElement(tag)
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') el.className = v
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
        else if (k === 'dataset') Object.assign(el.dataset, v)
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
        else if (k === 'value') el.value = v
        else if (k === 'checked') el.checked = !!v
        else if (k === 'html') el.innerHTML = v
        else el.setAttribute(k, v === true ? '' : v)
      }
    }
    append(el, children)
    return el
  }

  function append (el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue
      if (Array.isArray(c)) append(el, c)
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
    }
  }

  /** Ajoute des enfants en ignorant null/undefined/false (contrairement à Element.append). */
  function add (el, ...children) {
    append(el, children)
    return el
  }

  function clear (el) {
    while (el.firstChild) el.removeChild(el.firstChild)
    return el
  }

  async function api (method, url, body) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null
    try {
      data = await res.json()
    } catch (err) {
      data = null
    }
    if (!res.ok) throw new Error((data && data.error) || `Erreur HTTP ${res.status}`)
    return data
  }

  const TOAST_TITLES = { info: 'Information', success: 'Terminé', warn: 'Attention', error: 'Erreur' }

  /** Notification façon « progrès accompli », en haut à droite. */
  function toast (message, type = 'info', ms = 3500, title = null) {
    const box = document.getElementById('toasts')
    const el = h('div', { class: `toast ${type}` }, h('span', { class: 'toast-title' }, title || TOAST_TITLES[type] || ''), message)
    box.appendChild(el)
    while (box.children.length > 5) box.firstChild.remove()
    setTimeout(() => el.classList.add('hide'), ms)
    setTimeout(() => el.remove(), ms + 400)
  }

  function fmtTime (t) {
    return new Date(t).toLocaleTimeString('fr-FR')
  }

  function fmtDuration (ms) {
    if (ms === null || ms === undefined) return '-'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s} s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} min ${s % 60} s`
    return `${Math.floor(m / 60)} h ${m % 60} min`
  }

  function store (key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(`arthur-${key}`))
      localStorage.setItem(`arthur-${key}`, JSON.stringify(value))
    } catch (err) {
      return null
    }
  }

  function download (filename, text, type = 'application/json') {
    const blob = new Blob([text], { type })
    const a = h('a', { href: URL.createObjectURL(blob), download: filename })
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(a.href)
      a.remove()
    }, 100)
  }

  function optionList (options) {
    return (options || []).map(o => (typeof o === 'object' ? o : { value: o, label: o }))
  }

  /**
   * Champ de formulaire pour un paramètre de nœud ou une option de mode.
   * Les champs numériques acceptent aussi une expression (ex. bot.x + 5).
   */
  function paramInput (p, value, onChange, ctx = {}) {
    if (value === undefined) value = p.default
    const id = `f-${Math.random().toString(36).slice(2)}`
    let input
    switch (p.type) {
      case 'boolean':
        input = h('input', { type: 'checkbox', id, checked: value === true || value === 'true', onchange: e => onChange(e.target.checked, true) })
        return h('label', { class: 'field check' }, input, h('span', null, p.label), p.help ? h('small', null, p.help) : null)
      case 'select':
      case 'mode': {
        const opts = p.type === 'mode' ? (ctx.modes || []).map(m => ({ value: m.name, label: m.label })) : optionList(p.options)
        input = h('select', { id, onchange: e => onChange(e.target.value, true) },
          opts.map(o => h('option', { value: o.value, selected: o.value === value ? 'selected' : null }, o.label)))
        break
      }
      case 'text':
      case 'json':
        input = h('textarea', {
          id,
          rows: p.type === 'json' ? 3 : 4,
          class: p.type === 'json' ? 'mono' : null,
          oninput: e => onChange(e.target.value, false),
          onchange: e => onChange(e.target.value, true)
        })
        input.value = typeof value === 'object' && value !== null ? JSON.stringify(value) : (value ?? '')
        break
      case 'number': {
        const parse = v => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v)
        input = h('input', {
          id,
          type: 'text',
          inputmode: 'decimal',
          class: typeof value === 'string' ? 'mono' : null,
          placeholder: 'nombre ou expression',
          value: value ?? '',
          oninput: e => onChange(parse(e.target.value), false),
          onchange: e => onChange(parse(e.target.value), true)
        })
        break
      }
      default:
        input = h('input', {
          id,
          type: 'text',
          class: p.type === 'expression' || p.type === 'variable' ? 'mono' : null,
          placeholder: p.type === 'expression' ? 'expression, ex. bot.health < 10' : '',
          value: value ?? '',
          oninput: e => onChange(e.target.value, false),
          onchange: e => onChange(e.target.value, true)
        })
    }
    return h('div', { class: 'field' },
      h('label', { for: id }, p.label, p.type === 'expression' ? h('span', { class: 'tag' }, 'expr') : null),
      input,
      p.help ? h('small', null, p.help) : null)
  }

  // --- Menus surgissants (style infobulle d'objet) ---------------------------
  let currentPopup = null

  function closePopup () {
    if (!currentPopup) return
    currentPopup.el.remove()
    document.removeEventListener('mousedown', currentPopup.outside, true)
    document.removeEventListener('keydown', currentPopup.key, true)
    currentPopup = null
  }

  function popup (anchor, content, { align = 'left' } = {}) {
    closePopup()
    const el = h('div', { class: 'popup' }, content)
    document.body.appendChild(el)
    const r = anchor.getBoundingClientRect()
    let x = align === 'right' ? r.right - el.offsetWidth : r.left
    let y = r.bottom + 4
    x = Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4))
    if (y + el.offsetHeight > window.innerHeight - 4) y = Math.max(4, r.top - el.offsetHeight - 4)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    const outside = ev => { if (!el.contains(ev.target) && !anchor.contains(ev.target)) closePopup() }
    const key = ev => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      closePopup()
    }
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true)
      document.addEventListener('keydown', key, true)
    })
    currentPopup = { el, outside, key }
    const first = el.querySelector('input, button')
    if (first) first.focus()
    return el
  }

  /** Menu : liste de { label, onClick, hint?, danger?, disabled? }, '-' (séparateur) ou { title }. */
  function menu (anchor, items, opts) {
    return popup(anchor, h('div', { class: 'ctx-menu' }, items.map(it => {
      if (it === '-') return h('div', { class: 'menu-sep' })
      if (it.title) return h('div', { class: 'menu-title' }, it.title)
      return h('button', {
        class: it.danger ? 'danger' : null,
        disabled: it.disabled ? 'disabled' : null,
        onclick: () => {
          closePopup()
          it.onClick()
        }
      }, h('span', null, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null)
    })), opts)
  }

  // --- Visages des bots : tête pixel 8×8 déterminée par le nom ------------------
  const faceCache = new Map()
  const FACE_BASES = ['#8b8b8b', '#6d8f3a', '#3c44aa', '#a12722', '#835432', '#169c9c', '#8932b8', '#c47a2c', '#474f52', '#5e7c16', '#b02e26', '#3ab3da']
  const FACE_EYES = ['#55ffff', '#ffff55', '#ff5555', '#55ff55', '#ffffff', '#ff55ff', '#ffaa00']

  function hash (text) {
    let x = 2166136261
    for (const c of String(text)) {
      x ^= c.codePointAt(0)
      x = Math.imul(x, 16777619)
    }
    return x >>> 0
  }

  function shade (hex, f) {
    const n = parseInt(hex.slice(1), 16)
    const c = v => Math.max(0, Math.min(255, Math.round(v * f)))
    return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`
  }

  function face (name) {
    if (faceCache.has(name)) return faceCache.get(name)
    let seed = hash(name) || 1
    const rnd = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 4294967296
    }
    const base = FACE_BASES[hash(`${name}#b`) % FACE_BASES.length]
    const eye = FACE_EYES[hash(`${name}#e`) % FACE_EYES.length]
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const g = canvas.getContext('2d')
    const px = (x, y, color) => {
      g.fillStyle = color
      g.fillRect(x, y, 1, 1)
      g.fillRect(7 - x, y, 1, 1)
    }
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const v = rnd()
        px(x, y, v < 0.2 ? shade(base, 0.72) : v < 0.32 ? shade(base, 1.2) : base)
      }
    }
    for (let x = 0; x < 4; x++) px(x, 0, shade(base, 0.6))
    px(1, 3, eye)
    px(2, 3, eye)
    px(2, 4, shade(base, 0.45))
    const mouth = hash(`${name}#m`) % 3
    for (let x = mouth === 0 ? 2 : 3; x < 4; x++) px(x, 6, shade(base, 0.4))
    if (mouth === 2) px(2, 5, shade(base, 0.4))
    const url = canvas.toDataURL()
    faceCache.set(name, url)
    return url
  }

  let grassCache = null

  /** Icône de serveur par défaut : un bloc d'herbe en pixel art (comme pack.png absent). */
  function grassIcon () {
    if (grassCache) return grassCache
    let seed = 1234567
    const rnd = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 4294967296
    }
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const g = canvas.getContext('2d')
    const greens = ['#5d9c32', '#6db33c', '#4f8a2a', '#79c043']
    const dirts = ['#8b5a2b', '#79502a', '#9a6a3a', '#6b4423']
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const drip = y === 3 || y === 4 ? rnd() < (y === 3 ? 0.55 : 0.25) : false
        const palette = y < 3 || drip ? greens : dirts
        g.fillStyle = palette[Math.floor(rnd() * palette.length)]
        g.fillRect(x, y, 1, 1)
      }
    }
    grassCache = canvas.toDataURL()
    return grassCache
  }

  function faceImg (name, size = 16) {
    return h('img', { class: 'face', src: face(name), width: size, height: size, alt: '' })
  }

  return { h, add, clear, api, popup, menu, closePopup, face, faceImg, grassIcon, toast, fmtTime, fmtDuration, store, download, paramInput, optionList, get token () { return token } }
})()
