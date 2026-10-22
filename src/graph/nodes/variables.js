'use strict'

const SCOPE = {
  key: 'scope',
  label: 'Portée',
  type: 'select',
  default: 'graph',
  options: [
    { value: 'graph', label: 'Graphe (ce bot)' },
    { value: 'flow', label: 'Flux (cet évènement)' },
    { value: 'shared', label: 'Partagée (tous les bots)' }
  ]
}

module.exports = [
  {
    type: 'var.set',
    category: 'Variables',
    label: 'Définir une variable',
    description: 'Stocke le résultat d\'une expression. Les variables partagées se lisent avec shared.nom.',
    params: [
      { key: 'name', label: 'Nom', type: 'variable', default: 'compteur' },
      { key: 'value', label: 'Valeur (expression)', type: 'expression', default: '0' },
      SCOPE
    ],
    run (api) {
      api.setVar(api.param('name'), api.param('value'), api.param('scope'))
    }
  },
  {
    type: 'var.increment',
    category: 'Variables',
    label: 'Incrémenter',
    description: 'Ajoute une valeur (1 par défaut) à une variable numérique.',
    params: [
      { key: 'name', label: 'Nom', type: 'variable', default: 'compteur' },
      { key: 'amount', label: 'Quantité', type: 'number', default: 1 },
      SCOPE
    ],
    run (api) {
      const name = api.param('name')
      const scope = api.param('scope')
      const current = Number(api.getVar(name, scope)) || 0
      api.setVar(name, current + api.param('amount'), scope)
    }
  },
  {
    type: 'var.push',
    category: 'Variables',
    label: 'Ajouter à une liste',
    description: 'Ajoute une valeur à la fin d\'une variable liste (créée si besoin).',
    params: [
      { key: 'name', label: 'Nom', type: 'variable', default: 'liste' },
      { key: 'value', label: 'Valeur (expression)', type: 'expression', default: 'event.message' },
      { key: 'max', label: 'Taille max (0 = illimitée)', type: 'number', default: 100 },
      SCOPE
    ],
    run (api) {
      const name = api.param('name')
      const scope = api.param('scope')
      const current = api.getVar(name, scope)
      const list = Array.isArray(current) ? current : []
      list.push(api.param('value'))
      const max = api.param('max')
      if (max > 0 && list.length > max) list.splice(0, list.length - max)
      api.setVar(name, list, scope)
    }
  }
]
