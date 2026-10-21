'use strict'

const mcData = require('minecraft-data')
const mineflayer = require('mineflayer')

const RELEASE = /^\d+\.\d+(\.\d+)?$/

function compare (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** Versions Java utilisables par les bots (de la plus récente à la plus ancienne). */
function supportedVersions () {
  const oldest = mineflayer.oldestSupportedVersion || '1.8.8'
  const latest = mineflayer.latestSupportedVersion
  const set = new Set(mineflayer.testedVersions || [])
  for (const v of mcData.supportedVersions.pc) {
    if (RELEASE.test(v) && compare(v, oldest.replace(/\.\d+$/, '')) >= 0 && compare(v, latest) <= 0) set.add(v)
  }
  return [...set].filter(v => RELEASE.test(v)).sort((a, b) => compare(b, a))
}

/** Nom de version supporté correspondant à un numéro de protocole (pour le ping). */
function versionForProtocol (protocol) {
  const entries = mcData.postNettyVersionsByProtocolVersion.pc[protocol] || []
  const supported = new Set(supportedVersions())
  const names = entries.map(e => e.minecraftVersion)
  return names.find(n => supported.has(n)) || names.find(n => RELEASE.test(n)) || null
}

module.exports = {
  supportedVersions,
  versionForProtocol,
  testedVersions: mineflayer.testedVersions || [],
  latest: mineflayer.latestSupportedVersion,
  oldest: mineflayer.oldestSupportedVersion
}
