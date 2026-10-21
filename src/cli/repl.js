'use strict'

const readline = require('readline')
const modes = require('../modes')
const { runBulk } = require('../core/actions')
const { pingServer } = require('../core/ping')
const { supportedVersions } = require('../core/versions')

const HELP = `
Commandes (cible = nom de bot, "all", liste "a,b" ou motif "Bot_*") :
  bots                              liste des bots
  add <pseudo> [mode]               crée et connecte un bot
  swarm <nombre> [motif] [mode]     crée un essaim (motif par défaut : Bot_{i})
  rm <cible>                        supprime des bots
  connect | disconnect | reconnect <cible>
  say <cible> <message>             envoie un message ou une /commande
  mode <cible> <mode> [json]        change de mode (ex. : mode all follow {"target":"Arthur"})
  goto <cible> <x> <y|~> <z>        déplace les bots
  stop <cible>                      arrête les déplacements
  info <bot>                        état détaillé
  chat <bot> [n]                    derniers messages reçus
  focus <bot|off>                   affiche en direct le chat d'un bot
  graphs                            graphes enregistrés
  run <graphe|fichier> [cible]      lance un graphe
  runs                              exécutions de graphes
  stopgraph <id|all>                arrête une exécution
  signal <nom> [cible]              envoie un signal aux nœuds "Signal reçu"
  reports                           derniers rapports de test
  ping [hôte[:port]]                interroge un serveur
  modes | versions                  listes de référence
  quit                              quitter
`

