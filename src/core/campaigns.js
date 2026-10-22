'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { slugify } = require('../graph/GraphStore')
const { sleep, waitForEvent, isAbortError, errorMessage, round } = require('./utils')

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PHASES = {
  preparing: 'Préparation du serveur',
  connecting: 'Connexion des bots',
  warmup: 'Mise en route',
  measuring: 'Mesure',
  finishing: 'Nettoyage',
  done: 'Terminée'
}

const num = (v, fallback = null) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v))
const lines = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(s => String(s).trim()).filter(s => s && !s.startsWith('#'))

/** Valeurs par défaut et types d'une campagne. */
function normalizeCampaign (c = {}) {
  const criteria = c.criteria || {}
  return {
    id: c.id && ID_RE.test(c.id) ? c.id : slugify(c.name || 'campagne'),
    name: String(c.name || c.id || 'Campagne'),
    description: String(c.description || ''),
    server: {
      host: (c.server && c.server.host) || '',
      port: num(c.server && c.server.port, 0),
      version: (c.server && c.server.version) || ''
    },
    groups: (Array.isArray(c.groups) ? c.groups : []).map(g => ({
      count: Math.max(1, Math.min(1000, num(g.count, 1))),
      namePattern: g.namePattern || 'Charge_{i}',
      mode: g.mode || 'idle',
      modeOptions: g.modeOptions || {},
      graph: g.graph || '',
      mix: Array.isArray(g.mix) && g.mix.length ? g.mix : null
    })),
    interleave: !!c.interleave, // mélanger les groupes à la connexion (population mixte)
    joinDelay: Math.max(0, num(c.joinDelay, 1000)),
    connectTimeout: Math.max(0, num(c.connectTimeout, 0)),
    warmup: Math.max(0, num(c.warmup, 15)),
    duration: Math.max(5, num(c.duration, 120)),
    autoReconnect: !!c.autoReconnect,
    keepBots: !!c.keepBots,
    setup: lines(c.setup),
    teardown: lines(c.teardown),
    settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
    criteria: {
      minAvgTps: num(criteria.minAvgTps, 18),
      minLowTps: num(criteria.minLowTps, null),
      minOnlineRatio: num(criteria.minOnlineRatio, 0.95),
      maxKicks: num(criteria.maxKicks, 0),
      maxDeaths: num(criteria.maxDeaths, null),
      maxAvgLoginMs: num(criteria.maxAvgLoginMs, null),
      maxLoopLag: num(criteria.maxLoopLag, 250),
      graphsPassed: criteria.graphsPassed !== false,
      serverSeesAll: !!criteria.serverSeesAll
    }
  }
}

/** Stockage des campagnes : un fichier JSON par campagne dans campaigns/. */
class CampaignStore {
  constructor (dir) {
    this.dir = dir
    if (dir) fs.mkdirSync(dir, { recursive: true })
  }

  file (id) {
    if (!ID_RE.test(id)) throw new Error(`Identifiant de campagne invalide : ${id}`)
    return path.join(this.dir, `${id}.json`)
  }

