'use strict'

const pkg = require('../../package.json')

const USAGE = `Arthur's Bot ${pkg.version} — bots Minecraft de test

Utilisation :
  arthur-bot [start] [options]          interface web + console interactive
  arthur-bot run <graphe> [options]     exécute un scénario de test (CI) puis quitte
  arthur-bot ping [hôte[:port]]         interroge un serveur
  arthur-bot versions                   versions de Minecraft supportées
  arthur-bot modes                      modes prédéfinis
  arthur-bot nodes                      types de nœuds du programmateur visuel

Options communes :
  --config <fichier>      fichier de configuration (défaut : config/config.json)
  --host <hôte>           serveur Minecraft          --port <port>    port Minecraft
  --version <v>           version (ex. 1.20.4, auto)

Options de start :
  --web-port <port>       port de l'interface (3000)  --web-host <ip>  adresse d'écoute
  --token <jeton>         protège l'interface/API     --no-web --no-repl

Options de run :
  --bots <n>              nombre de bots (1)          --name <motif>   ex. "Test_{i}"
  --timeout <s>           durée max (120)             --spawn-timeout <s> (60)
  --join-delay <ms>       délai entre bots            --mode <mode>    mode initial
  --report <fichier.json> --junit <fichier.xml>       --quiet
`

function parseArgs (argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--no-')) {
      opts[camel(a.slice(5))] = false
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      const next = argv[i + 1]
      if (v !== undefined) opts[camel(k)] = v
      else if (next !== undefined && !next.startsWith('--')) {
        opts[camel(k)] = next
        i++
      } else opts[camel(k)] = true
    } else {
      opts._.push(a)
    }
  }
  return opts
}

function camel (s) {
  return s.replace(/-([a-z])/g, (m, c) => c.toUpperCase())
}

async function main (argv) {
  const opts = parseArgs(argv)
  const command = opts._[0] || 'start'

  if (opts.help || command === 'help') {
    process.stdout.write(USAGE)
    return
  }

  switch (command) {
    case 'start': {
      const { createApp } = require('../app')
      const overrides = { server: {}, web: {} }
      if (opts.host) overrides.server.host = opts.host
      if (opts.port) overrides.server.port = Number(opts.port)
      if (opts.version) overrides.server.version = opts.version
      if (opts.webPort) overrides.web.port = Number(opts.webPort)
      if (opts.webHost) overrides.web.host = opts.webHost
      if (opts.token) overrides.web.token = String(opts.token)
      await createApp({ configPath: opts.config, overrides, web: opts.web !== false, repl: opts.repl !== false })
      return
    }
    case 'run': {
      const graph = opts._[1] || opts.graph
      if (!graph) {
        process.stderr.write('Indiquez un graphe : arthur-bot run graphs/mon-test.json\n')
        process.exitCode = 2
        return
      }
      const { runScenario } = require('./run')
      process.exitCode = await runScenario({ ...opts, graph })
      process.exit(process.exitCode)
      return
    }
    case 'ping': {
      const { pingServer } = require('../core/ping')
      const [host, port] = String(opts._[1] || 'localhost:25565').split(':')
      const r = await pingServer({ host, port: Number(port) || 25565 })
      delete r.favicon
      process.stdout.write(JSON.stringify(r, null, 2) + '\n')
      process.exitCode = r.online ? 0 : 1
      return
    }
    case 'versions': {
      const { supportedVersions } = require('../core/versions')
      process.stdout.write(supportedVersions().join('\n') + '\n')
      return
    }
    case 'modes': {
      for (const m of require('../modes').list()) {
        process.stdout.write(`${m.name.padEnd(12)} ${m.label} — ${m.description}\n`)
        for (const o of m.options) process.stdout.write(`    ${o.key.padEnd(16)} ${o.label} (défaut : ${JSON.stringify(o.default)})\n`)
      }
      return
    }
    case 'nodes': {
      let category = null
      for (const n of require('../graph/registry').list()) {
        if (n.category !== category) {
          category = n.category
          process.stdout.write(`\n${category}\n`)
        }
        process.stdout.write(`  ${n.type.padEnd(22)} ${n.label} — ${n.description}\n`)
      }
      return
    }
    default:
      process.stderr.write(`Commande inconnue : ${command}\n\n${USAGE}`)
      process.exitCode = 2
  }
}

module.exports = { main, parseArgs }
