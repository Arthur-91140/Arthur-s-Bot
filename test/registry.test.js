'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const registry = require('../src/graph/registry')
const modes = require('../src/modes')
const { supportedVersions } = require('../src/core/versions')
const { chatToText, resolveBlockIds, fillPlaceholders } = require('../src/core/utils')

const PARAM_TYPES = ['string', 'text', 'number', 'boolean', 'select', 'expression', 'variable', 'json', 'mode']

test('chaque type de nœud est bien défini', () => {
  const list = registry.list()
  assert.ok(list.length >= 70)
  for (const def of list) {
    assert.ok(def.label, `${def.type} : libellé manquant`)
    assert.ok(def.description, `${def.type} : description manquante`)
    const outs = def.outputs.map(o => o.name)
    assert.strictEqual(new Set(outs).size, outs.length, `${def.type} : sorties dupliquées`)
    if (def.event) assert.strictEqual(def.input, false, `${def.type} : un évènement n'a pas d'entrée`)
    for (const p of def.params) {
      assert.ok(PARAM_TYPES.includes(p.type), `${def.type}.${p.key} : type ${p.type} inconnu`)
      assert.ok(p.label, `${def.type}.${p.key} : libellé manquant`)
      if (p.type === 'select') assert.ok(p.options && p.options.length, `${def.type}.${p.key} : options manquantes`)
    }
  }
})

test('chaque mode est bien défini et ses options se normalisent', () => {
  const list = modes.list()
  assert.ok(list.length >= 15)
  for (const m of list) {
    assert.ok(m.label && m.description, `${m.name} : libellé/description manquants`)
    const opts = modes.normalizeOptions(modes.get(m.name), {})
    for (const o of m.options) {
      assert.ok(PARAM_TYPES.includes(o.type), `${m.name}.${o.key}`)
      assert.deepStrictEqual(opts[o.key], o.default ?? (o.type === 'string' || o.type === 'text' ? '' : undefined), `${m.name}.${o.key} : défaut`)
    }
  }
  const wander = modes.normalizeOptions(modes.get('wander'), { radius: '30', sprint: 'true', inconnue: 1 })
  assert.strictEqual(wander.radius, 30)
  assert.strictEqual(wander.sprint, true)
  assert.ok(!('inconnue' in wander))
})

test('les graphes d\'exemple sont valides', () => {
  const dir = path.join(__dirname, '..', 'graphs')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  assert.ok(files.length >= 5)
  for (const f of files) {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const { errors } = registry.validate(g)
    assert.deepStrictEqual(errors, [], f)
  }
})

test('versions supportées de 1.8 à la dernière', () => {
  const list = supportedVersions()
  assert.ok(list.includes('1.8.8'))
  assert.ok(list.includes('1.12.2'))
  assert.ok(list.includes('1.20.4'))
  assert.ok(list.length > 40)
})

test('utilitaires : texte de chat, blocs, motifs', () => {
  assert.strictEqual(chatToText('{"text":"§aSalut ","extra":[{"text":"monde"}]}'), 'Salut monde')
  assert.strictEqual(chatToText({ translate: 'multiplayer.disconnect.kicked' }), 'multiplayer.disconnect.kicked')
  assert.strictEqual(chatToText({ type: 'compound', value: { text: { type: 'string', value: 'NBT' } } }), 'NBT')
  const registryData = require('minecraft-data')('1.20.4')
  const ids = resolveBlockIds(registryData, 'oak_log, *_ore')
  assert.ok(ids.includes(registryData.blocksByName.oak_log.id))
  assert.ok(ids.includes(registryData.blocksByName.diamond_ore.id))
  assert.ok(!ids.includes(registryData.blocksByName.stone.id))
  assert.strictEqual(fillPlaceholders('Bot_{i}', { i: 3 }), 'Bot_3')
})
