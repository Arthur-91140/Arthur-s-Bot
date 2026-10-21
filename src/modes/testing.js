'use strict'

const {
  parseLines, parseList, randomInt, randomBetween, fillPlaceholders, toRegExp, chatToText,
  withTimeout, errorMessage
} = require('../core/utils')

/** Collecte les messages reçus pendant `ms` après l'action. */
async function capture (ctx, ms, action) {
  const messages = []
  const onMessage = ({ message }) => messages.push(message)
  ctx.instance.events.on('message', onMessage)
  try {
    if (action) await action()
    await ctx.sleep(ms)
  } finally {
    ctx.instance.events.removeListener('message', onMessage)
  }
  return messages
}

function describeWindow (window) {
  const items = window.slots.slice(0, window.inventoryStart)
    .map((it, i) => (it ? `${i}:${it.name}x${it.count}` : null))
    .filter(Boolean)
  return `"${chatToText(window.title)}" [${window.type}] ${items.join(', ')}`
}

const chatter = {
  name: 'chatter',
  label: 'Bavard',
  category: 'Tests',
  description: 'Envoie des messages en boucle — test des filtres de chat, anti-spam, formatage, logs.',
  options: [
    { key: 'messages', label: 'Messages (un par ligne)', type: 'text', default: 'Bonjour !\nMessage de test n°{i}\nNombre aléatoire : {rand}' },
    { key: 'order', label: 'Ordre', type: 'select', default: 'sequential', options: ['sequential', 'random'] },
    { key: 'minDelay', label: 'Délai min (ms)', type: 'number', default: 3000 },
    { key: 'maxDelay', label: 'Délai max (ms)', type: 'number', default: 8000 },
    { key: 'limit', label: 'Nombre de messages (0 = infini)', type: 'number', default: 0 }
  ],
  start (ctx) {
    const o = ctx.options
    const messages = parseLines(o.messages)
    if (!messages.length) return ctx.log.warn('Aucun message configuré')
    ctx.memory.sent = ctx.memory.sent || 0
    ctx.loop(async () => {
      if (o.limit > 0 && ctx.memory.sent >= o.limit) {
        ctx.log.info(`${ctx.memory.sent} messages envoyés, terminé`)
        return false
      }
      const i = ctx.memory.sent
      const template = o.order === 'random' ? messages[randomInt(0, messages.length - 1)] : messages[i % messages.length]
      ctx.instance.say(fillPlaceholders(template, { i: i + 1, username: ctx.bot.username }))
      ctx.memory.sent++
      await ctx.sleep(randomBetween(o.minDelay, Math.max(o.minDelay, o.maxDelay)))
    })
  }
}

const commander = {
  name: 'commander',
  label: 'Testeur de commandes',
  category: 'Tests',
  description: 'Exécute une liste de commandes, capture les réponses, mesure la latence et produit un rapport.',
  options: [
    { key: 'commands', label: 'Commandes (une par ligne, "wait 1000" pour patienter)', type: 'text', default: '/help\n/list\n/version' },
    { key: 'capture', label: 'Fenêtre de capture (ms)', type: 'number', default: 1500 },
    { key: 'delay', label: 'Délai entre commandes (ms)', type: 'number', default: 500 },
    { key: 'failPatterns', label: 'Motif d\'échec (regex)', type: 'string', default: 'unknown (or incomplete )?command|commande inconnue|(do not|don\'t) have permission|pas la permission|no permission|internal error|error occurred|erreur interne' },
    { key: 'requireResponse', label: 'Réponse obligatoire', type: 'boolean', default: false },
    { key: 'repeat', label: 'Répéter en boucle', type: 'boolean', default: false }
  ],
  start (ctx) {
    const o = ctx.options
    const lines = parseLines(o.commands)
    const failRe = o.failPatterns ? toRegExp(o.failPatterns) : null
    const report = ctx.state.report = ctx.createReport(`Commandes (${ctx.bot.username})`)
    ctx.loop(async () => {
      for (const line of lines) {
        const wait = line.match(/^wait\s+(\d+)/i)
        if (wait) {
          await ctx.sleep(Number(wait[1]))
          continue
        }
        const cmd = line.startsWith('/') ? line : `/${line}`
        const started = Date.now()
        let latency = null
        const onFirst = () => { if (latency === null) latency = Date.now() - started }
        ctx.instance.events.once('message', onFirst)
        const responses = await capture(ctx, o.capture, () => ctx.instance.say(cmd))
        ctx.instance.events.removeListener('message', onFirst)
        const failed = failRe && responses.some(r => failRe.test(r))
        const ok = !failed && !(o.requireResponse && responses.length === 0)
        const text = responses.length ? responses.join(' | ').slice(0, 400) : '(aucune réponse)'
        report.assert(ok, `${cmd} → ${text}`)
        if (latency !== null) report.metric(`latence ${cmd}`, latency)
        ctx.log.info(`${ok ? '✔' : '✘'} ${cmd} (${responses.length} réponse(s)${latency !== null ? `, ${latency} ms` : ''})`)
        await ctx.sleep(o.delay)
      }
      if (!o.repeat) {
        report.finish()
        return false
      }
    })
  },
  stop (ctx) {
    if (ctx.state.report) ctx.state.report.finish('stopped')
  }
}