  list () {
    if (!this.dir) return []
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const c = normalizeCampaign({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) })
          c.id = f.slice(0, -5)
          return { id: c.id, name: c.name, description: c.description, bots: c.groups.reduce((n, g) => n + g.count, 0), duration: c.duration, updatedAt: fs.statSync(path.join(this.dir, f)).mtimeMs }
        } catch (err) {
          return { id: f.slice(0, -5), name: f, description: `Fichier illisible : ${err.message}`, broken: true }
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  }

  get (id) {
    const file = this.file(id)
    if (!fs.existsSync(file)) return null
    const c = normalizeCampaign(JSON.parse(fs.readFileSync(file, 'utf8')))
    c.id = id
    return c
  }

  /** Une campagne enregistrée, un fichier JSON ou un objet. */
  load (ref) {
    if (ref && typeof ref === 'object') return normalizeCampaign(ref)
    if (this.dir && ID_RE.test(ref) && fs.existsSync(this.file(ref))) return this.get(ref)
    const file = path.resolve(String(ref))
    if (fs.existsSync(file)) return normalizeCampaign({ id: slugify(path.basename(file, '.json')), ...JSON.parse(fs.readFileSync(file, 'utf8')) })
    throw new Error(`Campagne introuvable : ${ref}`)
  }

  save (campaign) {
    const c = normalizeCampaign(campaign)
    if (!c.groups.length) throw new Error('La campagne doit contenir au moins un groupe de bots')
    fs.writeFileSync(this.file(c.id), JSON.stringify(c, null, 2))
    return c
  }

  remove (id) {
    const file = this.file(id)
    if (!fs.existsSync(file)) return false
    fs.unlinkSync(file)
    return true
  }
}

const avg = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null)

/** Une exécution de campagne : préparation, connexion, mise en route, mesure, critères, nettoyage. */
class CampaignRun {
  constructor (runner, campaign) {
    this.runner = runner
    this.manager = runner.manager
    this.campaign = campaign
    this.id = `camp${Date.now().toString(36)}`
    this.phase = 'preparing'
    this.phaseEndsAt = null
    this.startedAt = Date.now()
    this.endedAt = null
    this.status = 'running'
    this.message = ''
    this.botIds = []
    this.samples = []
    this.restore = {}
    this.abort = new AbortController()
    this.log = this.manager.logger.child('campagne')
    this.report = this.manager.reports.create({ kind: 'campaign', name: `Campagne : ${campaign.name}`, source: `campagne:${campaign.id}` })
  }

  public () {
    const states = this._states()
    return {
      id: this.id,
      campaignId: this.campaign.id,
      name: this.campaign.name,
      phase: this.phase,
      phaseLabel: PHASES[this.phase],
      phaseEndsAt: this.phaseEndsAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.status,
      message: this.message,
      bots: this.botIds.length,
      expected: this.campaign.groups.reduce((n, g) => n + g.count, 0),
      online: states.filter(s => s.status === 'online').length,
      reportId: this.report.id,
      samples: this.samples.length
    }
  }

  _states () {
    const ids = new Set(this.botIds)
    return this.manager.states().filter(s => ids.has(s.id))
  }

  _phase (phase, seconds = null) {
    this.phase = phase
    this.phaseEndsAt = seconds ? Date.now() + seconds * 1000 : null
    this.report.entry(`— ${PHASES[phase]}${seconds ? ` (${seconds} s)` : ''}`)
    this.runner.emit('update', this.public())
  }

  _sleep (ms) {
    return sleep(ms, this.abort.signal)
  }

  async run () {
    const c = this.campaign
    this.log.info(`Campagne « ${c.name} » lancée`)
    try {
      this._phase('preparing')
      await this.prepare()
      this._phase('connecting')
      await this.connect()
      if (c.warmup) {
        this._phase('warmup', c.warmup)
        await this._sleep(c.warmup * 1000)
      }
      this._phase('measuring', c.duration)
      await this.measure()
      this.evaluate()
    } catch (err) {
      if (isAbortError(err)) {
        this.status = 'stopped'
        this.message = 'Arrêtée avant la fin'
        this.report.entry('Campagne arrêtée avant la fin')
      } else {
        this.status = 'error'
        this.message = errorMessage(err)
        this.report.error(`Campagne interrompue : ${this.message}`)
        this.log.error(`Campagne « ${c.name} » : ${this.message}`)
      }
    }
    this._phase('finishing')
    await this.cleanup()
    this.endedAt = Date.now()
    this.report.finish(this.status === 'running' ? 'auto' : this.status, this.message)
    this.status = this.report.status
    this.phase = 'done'
    this.log.info(`Campagne « ${c.name} » terminée : ${this.status}`)
    this.runner.emit('update', this.public())
    return this.report
  }

