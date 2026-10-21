'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Fusion profonde : les valeurs de `override` remplacent celles de `base`. */
function deepMerge (base, override) {
  if (!isPlainObject(base)) return override === undefined ? base : override
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Charge la configuration : config/default.json, puis config/config.json (ou le
 * fichier passé en paramètre / ARTHUR_CONFIG), puis les variables d'environnement.
 */
function loadConfig (configPath) {
  let config = readJson(path.join(ROOT, 'config', 'default.json'))
  const userFile = configPath || process.env.ARTHUR_CONFIG || path.join(ROOT, 'config', 'config.json')
  if (fs.existsSync(userFile)) {
    config = deepMerge(config, readJson(userFile))
    config._file = path.resolve(userFile)
  }

  const env = process.env
  if (env.MC_HOST) config.server.host = env.MC_HOST
  if (env.MC_PORT) config.server.port = Number(env.MC_PORT)
  if (env.MC_VERSION) config.server.version = env.MC_VERSION
  if (env.WEB_HOST) config.web.host = env.WEB_HOST
  if (env.WEB_PORT) config.web.port = Number(env.WEB_PORT)
  if (env.WEB_TOKEN) config.web.token = env.WEB_TOKEN

  for (const key of Object.keys(config.paths)) {
    config.paths[key] = path.resolve(ROOT, config.paths[key])
  }
  if (config.logs.file) config.logs.file = path.resolve(ROOT, config.logs.file)
  return config
}

module.exports = { loadConfig, deepMerge, ROOT }
