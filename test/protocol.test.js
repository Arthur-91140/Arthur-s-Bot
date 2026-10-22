'use strict'

const test = require('node:test')
const assert = require('node:assert')
const nbt = require('prismarine-nbt')
const proto = require('../src/core/protocol')

test('boîte de dialogue : confirmation avec champ et commande dynamique', () => {
  const d = proto.parseDialog({
    type: 'minecraft:confirmation',
    title: 'Règles',
    body: { type: 'minecraft:plain_message', contents: { text: 'Accepter ?' } },
    inputs: [{ type: 'minecraft:text', key: 'pseudo', label: 'Pseudo' }],
    yes: { label: 'Oui', action: { type: 'dynamic/run_command', template: 'me accepte $(pseudo)' } },
    no: { label: 'Non' }
  })
  assert.strictEqual(d.type, 'confirmation')
  assert.strictEqual(d.title, 'Règles')
  assert.deepStrictEqual(d.body, ['Accepter ?'])
  assert.deepStrictEqual(d.inputs.map(i => i.key), ['pseudo'])
  assert.deepStrictEqual(d.buttons.map(b => b.label), ['Oui', 'Non'])
  assert.strictEqual(d.buttons[0].action.type, 'dynamic/run_command')
  assert.strictEqual(proto.fillTemplate(d.buttons[0].action.template, { pseudo: 'Alex' }), 'me accepte Alex')
})

test('boîte de dialogue : données NBT telles que reçues du serveur', () => {
  const raw = nbt.comp({
    type: nbt.string('minecraft:multi_action'),
    title: nbt.string('Kits'),
    actions: { type: 'list', value: { type: 'compound', value: [
      { label: { type: 'string', value: 'Guerrier' }, action: { type: 'compound', value: { type: { type: 'string', value: 'run_command' }, command: { type: 'string', value: '/kit guerrier' } } } },
      { label: { type: 'string', value: 'Mineur' } }
    ] } }
  })
  const d = proto.parseDialog({ data: raw })
  assert.strictEqual(d.type, 'multi_action')
  assert.deepStrictEqual(d.buttons.map(b => b.label), ['Guerrier', 'Mineur'])
  assert.strictEqual(d.buttons[0].action.command, '/kit guerrier')
  assert.strictEqual(proto.parseDialog({ type: 'minecraft:notice', title: 'Info' }).buttons[0].label, 'OK')
})

test('messages de plugins : formats texte, BungeeCord et hexadécimal', () => {
  const bungee = proto.encodePayload('Connect\nlobby', 'utf-list')
  assert.deepStrictEqual(proto.decodeUtfList(bungee), ['Connect', 'lobby'])
  assert.deepStrictEqual(proto.describePayload(bungee).strings, ['Connect', 'lobby'])
  assert.strictEqual(proto.encodePayload('0a ff', 'hex').toString('hex'), '0aff')
  assert.strictEqual(proto.describePayload(Buffer.from('bonjour')).text, 'bonjour')
  assert.strictEqual(proto.describePayload(Buffer.from([0, 1, 2])).text, null)
})

test('NBT : aller-retour depuis des valeurs JavaScript', () => {
  const value = { nom: 'Alex', niveau: 3, ratio: 0.5, actif: true, tags: ['a', 'b'], sous: { x: 1 } }
  const back = nbt.simplify(proto.toNbt(value))
  assert.deepStrictEqual(back, { nom: 'Alex', niveau: 3, ratio: 0.5, actif: 1, tags: ['a', 'b'], sous: { x: 1 } })
})