const gui = {
  name: 'gui',
  label: 'Testeur de menus (GUI)',
  category: 'Tests',
  description: 'Ouvre un menu (commande ou objet), liste son contenu et clique sur des cases — test des GUI de plugins (shops, menus...).',
  options: [
    { key: 'openCommand', label: 'Commande d\'ouverture', type: 'string', default: '/menu', help: 'Vide = utiliser l\'objet en main' },
    { key: 'clicks', label: 'Cases à cliquer', type: 'string', default: '', help: 'Ex. "11, 13, 15"' },
    { key: 'clickDelay', label: 'Délai entre clics (ms)', type: 'number', default: 800 },
    { key: 'timeout', label: 'Attente d\'ouverture (ms)', type: 'number', default: 5000 },
    { key: 'closeAfter', label: 'Fermer à la fin', type: 'boolean', default: true },
    { key: 'repeatEvery', label: 'Répéter toutes les (s, 0 = non)', type: 'number', default: 0 }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const clicks = parseList(o.clicks).map(Number).filter(Number.isInteger)
    const report = ctx.state.report = ctx.createReport(`GUI ${o.openCommand || 'objet'} (${bot.username})`)

    const runOnce = async () => {
      const opened = ctx.waitFor('windowOpen', { timeout: o.timeout })
      if (o.openCommand) ctx.instance.say(o.openCommand)
      else bot.activateItem()
      const res = await opened
      if (!res) {
        report.assert(false, `Aucune fenêtre ouverte après "${o.openCommand || 'utilisation de l\'objet'}"`)
        return
      }
      report.assert(true, `Ouverte : ${describeWindow(res[0])}`)
      ctx.log.info(`Menu : ${describeWindow(res[0])}`)
      for (const slot of clicks) {
        if (!bot.currentWindow) {
          report.assert(false, `Fenêtre fermée avant le clic sur la case ${slot}`)
          break
        }
        const messages = await capture(ctx, o.clickDelay, async () => {
          await withTimeout(bot.clickWindow(slot, 0, 0), 5000, 'clic sans réponse')
        }).catch(err => {
          report.assert(false, `Clic ${slot} : ${errorMessage(err)}`)
          return null
        })
        if (!messages) continue
        const now = bot.currentWindow ? describeWindow(bot.currentWindow) : 'fenêtre fermée'
        report.assert(true, `Clic ${slot} → ${now}${messages.length ? ` | messages : ${messages.join(' | ')}` : ''}`)
      }
      if (o.closeAfter && bot.currentWindow) bot.closeWindow(bot.currentWindow)
    }

    ctx.loop(async () => {
      await runOnce()
      if (o.repeatEvery > 0) {
        await ctx.sleep(o.repeatEvery * 1000)
        return
      }
      report.finish()
      return false
    })
  },
  stop (ctx) {
    if (ctx.state.report) ctx.state.report.finish('stopped')
  }
}

const observer = {
  name: 'observer',
  label: 'Observateur',
  category: 'Tests',
  description: 'Surveille le serveur : TPS estimé, ping, joueurs, entités, chunks, connexions — et enregistre un rapport de métriques.',
  options: [
    { key: 'interval', label: 'Intervalle de mesure (s)', type: 'number', default: 30 },
    { key: 'logPlayers', label: 'Journaliser les arrivées/départs', type: 'boolean', default: true },
    { key: 'logChat', label: 'Journaliser le chat', type: 'boolean', default: false },
    { key: 'record', label: 'Enregistrer un rapport', type: 'boolean', default: true }
  ],
  start (ctx) {
    const bot = ctx.bot
    const o = ctx.options
    const report = ctx.state.report = o.record ? ctx.createReport(`Monitoring (${bot.username})`) : null
    const events = ctx.instance.events
    if (o.logPlayers) {
      ctx.on(events, 'playerJoined', ({ player }) => {
        ctx.log.info(`+ ${player} a rejoint`)
        if (report) report.entry(`+ ${player}`)
      })
      ctx.on(events, 'playerLeft', ({ player }) => {
        ctx.log.info(`- ${player} est parti`)
        if (report) report.entry(`- ${player}`)
      })
    }
    if (o.logChat) ctx.on(events, 'message', ({ message }) => ctx.log.info(`[chat] ${message}`))
    ctx.every(Math.max(2, o.interval) * 1000, () => {
      const players = Object.keys(bot.players).length
      const entities = Object.keys(bot.entities).length
      let chunks = null
      try { chunks = bot.world.getColumns().length } catch (err) { /* ignore */ }
      const tps = ctx.instance.tps
      const ping = bot.player ? bot.player.ping : null
      ctx.log.info(`TPS ${tps ?? '?'} | ping ${ping ?? '?'} ms | ${players} joueurs | ${entities} entités | ${chunks ?? '?'} chunks`)
      if (report) {
        if (tps !== null) report.metric('tps', tps)
        if (ping !== null) report.metric('ping', ping)
        report.metric('joueurs', players)
        report.metric('entités', entities)
      }
    })
  },
  stop (ctx) {
    if (ctx.state.report) ctx.state.report.finish('stopped')
  }
}

module.exports = [chatter, commander, gui, observer]
module.exports.capture = capture
