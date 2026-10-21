'use strict'

const fs = require('fs')
const path = require('path')

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function slugify (text) {
  const slug = String(text || 'graphe')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'graphe'
}

/** Stockage des graphes de comportement : un fichier JSON par graphe dans graphs/. */
class GraphStore {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  file (id) {
    if (!ID_RE.test(id)) throw new Error(`Identifiant de graphe invalide : ${id}`)
    return path.join(this.dir, `${id}.json`)
  }

  list () {
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const id = f.slice(0, -5)
        try {
          const g = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))
          const stat = fs.statSync(path.join(this.dir, f))
          return {
            id,
            name: g.name || id,
            description: g.description || '',
            tags: g.tags || [],
            nodes: (g.nodes || []).length,
            updatedAt: stat.mtimeMs
          }
        } catch (err) {
          return { id, name: id, description: `Fichier illisible : ${err.message}`, nodes: 0, broken: true }
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  }

  exists (id) {
    return ID_RE.test(id) && fs.existsSync(this.file(id))
  }

  get (id) {
    const file = this.file(id)
    if (!fs.existsSync(file)) return null
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'))
    graph.id = id
    return graph
  }

  save (graph) {
    if (!graph || !Array.isArray(graph.nodes)) throw new Error('Graphe invalide')
    const id = graph.id && ID_RE.test(graph.id) ? graph.id : slugify(graph.name)
    const data = {
      id,
      name: graph.name || id,
      description: graph.description || '',
      tags: graph.tags || [],
      variables: graph.variables || {},
      nodes: graph.nodes,
      links: graph.links || [],
      view: graph.view || undefined,
      version: 1
    }
    fs.writeFileSync(this.file(id), JSON.stringify(data, null, 2))
    return data
  }

  remove (id) {
    const file = this.file(id)
    if (!fs.existsSync(file)) return false
    fs.unlinkSync(file)
    return true
  }

  /** Charge un graphe depuis un id enregistré ou un chemin de fichier. */
  load (ref) {
    if (typeof ref === 'object') return ref
    if (ID_RE.test(ref) && this.exists(ref)) return this.get(ref)
    const file = path.resolve(ref)
    if (fs.existsSync(file)) {
      const graph = JSON.parse(fs.readFileSync(file, 'utf8'))
      graph.id = graph.id || slugify(path.basename(file, '.json'))
      return graph
    }
    throw new Error(`Graphe introuvable : ${ref}`)
  }
}

module.exports = { GraphStore, slugify }
