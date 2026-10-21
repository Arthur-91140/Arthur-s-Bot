'use strict'

function abortError (message = 'Interrompu') {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function isAbortError (err) {
  return err && err.name === 'AbortError'
}

/** Attente interruptible par un AbortSignal. */
function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, Number(ms) || 0))
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rejette la promesse si elle ne se termine pas avant `ms`. */
function withTimeout (promise, ms, message = 'Délai dépassé') {
  if (!ms || ms <= 0) return promise
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Attend un évènement sur un EventEmitter, avec filtre, délai et signal d'arrêt.
 * Résout avec le tableau des arguments de l'évènement, ou null si le délai expire.
 */
function waitForEvent (emitter, event, { filter, timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      emitter.removeListener(event, handler)
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const handler = (...args) => {
      let ok = true
      try {
        ok = filter ? filter(...args) : true
      } catch (err) {
        ok = false
      }
      if (!ok) return
      cleanup()
      resolve(args)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    if (signal && signal.aborted) return reject(abortError())
    emitter.on(event, handler)
    if (timeout > 0) {
      timer = setTimeout(() => {
        cleanup()
        resolve(null)
      }, timeout)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

const FORMAT_CODES = /§[0-9a-fk-orx]/gi

/** Convertit un composant de chat (JSON, objet, ChatMessage, NBT simplifié) en texte brut. */
function chatToText (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const s = value.trim()
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        return chatToText(JSON.parse(s))
      } catch (err) {
        // pas du JSON : on garde la chaîne telle quelle
      }
    }
    return value.replace(FORMAT_CODES, '')
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(chatToText).join('')
  if (typeof value === 'object') {
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString && value.json) {
      return value.toString().replace(FORMAT_CODES, '')
    }
    if (value.type === 'compound' && value.value) return chatToText(simplifyNbt(value))
    let text = ''
    if (value.text !== undefined) text += chatToText(value.text)
    if (value[''] !== undefined) text += chatToText(value[''])
    if (value.translate) {
      const args = (value.with || []).map(chatToText)
      text += args.length ? `${value.translate} ${args.join(' ')}` : value.translate
    }
    if (Array.isArray(value.extra)) text += value.extra.map(chatToText).join('')
    return text.replace(FORMAT_CODES, '')
  }
  return String(value)
}

function simplifyNbt (tag) {
  if (!tag || typeof tag !== 'object') return tag
  switch (tag.type) {
    case 'compound': {
      const out = {}
      for (const [k, v] of Object.entries(tag.value || {})) out[k] = simplifyNbt(v)
      return out
    }
    case 'list':
      return (tag.value && tag.value.value ? tag.value.value : []).map(v =>
        typeof v === 'object' && !v.type ? simplifyNbt({ type: 'compound', value: v }) : v)
    default:
      return tag.value
  }
}

function round (n, decimals = 2) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

function vecToObj (v, decimals = 2) {
  if (!v) return null
  return { x: round(v.x, decimals), y: round(v.y, decimals), z: round(v.z, decimals) }
}

function randomInt (min, max) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomBetween (min, max) {
  return min + Math.random() * (max - min)
}

/** Remplace {i}, {username}, {rand}, {time} dans un texte de mode. */
function fillPlaceholders (text, values = {}) {
  return String(text).replace(/\{(\w+)\}/g, (all, key) => {
    if (key === 'rand') return String(randomInt(0, 9999))
    if (key === 'time') return new Date().toLocaleTimeString('fr-FR')
    return values[key] !== undefined ? String(values[key]) : all
  })
}

/** Découpe une liste "a, b\nc" en tableau propre. */
function parseList (value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean)
  return String(value || '').split(/[\n,;]/).map(s => s.trim()).filter(Boolean)
}

/** Lignes non vides, sans les commentaires commençant par #. */
function parseLines (value) {
  if (Array.isArray(value)) return value.map(String)
  return String(value || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
}

const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombievillager', 'skeleton', 'stray', 'bogged', 'witherskeleton',
  'creeper', 'spider', 'cavespider', 'enderman', 'endermite', 'silverfish', 'witch', 'slime',
  'magmacube', 'lavaslime', 'blaze', 'ghast', 'phantom', 'guardian', 'elderguardian', 'shulker',
  'vex', 'vindicator', 'evoker', 'pillager', 'ravager', 'illusioner', 'hoglin', 'zoglin',
  'piglinbrute', 'warden', 'breeze', 'creaking', 'wither', 'enderdragon', 'giant', 'pigzombie'
])