  async prepare () {
    const c = this.campaign
    const server = this.manager.server
    // Au démarrage du programme, le protocole de gestion met un instant à se connecter.
    const state = server.state ? server.state() : null
    const mgmt = state && state.management
    if (mgmt && !mgmt.connected && (Object.keys(c.settings).length || c.criteria.serverSeesAll)) {
      await waitForEvent(server, 'state', { timeout: 8000, signal: this.abort.signal, filter: s => s && s.management && s.management.connected })
    }
    for (const [name, value] of Object.entries(c.settings)) {
      try {
        this.restore[name] = await server.manage(`serversettings/${name}`, [])
        await server.manage(`serversettings/${name}/set`, [value])
        this.report.entry(`Réglage ${name} : ${JSON.stringify(this.restore[name])} → ${JSON.stringify(value)}`)
      } catch (err) {
        this.report.error(`Réglage ${name} impossible : ${errorMessage(err)}`)
      }
    }
    for (const command of c.setup) {
      try {
        const res = await server.runRcon(command)
        this.report.entry(`RCON ${command} → ${res || 'ok'}`)
      } catch (err) {
        this.report.error(`RCON ${command} : ${errorMessage(err)}`)
      }
    }
  }

  async connect () {
    const c = this.campaign
    const target = {}
    if (c.server.host) target.host = c.server.host
    if (c.server.port) target.port = c.server.port
    if (c.server.version) target.version = c.server.version
    // Groupes mélangés : un seul essaim dont les comportements sont répartis selon les effectifs.
    const groups = c.interleave && c.groups.length > 1
      ? [{
          count: c.groups.reduce((n, g) => n + g.count, 0),
          namePattern: c.groups[0].namePattern,
          mode: c.groups[0].mode,
          mix: c.groups.map(g => ({ weight: g.count, mode: g.mode, modeOptions: g.modeOptions, graph: g.graph || undefined }))
        }]
      : c.groups
    let offset = 0 // les groupes se connectent les uns après les autres
    for (const g of groups) {
      const res = this.manager.createSwarm({
        ...target,
        count: g.count,
        namePattern: g.namePattern,
        mode: g.mode,
        modeOptions: g.modeOptions,
        graph: g.graph || undefined,
        mix: g.mix || undefined,
        joinDelay: c.joinDelay,
        joinOffset: offset * c.joinDelay,
        autoReconnect: c.autoReconnect,
        temporary: true
      })
      this.botIds.push(...res.created)
      for (const e of res.errors) this.report.error(`Création des bots : ${e}`)
      offset += res.created.length
    }
    if (!this.botIds.length) throw new Error('aucun bot créé')
    const timeout = c.connectTimeout ? c.connectTimeout * 1000 : this.botIds.length * c.joinDelay + 60000
    this.phaseEndsAt = Date.now() + timeout
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const online = this._states().filter(s => s.status === 'online').length
      this.runner.emit('update', this.public())
      if (online >= this.botIds.length) break
      await this._sleep(1000)
    }
    const states = this._states()
    const online = states.filter(s => s.status === 'online')
    const logins = states.map(s => s.stats && s.stats.lastLoginMs).filter(Number.isFinite)
    this.loginAvg = avg(logins)
    this.report.entry(`Connexion : ${online.length}/${this.botIds.length} bots en jeu en ${round((Date.now() - started) / 1000, 1)} s${logins.length ? `, connexion moyenne ${Math.round(this.loginAvg)} ms (max ${Math.max(...logins)} ms)` : ''}`)
    const failed = states.filter(s => s.status !== 'online')
    const reasons = {}
    for (const s of failed) {
      const r = (s.lastKick && s.lastKick.reason) || s.lastError || s.status
      reasons[r] = (reasons[r] || 0) + 1
    }
    for (const [r, n] of Object.entries(reasons)) this.report.entry(`${n} bot(s) non connecté(s) : ${r}`)
    if (logins.length) this.report.metric('Temps de connexion (ms)', Math.round(this.loginAvg))
  }

  totals () {
    const t = { kicks: 0, deaths: 0 }
    for (const s of this._states()) {
      t.kicks += (s.stats && s.stats.kicks) || 0
      t.deaths += (s.stats && s.stats.deaths) || 0
    }
    return t
  }

  async measure () {
    const c = this.campaign
    const interval = Math.max(1000, Math.round((c.duration * 1000 * 5) / 1800))
    this.before = this.totals()
    this.measureStartedAt = Date.now()
    const end = Date.now() + c.duration * 1000
    while (Date.now() < end) {
      const states = this._states()
      const online = states.filter(s => s.status === 'online')
      const tps = avg(online.map(s => s.tps).filter(Number.isFinite))
      const ping = avg(online.map(s => s.ping).filter(Number.isFinite))
      const health = this.manager.health
      const serverPlayers = this.manager.server.serverPlayers()
      const seen = serverPlayers ? this.botIds.filter(id => serverPlayers.includes(id)).length : null
      const sample = { t: Date.now(), online: online.length, tps, ping, loop: health ? health.loopP99 : null, seen }
      this.samples.push(sample)
      if (tps !== null) this.report.metric('TPS', round(tps, 2))
      this.report.metric('Bots en jeu', online.length)
      if (ping !== null) this.report.metric('Ping moyen (ms)', round(ping, 1))
      if (sample.loop !== null) this.report.metric('Retard de boucle du programme (ms)', sample.loop)
      if (seen !== null) this.report.metric('Bots vus par le serveur', seen)
      this.runner.emit('update', this.public())
      await this._sleep(Math.min(interval, Math.max(0, end - Date.now())) || 1)
    }
    this.after = this.totals()
  }

  evaluate () {
    const c = this.campaign
    const k = c.criteria
    const s = this.samples
    const tpsList = s.map(x => x.tps).filter(v => v !== null)
    const tpsAvg = avg(tpsList)
    const tpsLow = tpsList.length ? Math.min(...tpsList) : null
    const onlineRatio = s.length && this.botIds.length ? avg(s.map(x => x.online)) / this.botIds.length : 0
    const kicks = this.after.kicks - this.before.kicks
    const deaths = this.after.deaths - this.before.deaths
    const loopMax = s.map(x => x.loop).filter(v => v !== null).reduce((m, v) => Math.max(m, v), 0)
    const summary = [
      `TPS moyen ${tpsAvg !== null ? round(tpsAvg, 2) : '?'} (min ${tpsLow ?? '?'})`,
      `${round(onlineRatio * 100, 1)} % des bots en jeu`,
      `${kicks} expulsion(s)`,
      `${deaths} mort(s)`,
      `retard de boucle max ${loopMax} ms`
    ]
    this.report.entry(`Mesure : ${summary.join(', ')}`)
    const check = (ok, text) => this.report.assert(ok, text)
    if (k.minAvgTps !== null) check(tpsAvg !== null && tpsAvg >= k.minAvgTps, `TPS moyen ${tpsAvg !== null ? round(tpsAvg, 2) : 'non mesuré'} ≥ ${k.minAvgTps}`)
    if (k.minLowTps !== null) check(tpsLow !== null && tpsLow >= k.minLowTps, `TPS minimum ${tpsLow ?? 'non mesuré'} ≥ ${k.minLowTps}`)
    if (k.minOnlineRatio !== null) check(onlineRatio >= k.minOnlineRatio, `${round(onlineRatio * 100, 1)} % des bots en jeu ≥ ${round(k.minOnlineRatio * 100, 1)} %`)
    if (k.maxKicks !== null) check(kicks <= k.maxKicks, `${kicks} expulsion(s) ≤ ${k.maxKicks}`)
    if (k.maxDeaths !== null) check(deaths <= k.maxDeaths, `${deaths} mort(s) ≤ ${k.maxDeaths}`)
    if (k.maxAvgLoginMs !== null) check(this.loginAvg !== null && this.loginAvg <= k.maxAvgLoginMs, `Connexion moyenne ${this.loginAvg !== null ? Math.round(this.loginAvg) : '?'} ms ≤ ${k.maxAvgLoginMs} ms`)
    if (k.maxLoopLag !== null) check(loopMax <= k.maxLoopLag, `Programme non saturé : retard de boucle max ${loopMax} ms ≤ ${k.maxLoopLag} ms (sinon les mesures sont faussées)`)
    if (k.serverSeesAll) {
      const seen = s.map(x => x.seen).filter(v => v !== null)
      check(seen.length > 0 && seen[seen.length - 1] >= s[s.length - 1].online, seen.length
        ? `Le serveur voit tous les bots en jeu (${seen[seen.length - 1]}/${s[s.length - 1].online})`
        : 'Le serveur voit tous les bots : protocole de gestion indisponible')
    }
    if (k.graphsPassed && c.groups.some(g => g.graph || (g.mix && g.mix.some(m => m.graph)))) {
      const ids = new Set(this.botIds)
      const reports = this.manager.reports.list().filter(r => r.kind === 'graph' && ids.has(r.botId) && r.startedAt >= this.startedAt)
      const failed = reports.filter(r => r.status === 'failed' || r.status === 'error')
      check(reports.length > 0 && !failed.length, `Graphes de test : ${reports.length - failed.length}/${reports.length} réussi(s)`)
    }
  }

  async cleanup () {
    const c = this.campaign
    for (const id of this.botIds) {
      try {
        this.manager.stopRuntimes({ botId: id })
      } catch (err) { /* bot déjà supprimé */ }
    }
    if (!c.keepBots) {
      for (const id of this.botIds) this.manager.removeBot(id)
      if (this.botIds.length) this.report.entry(`${this.botIds.length} bot(s) supprimé(s)`)
    }
    for (const [name, value] of Object.entries(this.restore)) {
      try {
        await this.manager.server.manage(`serversettings/${name}/set`, [value])
      } catch (err) {
        this.report.error(`Réglage ${name} non rétabli : ${errorMessage(err)}`)
      }
    }
    for (const command of c.teardown) {
      try {
        const res = await this.manager.server.runRcon(command)
        this.report.entry(`RCON ${command} → ${res || 'ok'}`)
      } catch (err) {
        this.report.error(`RCON ${command} : ${errorMessage(err)}`)
      }
    }
  }
}

