'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createTestManager, createOfflineBot, waitFor, graph } = require('./helpers')

test('un graphe de test complet produit un rapport réussi', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['start', 'event.start', { waitSpawn: false }],
    ['set', 'var.set', { name: 'total', value: '0', scope: 'graph' }],
    ['loop', 'flow.repeat', { count: 5, variable: 'i' }],
    ['inc', 'var.increment', { name: 'total', amount: 'i + 1', scope: 'graph' }],
    ['check', 'test.assert', { condition: 'total == 15', message: 'somme 1..5 = {{ total }}' }],
    ['end', 'test.finish', { status: 'auto' }]
  ], [
    ['start', 'out', 'set'], ['set', 'out', 'loop'], ['loop', 'body', 'inc'], ['loop', 'done', 'check'],
    ['check', 'pass', 'end'], ['check', 'fail', 'end']
  ])
  const [rt] = manager.runGraph(g, [bot.id])
  await waitFor(() => !rt.active)
  assert.strictEqual(rt.vars.total, 15)
  assert.strictEqual(rt.report.status, 'passed')
  assert.strictEqual(rt.report.assertions[0].message, 'somme 1..5 = 15')
})

test('les évènements de chat déclenchent les flux avec les groupes capturés', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['chat', 'event.chat', { pattern: '^(\\w+) a rejoint', source: 'all' }],
    ['say', 'action.chat', { message: 'Bienvenue {{ event.match[1] }} !' }]
  ], [['chat', 'out', 'say']])
  const [rt] = manager.runGraph(g, [bot.id])
  bot.events.emit('message', { message: 'Steve a rejoint la partie', position: 'system' })
  bot.events.emit('message', { message: 'message sans rapport', position: 'system' })
  await waitFor(() => bot.said.length === 1)
  assert.deepStrictEqual(bot.said, ['Bienvenue Steve !'])
  rt.stop()
})

test('les cycles dans le graphe ne font pas grossir la pile', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['start', 'event.start', { waitSpawn: false }],
    ['inc', 'var.increment', { name: 'n', amount: 1, scope: 'graph' }],
    ['if', 'flow.if', { condition: 'n < 5000' }],
    ['tick', 'flow.wait', { ms: 0 }],
    ['end', 'flow.stop', {}]
  ], [['start', 'out', 'inc'], ['inc', 'out', 'if'], ['if', 'true', 'tick'], ['tick', 'out', 'inc'], ['if', 'false', 'end']])
  const [rt] = manager.runGraph(g, [bot.id])
  await waitFor(() => !rt.active, 15000)
  assert.strictEqual(rt.vars.n, 5000)
  assert.strictEqual(rt.stats.errors, 0)
})

test('une boucle infinie sans attente est interrompue avec une erreur claire', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['start', 'event.start', { waitSpawn: false }],
    ['inc', 'var.increment', { name: 'n', amount: 1, scope: 'graph' }]
  ], [['start', 'out', 'inc'], ['inc', 'out', 'inc']])
  const [rt] = manager.runGraph(g, [bot.id])
  await waitFor(() => rt.report.errors.length > 0, 10000)
  assert.match(rt.report.errors[0].message, /boucle infinie/)
  rt.stop()
})

test('signaux, variables partagées, délai de récupération et "une seule fois"', async () => {
  const { manager } = createTestManager()
  const a = createOfflineBot(manager, 'BotA')
  const b = createOfflineBot(manager, 'BotB')
  const g = graph([
    ['sig', 'event.custom', { name: 'go' }],
    ['shared', 'var.increment', { name: 'hits', amount: 1, scope: 'shared' }],
    ['once', 'flow.once', {}],
    ['first', 'var.set', { name: 'first', value: 'event.data', scope: 'graph' }],
    ['cd', 'flow.cooldown', { ms: 60000 }],
    ['pass', 'var.increment', { name: 'passes', amount: 1, scope: 'graph' }]
  ], [['sig', 'out', 'shared'], ['shared', 'out', 'once'], ['once', 'first', 'first'], ['once', 'next', 'cd'], ['first', 'out', 'cd'], ['cd', 'pass', 'pass']])
  const runs = manager.runGraph(g, 'all')
  assert.strictEqual(runs.length, 2)
  manager.trigger('go', 'premier', 'all')
  await waitFor(() => manager.shared.hits === 2)
  manager.trigger('go', 'second', [a.id])
  await waitFor(() => manager.shared.hits === 3)
  await new Promise(resolve => setTimeout(resolve, 50))
  const [ra, rb] = runs
  assert.strictEqual(ra.vars.first, 'premier')
  assert.strictEqual(rb.vars.first, 'premier')
  assert.strictEqual(ra.vars.passes, 1, 'le délai de récupération bloque le 2e passage')
  for (const r of runs) r.stop()
  assert.ok(b)
})

test('une erreur de nœud est journalisée sans arrêter le graphe', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['start', 'event.start', { waitSpawn: false }],
    ['bad', 'var.set', { name: 'x', value: 'fonctionInconnue()', scope: 'graph' }],
    ['sig', 'event.custom', { name: 'ok' }],
    ['good', 'var.set', { name: 'y', value: '1', scope: 'graph' }]
  ], [['start', 'out', 'bad'], ['sig', 'out', 'good']])
  const [rt] = manager.runGraph(g, [bot.id])
  await waitFor(() => rt.stats.errors > 0)
  assert.match(rt.report.errors[0].message, /Fonction inconnue/)
  manager.trigger('ok', null, [bot.id])
  await waitFor(() => rt.vars.y === 1)
  assert.ok(rt.active)
  rt.stop()
  assert.ok(['failed', 'stopped'].includes(rt.report.status))
})

test('un graphe invalide est refusé', () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  assert.throws(() => manager.runGraph(graph([['x', 'type.inexistant', {}]], []), [bot.id]), /Type de nœud inconnu/)
  assert.throws(() => manager.runGraph(graph([['s', 'event.start', {}], ['c', 'flow.if', { condition: '1 +' }]], []), [bot.id]), /Condition/)
})

test('test.expectMessage capture la réponse et la latence', async () => {
  const { manager } = createTestManager()
  const bot = createOfflineBot(manager)
  const g = graph([
    ['start', 'event.start', { waitSpawn: false }],
    ['exp', 'test.expectMessage', { pattern: 'Solde : (\\d+)', timeout: 2000, record: true }],
    ['save', 'var.set', { name: 'solde', value: 'num(match[1])', scope: 'graph' }],
    ['end', 'test.finish', {}]
  ], [['start', 'out', 'exp'], ['exp', 'matched', 'save'], ['save', 'out', 'end'], ['exp', 'timeout', 'end']])
  const [rt] = manager.runGraph(g, [bot.id])
  setTimeout(() => bot.events.emit('message', { message: 'Solde : 250 pièces' }), 50)
  await waitFor(() => !rt.active)
  assert.strictEqual(rt.vars.solde, 250)
  assert.strictEqual(rt.report.status, 'passed')
})
