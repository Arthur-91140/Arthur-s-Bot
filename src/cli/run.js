'use strict'

const fs = require('fs')
const path = require('path')
const { createApp } = require('../app')
const { sleep } = require('../core/utils')

function xml (s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' }[c]))
}

/** Rapport JUnit (lisible par GitHub Actions, GitLab CI, Jenkins...). */
function toJUnit (reports) {
  const suites = reports.map(r => {
    const cases = r.assertions.map((a, i) => {
      const name = xml(a.message.slice(0, 200) || `assertion ${i + 1}`)
      return a.ok
        ? `    <testcase name="${name}" classname="${xml(r.name)}"/>`
        : `    <testcase name="${name}" classname="${xml(r.name)}"><failure message="${name}"/></testcase>`
    })
    for (const e of r.errors) cases.push(`    <testcase name="${xml(e.message.slice(0, 200))}" classname="${xml(r.name)}"><error message="${xml(e.message)}"/></testcase>`)
    if (!cases.length) {
      cases.push(r.status === 'passed'
        ? `    <testcase name="scénario" classname="${xml(r.name)}"/>`
        : `    <testcase name="scénario" classname="${xml(r.name)}"><failure message="${xml(`statut ${r.status} ${r.message || ''}`)}"/></testcase>`)
    }
    const failures = r.assertions.filter(a => !a.ok).length + (r.assertions.length || r.errors.length || r.status === 'passed' ? 0 : 1)
    return `  <testsuite name="${xml(r.name)}" tests="${cases.length}" failures="${failures}" errors="${r.errors.length}" time="${(r.duration / 1000).toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="arthur-bot">\n${suites.join('\n')}\n</testsuites>\n`
}

/**
 * Mode CI : connecte un ou plusieurs bots, exécute un graphe de test, attend la
 * fin (nœud "Fin du test") ou le délai, écrit les rapports et renvoie un code
 * de sortie 0 (tout est réussi) ou 1.
 */
async function runScenario (opts) {
  const overrides = {
    server: {},
    logs: { console: opts.quiet ? 'warn' : (opts.logLevel || 'info'), file: null },
    // Le scénario suit ses exécutions de graphe directement : tous les bots restent dans ce processus.
    workers: { enabled: false },
    // ne pas écraser les bots et les traces enregistrés de la session interactive
    session: { restoreBots: false },
    trails: { persist: false }
  }
  if (opts.host) overrides.server.host = opts.host
  if (opts.port) overrides.server.port = Number(opts.port)
  if (opts.version) overrides.server.version = opts.version
  const app = await createApp({ configPath: opts.config, overrides, web: !!opts.web, repl: false, restore: false })
  const { manager, logger } = app
  const log = logger.child('ci')

  const graph = manager.graphs.load(opts.graph)
  const count = Math.max(1, Number(opts.bots) || 1)
  const swarm = manager.createSwarm({
    count,
    namePattern: opts.name || (count > 1 ? 'Test_{i}' : 'Testeur'),
    joinDelay: opts.joinDelay !== undefined ? Number(opts.joinDelay) : undefined,
    mode: opts.mode || 'idle',
    autoReconnect: false
  })
  if (!swarm.created.length) {
    log.error(`Aucun bot créé : ${swarm.errors.join(' ; ')}`)
    return 2
  }
  const runtimes = manager.runGraph(graph, swarm.created)
  log.info(`Scénario "${graph.name}" lancé sur ${runtimes.length} bot(s)`)

  const timeout = (Number(opts.timeout) || 120) * 1000
  const deadline = Date.now() + timeout
  const spawnDeadline = Date.now() + (Number(opts.spawnTimeout) || 60) * 1000
  while (Date.now() < deadline && runtimes.some(r => r.active)) {
    for (const r of runtimes) {
      if (!r.active) continue
      const st = r.instance.status
      if (Date.now() > spawnDeadline && st !== 'online' && !r.instance.spawnedAt) {
        r.report.error(`Le bot n'a pas pu rejoindre le serveur (${r.instance.lastKick ? r.instance.lastKick.reason : r.instance.lastError || st})`)
        r.stop('Connexion impossible')
      }
    }
    await sleep(250)
  }
  for (const r of runtimes) if (r.active) r.stop('Délai du scénario dépassé')

  const reports = runtimes.map(r => r.report.toJSON())
  const ok = reports.every(r => r.status === 'passed')
  for (const r of reports) {
    const mark = r.status === 'passed' ? '✔' : '✘'
    process.stdout.write(`${mark} ${r.name} — ${r.status} — ${r.passed} réussie(s), ${r.failed} échouée(s), ${r.errors.length} erreur(s) en ${(r.duration / 1000).toFixed(1)} s\n`)
    for (const a of r.assertions) if (!a.ok) process.stdout.write(`    ✘ ${a.message}\n`)
    for (const e of r.errors) process.stdout.write(`    ! ${e.message}\n`)
  }
  if (opts.report) {
    fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true })
    fs.writeFileSync(opts.report, JSON.stringify({ graph: graph.id, ok, reports }, null, 2))
  }
  if (opts.junit) {
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true })
    fs.writeFileSync(opts.junit, toJUnit(reports))
  }
  process.stdout.write(ok ? 'Scénario réussi\n' : 'Scénario échoué\n')
  manager.shutdown()
  await sleep(600)
  return ok ? 0 : 1
}

/**
 * Lance une campagne (préparation, bots, mesure, critères) et renvoie 0 si elle
 * est réussie, 1 sinon. Les bots de la campagne peuvent aller dans des processus ouvriers.
 */
async function runCampaign (opts) {
  const overrides = {
    server: {},
    logs: { console: opts.quiet ? 'warn' : (opts.logLevel || 'info'), file: null },
    session: { restoreBots: false },
    trails: { persist: false }
  }
  if (opts.host) overrides.server.host = opts.host
  if (opts.port) overrides.server.port = Number(opts.port)
  if (opts.version) overrides.server.version = opts.version
  const app = await createApp({ configPath: opts.config, overrides, web: !!opts.web, repl: false, restore: false })
  const { manager, logger } = app
  let run
  try {
    run = manager.campaigns.start(opts.campaign)
  } catch (err) {
    logger.child('ci').error(err.message)
    manager.shutdown()
    await sleep(600)
    return 2
  }
  const report = (await run.done, run.report.toJSON())
  const ok = report.status === 'passed'
  process.stdout.write(`${ok ? '✔' : '✘'} ${report.name} — ${report.status} — ${report.passed} critère(s) respecté(s), ${report.failed} non respecté(s), ${report.errors.length} erreur(s)\n`)
  for (const a of report.assertions) process.stdout.write(`    ${a.ok ? '✔' : '✘'} ${a.message}\n`)
  for (const e of report.errors) process.stdout.write(`    ! ${e.message}\n`)
  if (opts.report) {
    fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true })
    fs.writeFileSync(opts.report, JSON.stringify({ campaign: run.campaign, ok, report }, null, 2))
  }
  if (opts.junit) {
    fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true })
    fs.writeFileSync(opts.junit, toJUnit([report]))
  }
  manager.shutdown()
  await sleep(1500)
  return ok ? 0 : 1
}

module.exports = { runScenario, runCampaign, toJUnit }