/** Lance les campagnes (une à la fois) et diffuse leur avancement. */
class CampaignRunner extends EventEmitter {
  constructor (manager, dir) {
    super()
    this.manager = manager
    this.store = new CampaignStore(dir)
    this.active = null
    this.last = null
  }

  state () {
    return this.active ? this.active.public() : this.last
  }

  /** `server` : serveur à viser quand la campagne n'en précise pas (celui choisi dans l'interface). */
  start (ref, { server = null } = {}) {
    if (this.active) throw new Error(`Une campagne est déjà en cours : ${this.active.campaign.name}`)
    const campaign = this.store.load(ref)
    if (server && !campaign.server.host) {
      campaign.server = { host: server.host || '', port: Number(server.port) || 0, version: campaign.server.version || (server.version !== 'auto' ? server.version || '' : '') }
    }
    if (!campaign.groups.length) throw new Error('La campagne ne contient aucun groupe de bots')
    const run = new CampaignRun(this, campaign)
    this.active = run
    run.done = run.run().finally(() => {
      this.last = run.public()
      this.active = null
      this.emit('update', this.last)
    })
    return run
  }

  stop () {
    if (!this.active) return false
    this.active.abort.abort()
    return true
  }
}

module.exports = { CampaignRunner, CampaignRun, CampaignStore, normalizeCampaign, PHASES }