function splitArgs (line) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function startRepl (app, onQuit) {
  const { manager, logger, config } = app
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'arthur-bot> ',
    completer: line => {
      const words = ['bots', 'add', 'swarm', 'rm', 'connect', 'disconnect', 'reconnect', 'say', 'mode', 'goto', 'stop',
        'info', 'chat', 'focus', 'graphs', 'run', 'runs', 'stopgraph', 'signal', 'reports', 'ping', 'modes', 'versions', 'help', 'quit',
        ...manager.list().map(b => b.id), ...modes.list().map(m => m.name)]
      const last = line.split(/\s+/).pop()
      const hits = words.filter(w => w.startsWith(last))
      return [hits.length ? hits : words, last]
    }
  })
  const print = text => {
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    process.stdout.write(text + '\n')
    rl.prompt(true)
  }
  logger.setPrinter(print)

  let focus = null
  manager.on('chat', c => {
    if (focus && c.botId === focus) print(`\x1b[32m[${c.botId}] ${c.type === 'self' ? '> ' : ''}${c.message}\x1b[0m`)
  })

  const bulk = async (target, action, payload) => {
    const res = await runBulk(manager, target, action, payload)
    const failed = Object.entries(res.results).filter(([, r]) => !r.ok)
    print(`${action} : ${res.count - failed.length}/${res.count} OK`)
    for (const [id, r] of failed) print(`  ${id} : ${r.error}`)
  }

  const commands = {
    help: () => print(HELP),
    bots: () => {
      const list = manager.states()
      if (!list.length) return print('Aucun bot. Exemple : add Testeur')
      for (const s of list) {
        const pos = s.position ? `${s.position.x} ${s.position.y} ${s.position.z}` : '-'
        print(`${s.id.padEnd(16)} ${s.status.padEnd(12)} ❤ ${String(s.health ?? '-').padEnd(4)} 🍗 ${String(s.food ?? '-').padEnd(3)} ${pos.padEnd(22)} ${s.modeLabel}${s.runtimes.length ? ` | ${s.runtimes.length} graphe(s)` : ''}`)
      }
    },
    add: ([name, mode]) => {
      if (!name) return print('Usage : add <pseudo> [mode]')
      manager.createBot({ username: name, mode: mode || 'idle' })
    },
    swarm: ([count, pattern, mode]) => {
      const res = manager.createSwarm({ count: Number(count) || 1, namePattern: pattern, mode: mode || 'idle' })
      print(`Créés : ${res.created.join(', ') || 'aucun'}${res.errors.length ? ` | erreurs : ${res.errors.join(' ; ')}` : ''}`)
    },
    rm: ([target]) => {
      const ids = manager.resolve(target).map(b => b.id)
      ids.forEach(id => manager.removeBot(id))
      print(`${ids.length} bot(s) supprimé(s)`)
    },
    connect: ([t]) => bulk(t, 'connect'),
    disconnect: ([t]) => bulk(t, 'disconnect'),
    reconnect: ([t]) => bulk(t, 'reconnect'),
    say: ([t, ...rest]) => bulk(t, 'chat', { message: rest.join(' ') }),
    mode: ([t, name, ...json]) => {
      let options = {}
      if (json.length) {
        try {
          options = JSON.parse(json.join(' '))
        } catch (err) {
          return print(`JSON invalide : ${err.message}`)
        }
      }
      return bulk(t, 'mode', { mode: name, options })
    },
    goto: ([t, x, y, z]) => bulk(t, 'goto', { x: Number(x), y: y === '~' ? null : Number(y), z: Number(z) }),
    stop: ([t]) => bulk(t, 'stop'),
    info: ([id]) => {
      const b = manager.get(id)
      if (!b) return print('Bot introuvable')
      print(JSON.stringify(b.getState(), null, 2))
    },
    chat: ([id, n]) => {
      const b = manager.get(id)
      if (!b) return print('Bot introuvable')
      for (const c of b.chatHistory.slice(-(Number(n) || 20))) print(`${new Date(c.t).toLocaleTimeString('fr-FR')} ${c.type === 'self' ? '> ' : ''}${c.message}`)
    },
    focus: ([id]) => {
      focus = !id || id === 'off' ? null : id
      print(focus ? `Chat de ${focus} affiché en direct` : 'Affichage du chat désactivé')
    },
    graphs: () => {
      const list = manager.graphs.list()
      if (!list.length) print('Aucun graphe enregistré (créez-en dans l\'éditeur web).')
      for (const g of list) print(`${g.id.padEnd(28)} ${g.name} (${g.nodes} nœuds)`)
    },
    run: ([ref, target]) => {
      const rts = manager.runGraph(ref, target || 'all')
      print(`Lancé sur ${rts.length} bot(s) : ${rts.map(r => r.id).join(', ')}`)
    },
    runs: () => {
      for (const r of manager.listRuntimes().slice(0, 30)) print(`${r.id} ${r.status.padEnd(9)} ${r.botId.padEnd(16)} ${r.name}`)
    },
    stopgraph: ([id]) => {
      if (!id || id === 'all') print(`${manager.stopRuntimes()} exécution(s) arrêtée(s)`)
      else print(manager.stopRuntime(id) ? 'Arrêtée' : 'Introuvable')
    },
    signal: ([name, target]) => print(`Signal "${name}" envoyé à ${manager.trigger(name, null, target || 'all')} bot(s)`),
    reports: () => {
      for (const r of manager.reports.list().slice(0, 20)) {
        print(`${r.status.padEnd(8)} ${r.name} — ${r.passed} ✔ / ${r.failed} ✘ / ${r.errors} erreur(s)`)
      }
    },
    ping: async ([target]) => {
      const [host, port] = (target || `${config.server.host}:${config.server.port}`).split(':')
      const r = await pingServer({ host, port: Number(port) || 25565 })
      if (!r.online) return print(`Hors ligne : ${r.error}`)
      print(`${r.host}:${r.port} — ${r.version} (protocole ${r.protocol}${r.supported ? '' : ', non supporté'}) — ${r.players ? `${r.players.online}/${r.players.max}` : '?'} joueurs — ${r.latency} ms\n${r.motd}`)
    },
    modes: () => {
      for (const m of modes.list()) print(`${m.name.padEnd(12)} ${m.label} — ${m.description}`)
    },
    versions: () => print(supportedVersions().join(' ')),
    quit: () => onQuit(),
    exit: () => onQuit()
  }

  rl.on('line', async line => {
    const [cmd, ...args] = splitArgs(line.trim())
    if (cmd) {
      const fn = commands[cmd]
      if (!fn) print(`Commande inconnue : ${cmd} (tapez help)`)
      else {
        try {
          await fn(args)
        } catch (err) {
          print(`Erreur : ${err.message}`)
        }
      }
    }
    rl.prompt()
  })
  rl.on('close', () => onQuit())
  print('Console prête — tapez "help" pour la liste des commandes.')
  rl.prompt()
  return rl
}

module.exports = { startRepl }
