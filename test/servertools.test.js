'use strict'

const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { WebSocketServer } = require('ws')
const { RconClient } = require('../src/core/rcon')
const { ManagementClient } = require('../src/core/management')

/** Faux serveur RCON : mot de passe « secret », réponses longues en plusieurs paquets. */
function fakeRcon () {
  const server = net.createServer(socket => {
    let buf = Buffer.alloc(0)
    const send = (id, type, body) => {
      const payload = Buffer.from(body, 'utf8')
      const p = Buffer.alloc(14 + payload.length)
      p.writeInt32LE(10 + payload.length, 0)
      p.writeInt32LE(id, 4)
      p.writeInt32LE(type, 8)
      payload.copy(p, 12)
      socket.write(p)
    }
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0)
        const id = buf.readInt32LE(4)
        const type = buf.readInt32LE(8)
        const body = buf.toString('utf8', 12, 4 + len - 2)
        buf = buf.subarray(4 + len)
        if (type === 3) send(body === 'secret' ? id : -1, 2, '')
        else if (type === 2 && body === 'long') {
          send(id, 0, 'a'.repeat(4096))
          send(id, 0, 'b'.repeat(10))
        } else if (type === 2) send(id, 0, `ok:${body}`)
        else send(id, 0, `Unknown request ${type.toString(16)}`)
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('RCON : authentification, commandes et réponses découpées', async () => {
  const server = await fakeRcon()
  const port = server.address().port
  const bad = new RconClient({ host: '127.0.0.1', port, password: 'faux' })
  await assert.rejects(bad.command('list'), /mot de passe refusé/)
  const c = new RconClient({ host: '127.0.0.1', port, password: 'secret' })
  assert.strictEqual(await c.command('/list'), 'ok:list')
  const [a, b] = await Promise.all([c.command('time query daytime'), c.command('difficulty')])
  assert.deepStrictEqual([a, b], ['ok:time query daytime', 'ok:difficulty'])
  const long = await c.command('long')
  assert.strictEqual(long.length, 4106)
  c.close()
  server.close()
})

test('RCON : serveur absent', async () => {
  const c = new RconClient({ host: '127.0.0.1', port: 1, password: 'x', timeout: 2000 })
  await assert.rejects(c.command('list'), /RCON/)
})

test('protocole de gestion : secret, état, notifications et appels', async () => {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => done(info.req.headers.authorization === 'Bearer s3cret', 401)
  })
  await new Promise(resolve => wss.on('listening', resolve))
  const port = wss.address().port
  let socket = null
  wss.on('connection', ws => {
    socket = ws
    ws.on('message', raw => {
      const msg = JSON.parse(raw)
      const reply = result => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'minecraft:server/status') reply({ started: true, version: { name: '1.21.11', protocol: 774 }, players: [{ name: 'Steve', id: 'x' }] })
      else if (msg.method === 'minecraft:serversettings/view_distance/set') reply(msg.params[0])
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }))
    })
  })

  const refused = new ManagementClient({ host: '127.0.0.1', port, secret: 'faux' })
  const refusedState = new Promise(resolve => refused.on('state', s => { if (s.error) resolve(s) }))
  refused.start()
  assert.match((await refusedState).error, /secret refusé/)
  refused.stop()

  const client = new ManagementClient({ host: '127.0.0.1', port, secret: 's3cret' })
  const ready = new Promise(resolve => client.on('state', s => { if (s.connected && s.version) resolve(s) }))
  client.start()
  const state = await ready
  assert.deepStrictEqual(state.players, ['Steve'])
  assert.strictEqual(state.version.name, '1.21.11')

  assert.strictEqual(await client.call('serversettings/view_distance/set', [6]), 6)
  await assert.rejects(client.call('inconnue'), /Method not found/)

  const joined = new Promise(resolve => client.on('notification', n => { if (n.kind === 'players/joined') resolve(n) }))
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/players/joined', params: [{ name: 'Alex', id: 'y' }] }))
  const n = await joined
  assert.strictEqual(n.player, 'Alex')
  assert.deepStrictEqual(client.snapshot().players, ['Alex', 'Steve'])
  assert.strictEqual(client.snapshot().joinsPerMinute, 1)

  const saved = new Promise(resolve => client.on('notification', x => { if (x.kind === 'server/saved') resolve() }))
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/saving' }))
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/saved' }))
  await saved
  assert.strictEqual(client.snapshot().saving, false)
  assert.ok(client.snapshot().lastSave)

  client.stop()
  wss.close()
})
