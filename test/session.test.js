'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { mixOrder } = require('../src/core/BotManager')
const { CampaignRun, CampaignStore, normalizeCampaign } = require('../src/core/campaigns')
const { createTestManager, waitFor } = require('./helpers')

test('population mixte : proportions respectées et groupes entrelacés', () => {
  const order = mixOrder(10, [{ weight: 60 }, { weight: 30 }, { weight: 10 }])
  const counts = [0, 1, 2].map(g => order.filter(x => x === g).length)
  assert.deepStrictEqual(counts, [6, 3, 1])
  // pas de longue série d'un même groupe au début : les comportements se mélangent
  assert.notDeepStrictEqual(order.slice(0, 3), [0, 0, 0])
  assert.deepStrictEqual(mixOrder(3, [{ weight: 1 }, { weight: 1 }]).length, 3)
  assert.deepStrictEqual(mixOrder(5, [{ weight: 0 }]), [])
})

test('essaim mixte : chaque bot reçoit le mode de son groupe', () => {
  const { manager, dir } = createTestManager()
  const res = manager.createSwarm({
    count: 8,
    namePattern: 'Mix_{i}',
    connect: false,
    mix: [{ weight: 3, mode: 'wander', modeOptions: { radius: 5 } }, { weight: 1, mode: 'antiafk' }]
  })
  assert.strictEqual(res.created.length, 8)
  const modes = res.created.map(id => manager.get(id).mode.name)
  assert.strictEqual(modes.filter(m => m === 'wander').length, 6)
  assert.strictEqual(modes.filter(m => m === 'antiafk').length, 2)
  assert.strictEqual(manager.get(res.created.find((id, i) => modes[i] === 'wander')).mode.options.radius, 5)
  assert.throws(() => manager.createSwarm({ count: 2, connect: false, mix: [{ weight: 1, mode: 'inexistant' }] }), /Mode inconnu/)
  manager.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('bots conservés : enregistrés puis restaurés au démarrage suivant', async () => {
  const { manager, dir } = createTestManager()
  manager.botsFile = path.join(dir, 'data', 'bots.json')
  manager.createBot({ username: 'Garde', mode: 'antiafk', connect: false })
  manager.createBot({ username: 'Temporaire', temporary: true, connect: false })
  manager.get('Garde').setPlugins({ autoEat: false })
  manager.saveBots()
  const saved = JSON.parse(fs.readFileSync(manager.botsFile, 'utf8')).bots
  assert.deepStrictEqual(saved.map(b => b.username), ['Garde'], 'les bots temporaires des campagnes ne sont pas gardés')
  assert.strictEqual(saved[0].mode, 'antiafk')
  assert.strictEqual(saved[0].plugins.autoEat, false)
  assert.strictEqual(saved[0].online, false)
  manager.shutdown()

  const next = createTestManager()
  next.manager.botsFile = manager.botsFile
  assert.deepStrictEqual(next.manager.restoreBots(), ['Garde'])
  const restored = next.manager.get('Garde')
  assert.strictEqual(restored.mode.name, 'antiafk')
  assert.strictEqual(restored.plugins.autoEat, false)
  assert.strictEqual(restored.status, 'offline', 'un bot hors ligne le reste')
  next.manager.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(next.dir, { recursive: true, force: true })
})

test('campagnes : valeurs par défaut, enregistrement et liste', () => {
  const { manager, dir } = createTestManager()
  const c = normalizeCampaign({ name: 'Charge du lundi', groups: [{ count: 3 }], setup: 'time set day\n# commentaire\n\nweather clear' })
  assert.strictEqual(c.id, 'charge-du-lundi')
  assert.deepStrictEqual(c.setup, ['time set day', 'weather clear'])
  assert.strictEqual(c.criteria.minAvgTps, 18)
  assert.strictEqual(c.groups[0].namePattern, 'Charge_{i}')
  const store = new CampaignStore(path.join(dir, 'campaigns'))
  store.save(c)
  assert.deepStrictEqual(store.list().map(x => [x.id, x.bots]), [['charge-du-lundi', 3]])
  assert.strictEqual(store.get('charge-du-lundi').name, 'Charge du lundi')
  assert.throws(() => store.save({ name: 'Vide' }), /au moins un groupe/)
  assert.ok(store.remove('charge-du-lundi'))
  manager.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('campagnes : critères évalués à partir des mesures', () => {
  const { manager, dir } = createTestManager()
  const campaign = normalizeCampaign({
    name: 'Critères',
    groups: [{ count: 4 }],
    criteria: { minAvgTps: 18, minLowTps: 15, minOnlineRatio: 0.9, maxKicks: 0, maxLoopLag: 200 }
  })
  const run = new CampaignRun({ manager, emit () {} }, campaign)
  run.botIds = ['A', 'B', 'C', 'D']
  run.loginAvg = 300
  run.samples = [
    { online: 4, tps: 19.8, ping: 2, loop: 20, seen: null },
    { online: 4, tps: 14.5, ping: 3, loop: 30, seen: null },
    { online: 3, tps: 19.9, ping: 2, loop: 220, seen: null }
  ]
  run.before = { kicks: 0, deaths: 0 }
  run.after = { kicks: 1, deaths: 0 }
  run.evaluate()
  const byText = text => run.report.assertions.find(a => a.message.includes(text))
  assert.strictEqual(byText('TPS moyen').ok, true) // (19,8 + 14,5 + 19,9) / 3 ≈ 18,07
  assert.strictEqual(byText('TPS minimum').ok, false)
  assert.strictEqual(byText('des bots en jeu').ok, true) // 11/12 ≈ 91,7 %
  assert.strictEqual(byText('expulsion').ok, false)
  assert.strictEqual(byText('Programme non saturé').ok, false)
  manager.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('processus ouvriers : bots hébergés ailleurs, pilotés par IPC', async () => {
  const { manager, dir } = createTestManager()
  const { WorkerPool } = require('../src/core/workers/WorkerPool')
  manager.pool = new WorkerPool(manager, { botsPerProcess: 5, maxProcesses: 1 })
  try {
    const bot = manager.createBot({ username: 'Distant', process: 'worker', connect: false, mode: 'idle' })
    assert.strictEqual(bot.remote, true)
    await waitFor(() => bot.lastState > 0, 15000)
    assert.strictEqual(bot.getState().process, 'P1')
    assert.strictEqual(bot.getState().status, 'offline')
    await bot.runAction('mode', { mode: 'antiafk', options: {} })
    await waitFor(() => bot.getState().mode.name === 'antiafk', 5000)
    assert.deepStrictEqual(await bot.getChat(10), [])
    await assert.rejects(bot.runAction('chat', { message: 'x' }), /n'est pas en jeu/)
    const logs = []
    manager.logger.on('line', l => logs.push(l))
    manager.removeBot('Distant')
    await waitFor(() => logs.some(l => l.source === 'manager' && /supprimé/.test(l.message)), 5000)
    assert.strictEqual(manager.get('Distant'), null)
  } finally {
    manager.pool.shutdown()
    manager.shutdown()
    await new Promise(resolve => setTimeout(resolve, 500))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
