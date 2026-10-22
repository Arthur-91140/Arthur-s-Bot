'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { evaluate, interpolate, interpolateOrEval, createScope, check } = require('../src/graph/expression')

const scope = createScope({
  layers: [{ health: 8, name: 'Steve', list: [1, 2, 3], nested: { a: { b: 42 } } }],
  constants: { bot: () => ({ x: 1.5, players: ['a', 'b'] }) },
  functions: { double: n => n * 2 }
})

test('opérateurs et priorités', () => {
  assert.strictEqual(evaluate('1 + 2 * 3', scope), 7)
  assert.strictEqual(evaluate('(1 + 2) * 3', scope), 9)
  assert.strictEqual(evaluate('10 % 4', scope), 2)
  assert.strictEqual(evaluate('-health + 10', scope), 2)
  assert.strictEqual(evaluate('health < 10 && name == "Steve"', scope), true)
  assert.strictEqual(evaluate('not (health > 5) or false', scope), false)
  assert.strictEqual(evaluate('health > 5 ? "ok" : "bas"', scope), 'ok')
  assert.strictEqual(evaluate('missing ?? 42', scope), 42)
  assert.strictEqual(evaluate('1 === 1 && 1 !== "1"', scope), true)
})

test('accès aux champs, listes et fonctions', () => {
  assert.strictEqual(evaluate('nested.a.b', scope), 42)
  assert.strictEqual(evaluate('list[1] * 2', scope), 4)
  assert.strictEqual(evaluate('bot.players.length', scope), 2)
  assert.strictEqual(evaluate('len(list)', scope), 3)
  assert.strictEqual(evaluate('double(21)', scope), 42)
  assert.strictEqual(evaluate('name.toUpperCase()', scope), 'STEVE')
  assert.strictEqual(evaluate('[1, 2, 3].join("-")', scope), '1-2-3')
  assert.strictEqual(evaluate('missing.deep.value', scope), undefined)
  assert.deepStrictEqual(evaluate('match("Bienvenue Steve", "bienvenue (\\w+)")', scope), ['Bienvenue Steve', 'Steve'])
  assert.strictEqual(evaluate('matches("abc123", "\\d+")', scope), true)
  const r = evaluate('randInt(1, 3)', scope)
  assert.ok(r >= 1 && r <= 3)
})

test('interpolation de texte', () => {
  assert.strictEqual(interpolate('Pos {{ bot.x }} / {{ health * 2 }}', scope), 'Pos 1.5 / 16')
  assert.deepStrictEqual(interpolate('{{ list }}', scope), [1, 2, 3])
  assert.strictEqual(interpolate('sans expression', scope), 'sans expression')
  assert.strictEqual(interpolateOrEval('health + 1', scope), 9)
  assert.strictEqual(interpolateOrEval('{{ health }}0', scope), '80')
})

test('sécurité : pas d\'accès au prototype ni à JavaScript', () => {
  for (const src of ['x.__proto__', 'nested["constructor"]', 'constructor', 'name.constructor', 'toString()', 'process', 'require("fs")']) {
    let value
    try {
      value = evaluate(src, scope)
    } catch (err) {
      continue
    }
    assert.ok(value === undefined, `${src} ne doit rien renvoyer`)
  }
  assert.throws(() => evaluate('name.constructor("x")', scope))
  assert.throws(() => evaluate('list.map(1)', scope))
})

test('erreurs de syntaxe', () => {
  assert.ok(check('1 +'))
  assert.ok(check('(1 + 2'))
  assert.ok(check('a ? b'))
  assert.strictEqual(check('a ? b : c'), null)
  assert.strictEqual(check('Bonjour {{ name }}'), null)
  assert.ok(check('Bonjour {{ name + }}'))
})
