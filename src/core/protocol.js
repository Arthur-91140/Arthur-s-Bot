'use strict'

const nbt = require('prismarine-nbt')
const { chatToText } = require('./utils')

/** Libellés des liens serveur connus (1.21). */
const LINK_LABELS = {
  bug_report: 'Signaler un bug',
  community_guidelines: 'Règles de la communauté',
  support: 'Assistance',
  status: 'État des services',
  feedback: 'Avis',
  community: 'Communauté',
  website: 'Site web',
  forums: 'Forums',
  news: 'Actualités',
  announcements: 'Annonces'
}

/** Objet NBT (ou déjà simplifié) → valeur JavaScript. */
function simplifyNbt (value) {
  if (value && typeof value === 'object' && typeof value.type === 'string' && 'value' in value) {
    try {
      return nbt.simplify(value)
    } catch (err) {
      return value.value
    }
  }
  return value
}

/** Valeur JavaScript → NBT (texte, entier, décimal, booléen, liste, objet). */
function toNbt (value) {
  if (value === null || value === undefined) return nbt.string('')
  if (typeof value === 'boolean') return nbt.byte(value ? 1 : 0)
  if (typeof value === 'number') return Number.isInteger(value) ? nbt.int(value) : nbt.double(value)
  if (Array.isArray(value)) {
    if (!value.length) return nbt.list(nbt.string([]))
    const items = value.map(toNbt)
    return { type: 'list', value: { type: items[0].type, value: items.map(i => i.value) } }
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = toNbt(v)
    return nbt.comp(out)
  }
  return nbt.string(String(value))
}

function text (component) {
  return chatToText(simplifyNbt(component))
}

function stripNs (type) {
  return String(type || '').replace(/^minecraft:/, '')
}

function button (b) {
  if (!b) return null
  const action = b.action || null
  return {
    label: text(b.label) || 'OK',
    tooltip: b.tooltip ? text(b.tooltip) : null,
    action: action
      ? {
          type: stripNs(action.type),
          command: action.command || null,
          url: action.url || null,
          id: action.id || null,
          payload: action.payload !== undefined ? action.payload : null,
          template: action.template || null,
          additions: action.additions || null
        }
      : null
  }
}

/**
 * Boîte de dialogue (1.21.6) → forme lisible : titre, textes, champs de saisie et
 * boutons. `raw` est le contenu du paquet show_dialog (NBT ou référence de registre).
 */
function parseDialog (raw) {
  let data = raw
  if (data && data.data !== undefined) data = data.data
  if (data && typeof data === 'object' && data.id !== undefined && data.data === undefined && !data.type) {
    return { type: 'registry', title: `Dialogue du registre n° ${data.id}`, body: [], inputs: [], buttons: [], raw: data }
  }
  const d = simplifyNbt(data) || {}
  const type = stripNs(d.type)
  const body = (Array.isArray(d.body) ? d.body : d.body ? [d.body] : [])
    .map(b => (b && stripNs(b.type) === 'plain_message' ? text(b.contents) : b && b.item ? `[objet ${b.item.id || ''}]` : text(b)))
    .filter(Boolean)
  const inputs = (Array.isArray(d.inputs) ? d.inputs : []).map(i => ({
    key: i.key,
    type: stripNs(i.type),
    label: text(i.label) || i.key,
    initial: i.initial !== undefined ? i.initial : null,
    options: Array.isArray(i.options) ? i.options.map(o => ({ id: o.id, label: text(o.display) || o.id })) : null
  }))
  let buttons = []
  if (type === 'notice') buttons = [button(d.action) || { label: 'OK', action: null }]
  else if (type === 'confirmation') buttons = [button(d.yes), button(d.no)]
  else if (Array.isArray(d.actions)) buttons = d.actions.map(button)
  if (d.exit_action) buttons.push({ ...button(d.exit_action), exit: true })
  return {
    type,
    title: text(d.title) || '(sans titre)',
    externalTitle: d.external_title ? text(d.external_title) : null,
    body,
    inputs,
    buttons: buttons.filter(Boolean),
    canCloseWithEscape: d.can_close_with_escape !== false,
    afterAction: d.after_action || 'close'
  }
}

/** Remplace les $(clé) d'un modèle de commande par les valeurs saisies. */
function fillTemplate (template, values) {
  return String(template).replace(/\$\(([a-zA-Z0-9_]+)\)/g, (m, key) => (values[key] !== undefined ? String(values[key]) : ''))
}

// --- Messages de plugins (custom_payload) -------------------------------------------

/** Chaînes au format DataOutput.writeUTF de Java (canal BungeeCord). */
function encodeUtfList (strings) {
  const parts = strings.map(s => {
    const b = Buffer.from(String(s), 'utf8')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(b.length)
    return Buffer.concat([len, b])
  })
  return Buffer.concat(parts)
}

function decodeUtfList (buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    const len = buf.readUInt16BE(i)
    if (i + 2 + len > buf.length) return null
    out.push(buf.toString('utf8', i + 2, i + 2 + len))
    i += 2 + len
  }
  return i === buf.length ? out : null
}

function encodePayload (data, format = 'text') {
  if (Buffer.isBuffer(data)) return data
  switch (format) {
    case 'hex':
      return Buffer.from(String(data).replace(/[^0-9a-f]/gi, ''), 'hex')
    case 'utf-list': {
      const list = Array.isArray(data) ? data : String(data).split('\n')
      return encodeUtfList(list)
    }
    case 'json':
      return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8')
    default:
      return Buffer.from(String(data), 'utf8')
  }
}

function describePayload (buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const asText = data.toString('utf8')
  // eslint-disable-next-line no-control-regex
  const printable = !/[\u0000-\u0008\u000e-\u001f]/.test(asText) && !asText.includes('�')
  return {
    size: data.length,
    text: printable ? asText : null,
    strings: decodeUtfList(data),
    hex: data.subarray(0, 256).toString('hex')
  }
}

module.exports = {
  LINK_LABELS,
  simplifyNbt,
  toNbt,
  parseDialog,
  fillTemplate,
  encodePayload,
  describePayload,
  encodeUtfList,
  decodeUtfList
}
