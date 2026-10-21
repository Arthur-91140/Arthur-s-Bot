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

  return { h, add, clear, api, toast, fmtTime, fmtDuration, store, download, paramInput, optionList, get token () { return token } }
})()
