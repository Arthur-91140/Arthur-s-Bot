'use strict'

const mc = require('minecraft-protocol')
const { chatToText, withTimeout, errorMessage } = require('./utils')
const { versionForProtocol, supportedVersions } = require('./versions')

/** Interroge un serveur (Server List Ping) : version, joueurs, MOTD, latence. */
async function pingServer ({ host = 'localhost', port = 25565, timeout = 5000 } = {}) {
  const started = Date.now()
  try {
    const res = await withTimeout(mc.ping({ host, port: Number(port), closeTimeout: timeout }), timeout + 500, 'Pas de réponse au ping')
    const protocol = res.version ? res.version.protocol : null
    const botVersion = protocol ? versionForProtocol(protocol) : null
    return {
      online: true,
      host,
      port: Number(port),
      latency: res.latency ?? Date.now() - started,
      version: res.version ? res.version.name : null,
      protocol,
      botVersion,
      supported: !!botVersion && supportedVersions().includes(botVersion),
      players: res.players ? { online: res.players.online, max: res.players.max, sample: (res.players.sample || []).map(p => p.name) } : null,
      motd: chatToText(res.description),
      favicon: res.favicon || null,
      modded: !!(res.modinfo || res.forgeData)
    }
  } catch (err) {
    return { online: false, host, port: Number(port), error: errorMessage(err) }
  }
}

module.exports = { pingServer }
