'use strict'

module.exports = [
  {
    type: 'misc.comment',
    category: 'Divers',
    label: 'Commentaire',
    description: 'Note libre pour documenter le graphe (n\'est jamais exécutée).',
    input: false,
    outputs: [],
    passive: true,
    params: [{ key: 'text', label: 'Texte', type: 'text', default: 'Décrivez ici ce que fait cette partie du graphe.' }]
  }
]
