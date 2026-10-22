'use strict'

/**
 * Registre des modes prédéfinis. Un mode est un objet :
 * { name, label, category, description, options: [...], start(ctx), stop?(ctx) }
 * Les options sont décrites comme les paramètres des nœuds (type, défaut, aide).
 */
const registry = new Map()

function register (def) {
  if (!def.name || typeof def.start !== 'function') throw new Error(`Mode invalide : ${def.name}`)
  registry.set(def.name, { options: [], category: 'Divers', ...def })
}

for (const file of ['./basic', './combat', './world', './testing', './load']) {
  for (const def of require(file)) register(def)
}

function get (name) {
  return registry.get(name) || null
}

function list () {
  return [...registry.values()].map(({ name, label, category, description, options }) => ({
    name, label, category, description, options
  }))
}

function coerce (opt, value) {
  if (value === undefined || value === null || value === '') {
    return opt.type === 'string' || opt.type === 'text' ? (value ?? opt.default ?? '') : opt.default
  }
  switch (opt.type) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : opt.default
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
    case 'select': {
      const values = (opt.options || []).map(o => (typeof o === 'object' ? o.value : o))
      return values.includes(value) ? value : opt.default
    }
    default:
      return String(value)
  }
}

/** Applique les valeurs par défaut et convertit les types des options d'un mode. */
function normalizeOptions (def, options = {}) {
  const out = {}
  for (const opt of def.options || []) out[opt.key] = coerce(opt, options[opt.key])
  return out
}

module.exports = { register, get, list, normalizeOptions }