function normalizeEntityName (entity) {
  return String(entity && (entity.name || entity.displayName) || '').toLowerCase().replace(/[_\s]/g, '')
}

function isHostile (entity) {
  if (!entity || entity.type === 'player') return false
  if (entity.type === 'hostile') return true
  return HOSTILE_NAMES.has(normalizeEntityName(entity))
}

/** Nom lisible d'une entité. */
function entityLabel (entity) {
  if (!entity) return ''
  return entity.username || entity.displayName || entity.name || `entité#${entity.id}`
}

/** Trouve un objet de l'inventaire par nom exact, sinon par nom partiel. */
function findItem (bot, name) {
  if (!bot || !bot.inventory || !name) return null
  const wanted = String(name).toLowerCase().replace(/^minecraft:/, '')
  const items = bot.inventory.items()
  return items.find(i => i.name === wanted) || items.find(i => i.name.includes(wanted)) || null
}

/** Quantité d'un objet : nom exact s'il est présent, sinon nom partiel (comme findItem). */
function countItem (bot, name) {
  if (!bot || !bot.inventory || !name) return 0
  const wanted = String(name).toLowerCase().replace(/^minecraft:/, '')
  const items = bot.inventory.items()
  const exact = items.filter(i => i.name === wanted)
  const matching = exact.length ? exact : items.filter(i => i.name.includes(wanted))
  return matching.reduce((sum, i) => sum + i.count, 0)
}

/**
 * Résout une liste de noms de blocs (exacts, partiels ou avec *) en ids du registre.
 * Ex. "oak_log, *_ore" -> ids de oak_log et de tous les minerais.
 */
function resolveBlockIds (registry, list) {
  const ids = new Set()
  for (const raw of parseList(list)) {
    const term = raw.toLowerCase().replace(/^minecraft:/, '')
    const exact = registry.blocksByName[term]
    if (exact && !term.includes('*')) {
      ids.add(exact.id)
      continue
    }
    const re = term.includes('*')
      ? new RegExp('^' + term.split('*').map(escapeRegExp).join('.*') + '$')
      : null
    for (const block of registry.blocksArray) {
      if (re ? re.test(block.name) : block.name.includes(term)) ids.add(block.id)
    }
  }
  return [...ids]
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile une expression régulière fournie par l'utilisateur, ou un texte simple. */
function toRegExp (pattern, flags = 'i') {
  if (pattern instanceof RegExp) return pattern
  const s = String(pattern || '')
  const m = s.match(/^\/(.*)\/([a-z]*)$/)
  try {
    if (m) return new RegExp(m[1], m[2])
    return new RegExp(s, flags)
  } catch (err) {
    return new RegExp(escapeRegExp(s), flags)
  }
}

function errorMessage (err) {
  if (!err) return 'erreur inconnue'
  if (typeof err === 'string') return err
  return err.message || String(err)
}

module.exports = {
  abortError,
  isAbortError,
  sleep,
  withTimeout,
  waitForEvent,
  chatToText,
  simplifyNbt,
  round,
  vecToObj,
  randomInt,
  randomBetween,
  fillPlaceholders,
  parseList,
  parseLines,
  isHostile,
  entityLabel,
  normalizeEntityName,
  findItem,
  countItem,
  resolveBlockIds,
  escapeRegExp,
  toRegExp,
  errorMessage
}
