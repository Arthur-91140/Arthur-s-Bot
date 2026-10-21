'use strict'

/**
 * Registre des types de nœuds du programmateur visuel.
 *
 * Définition d'un nœud :
 * {
 *   type: 'flow.if', category, label, description, color?,
 *   input: true,                       // possède une entrée de flux (false pour les évènements)
 *   outputs: [{ name, label }],        // sorties de flux
 *   params: [{ key, label, type, default, options?, help? }],
 *   run: async api => 'nomDeSortie' | ['a', 'b'] | null,
 *   subscribe?: (api, fire) => désabonnement   // nœuds évènements
 * }
 * Types de paramètres : string, text, number, boolean, select, expression, variable, json, mode
 */

const CATEGORIES = [
  { name: 'Évènements', color: '#e5534b' },
  { name: 'Logique', color: '#a371f7' },
  { name: 'Variables', color: '#d29922' },
  { name: 'Déplacement', color: '#388bfd' },
  { name: 'Actions', color: '#3fb950' },
  { name: 'Inventaire & GUI', color: '#db6d28' },
  { name: 'Monde', color: '#2ea6a0' },
  { name: 'Tests', color: '#db61a2' },
  { name: 'Divers', color: '#768390' }
]

const registry = new Map()

function register (def) {
  if (!def.type) throw new Error('Type de nœud manquant')
  const category = CATEGORIES.find(c => c.name === def.category) || CATEGORIES[CATEGORIES.length - 1]
  const full = {
    input: true,
    outputs: [{ name: 'out', label: '' }],
    params: [],
    description: '',
    ...def,
    category: category.name,
    color: def.color || category.color
  }
  if (!full.subscribe && typeof full.run !== 'function' && !full.passive) {
    throw new Error(`Le nœud ${def.type} n'a pas de fonction run`)
  }
  registry.set(full.type, full)
}

for (const file of ['events', 'flow', 'variables', 'movement', 'actions', 'inventory', 'world', 'testing', 'misc']) {
  for (const def of require(`./nodes/${file}`)) register(def)
}

function get (type) {
  return registry.get(type) || null
}

/** Version sérialisable pour l'éditeur web. */
function list () {
  return [...registry.values()].map(d => ({
    type: d.type,
    category: d.category,
    label: d.label,
    description: d.description,
    color: d.color,
    input: d.input,
    event: !!d.subscribe,
    passive: !!d.passive,
    outputs: d.outputs,
    params: d.params
  }))
}

/** Vérifie un graphe : types inconnus, liens cassés, absence d'évènement de départ. */
function validate (graph) {
  const errors = []
  const warnings = []
  if (!graph || !Array.isArray(graph.nodes)) {
    errors.push('Graphe invalide : liste de nœuds manquante')
    return { errors, warnings }
  }
  const ids = new Set()
  for (const node of graph.nodes) {
    if (!node.id) errors.push('Nœud sans identifiant')
    if (ids.has(node.id)) errors.push(`Identifiant dupliqué : ${node.id}`)
    ids.add(node.id)
    const def = get(node.type)
    if (!def) {
      errors.push(`Type de nœud inconnu : ${node.type}`)
      continue
    }
    for (const p of def.params) {
      if (!['expression', 'number', 'boolean', 'string', 'text'].includes(p.type)) continue
      const v = node.params ? node.params[p.key] : undefined
      if (typeof v !== 'string' || v === '') continue
      if (p.type === 'string' || p.type === 'text') {
        if (!v.includes('{{')) continue
      }
      const { check } = require('./expression')
      const err = check(v)
      if (err) errors.push(`${def.label} (${node.id}) › ${p.label} : ${err}`)
    }
  }
  for (const link of graph.links || []) {
    if (!ids.has(link.from) || !ids.has(link.to)) warnings.push(`Lien ignoré (nœud manquant) : ${link.from} → ${link.to}`)
  }
  if (!graph.nodes.some(n => get(n.type) && get(n.type).subscribe)) {
    warnings.push('Aucun nœud évènement : le graphe ne démarrera jamais (ajoutez "Au démarrage").')
  }
  return { errors, warnings }
}

module.exports = { register, get, list, validate, CATEGORIES }
