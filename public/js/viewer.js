/*
 * Vue 3D de ce que voit un bot : rendu « voxel » des blocs autour de lui
 * (couleurs par matière, ombrage par face comme dans Minecraft), entités,
 * caméra dans les yeux du bot ou en orbite libre.
 * Aucune texture du jeu n'est utilisée : tout est calculé à partir des noms.
 */
import * as THREE from '../vendor/three/three.module.js'

THREE.ColorManagement.enabled = false

// --- Couleurs des matières ------------------------------------------------------

/* eslint-disable object-property-newline -- tables de couleurs compactes */
const DYES = {
  white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9', yellow: '#f8c627',
  lime: '#70b919', pink: '#ed8dac', gray: '#3e4447', light_gray: '#8e8e86', cyan: '#158991',
  purple: '#792aac', blue: '#35399d', brown: '#724728', green: '#546d1b', red: '#a12722', black: '#141519'
}
const WOODS = {
  oak: ['#a2834f', '#6b5133'], spruce: ['#725430', '#3b2712'], birch: ['#c0af79', '#d7d3c8'],
  jungle: ['#a07351', '#574119'], acacia: ['#a85a32', '#676157'], dark_oak: ['#432b14', '#3c2e1a'],
  mangrove: ['#763631', '#54382c'], cherry: ['#e2b2ac', '#37201f'], pale_oak: ['#e3d9d4', '#b9b0ad'],
  crimson: ['#653147', '#5c1d1e'], warped: ['#2b6963', '#3a3a4d'], bamboo: ['#c2ad50', '#8a9a2b']
}
const ORES = {
  coal: '#2f2f2f', iron: '#d8af93', gold: '#fcee4b', diamond: '#4aedd9', emerald: '#17dd62',
  redstone: '#ff2020', lapis: '#1d47a6', copper: '#e0815e', quartz: '#ebe5de'
}
/* eslint-enable object-property-newline */
const RULES = [
  [/^water$|bubble_column/, { liquid: true, top: '#3f76e4', alpha: 0.55 }],
  [/^lava$/, { liquid: true, top: '#e2571b', alpha: 0.95 }],
  [/^grass_block$|^grass$/, { top: '#7cbd6b', side: '#866043' }],
  [/mycelium/, { top: '#6f6265', side: '#866043' }],
  [/podzol/, { top: '#5a3d17', side: '#866043' }],
  [/farmland/, { top: '#563718', side: '#866043' }],
  [/dirt_path|grass_path/, { top: '#94793f', side: '#866043' }],
  [/dirt|mud$|rooted/, { top: '#866043' }],
  [/red_sand/, { top: '#be6621' }],
  [/sandstone|^sand$|suspicious_sand/, { top: '#dbcfa3' }],
  [/gravel/, { top: '#857f7c' }],
  [/clay$/, { top: '#a0a6b3' }],
  [/snow|powder_snow/, { top: '#f9fefe' }],
  [/packed_ice|blue_ice/, { top: '#8eb4fa' }],
  [/^ice$|frosted_ice/, { top: '#91b7fd', alpha: 0.7 }],
  [/glass_pane|glass$/, { top: '#c0f0ff', alpha: 0.28, glass: true }],
  [/leaves/, { top: '#3a7a26' }],
  [/deepslate.*ore|ore$/, null],
  [/deepslate|tuff|sculk/, { top: '#4d4d50' }],
  [/cobblestone|cobbled/, { top: '#7a7a7a' }],
  [/stone_brick|stone_bricks/, { top: '#7a797a' }],
  [/granite/, { top: '#9a6c58' }],
  [/diorite/, { top: '#bcbcbc' }],
  [/andesite/, { top: '#888888' }],
  [/bedrock/, { top: '#565656' }],
  [/blackstone|basalt/, { top: '#2f2a30' }],
  [/netherrack|nether_wart_block/, { top: '#6e3534' }],
  [/nether_brick/, { top: '#2c1519' }],
  [/soul_sand|soul_soil/, { top: '#513e32' }],
  [/end_stone/, { top: '#dbde9e' }],
  [/obsidian/, { top: '#15111f' }],
  [/prismarine/, { top: '#63a196' }],
  [/purpur/, { top: '#a77ba7' }],
  [/terracotta$/, { top: '#985e43' }],
  [/bricks$/, { top: '#966455' }],
  [/iron_block|iron_bars/, { top: '#dcdcdc' }],
  [/gold_block/, { top: '#f9d849' }],
  [/diamond_block/, { top: '#61dbd5' }],
  [/emerald_block/, { top: '#2ad06b' }],
  [/redstone_block/, { top: '#af1806' }],
  [/lapis_block/, { top: '#1f4398' }],
  [/coal_block/, { top: '#101010' }],
  [/copper/, { top: '#c06b4f' }],
  [/quartz/, { top: '#ebe5de' }],
  [/tnt/, { top: '#db441a', side: '#b8371a' }],
  [/glowstone|shroomlight|lantern|froglight/, { top: '#e6c27a' }],
  [/pumpkin|jack_o_lantern/, { top: '#c07615' }],
  [/melon/, { top: '#6f9221' }],
  [/hay_block/, { top: '#a68b0c' }],
  [/bookshelf/, { top: '#a2834f', side: '#6b5133' }],
  [/crafting_table|chest|barrel|lectern|composter/, { top: '#9b7a4a', side: '#7a5a32' }],
  [/furnace|smoker|dispenser|dropper|observer|piston/, { top: '#6f6f6f', side: '#5b5b5b' }],
  [/cactus/, { top: '#5a8a2a' }],
  [/sponge/, { top: '#c3c04a' }],
  [/stone|smooth/, { top: '#7d7d7d' }]
]

function shade (hex, f) {
  const c = new THREE.Color(hex)
  return [Math.min(1, c.r * f), Math.min(1, c.g * f), Math.min(1, c.b * f)]
}

function hashColor (name) {
  let x = 2166136261
  for (const ch of name) {
    x ^= ch.charCodeAt(0)
    x = Math.imul(x, 16777619)
  }
  const v = 0.35 + ((x >>> 0) % 1000) / 2500
  const c = new THREE.Color().setHSL(((x >>> 8) % 360) / 360, 0.18, v)
  return `#${c.getHexString()}`
}

/** Apparence d'une entrée de palette : rendu (solid, liquid, glass, plant, none) et couleurs. */
function appearance (entry) {
  const name = entry.name
  for (const [kind, base] of [['wool', DYES], ['concrete_powder', DYES], ['concrete', DYES], ['terracotta', DYES], ['carpet', DYES], ['stained_glass', DYES]]) {
    const m = name.match(new RegExp(`^(${Object.keys(base).join('|')})_${kind}`))
    if (m) {
      const color = base[m[1]]
      if (kind === 'stained_glass') return { render: 'glass', top: color, side: color, alpha: 0.45 }
      if (kind === 'terracotta') return { render: 'solid', top: shadeHex(color, 0.75), side: shadeHex(color, 0.75) }
      return { render: entry.solid || kind === 'carpet' ? 'solid' : 'plant', top: color, side: color }
    }
  }
  const wood = name.match(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped|bamboo)_(planks|log|wood|stem|hyphae|slab|stairs|fence|fence_gate|door|trapdoor|leaves)/)
  if (wood) {
    const [planks, bark] = WOODS[wood[1]]
    if (wood[2] === 'leaves') {
      const leaf = wood[1] === 'cherry' ? '#e9b8cc' : wood[1] === 'birch' ? '#5f8a3a' : wood[1] === 'spruce' ? '#3b5e3b' : '#3a7a26'
      return { render: 'solid', top: leaf, side: leaf }
    }
    if (/log|wood|stem|hyphae/.test(wood[2])) return { render: 'solid', top: planks, side: bark }
    return { render: entry.solid ? 'solid' : 'plant', top: planks, side: planks }
  }
  const ore = name.match(/(coal|iron|gold|diamond|emerald|redstone|lapis|copper|quartz)_ore/)
  if (ore) {
    const base = name.includes('deepslate') ? '#4d4d50' : name.includes('nether') ? '#6e3534' : '#7d7d7d'
    return { render: 'solid', top: base, side: base, speck: ORES[ore[1]] }
  }
  for (const [re, look] of RULES) {
    if (!look || !re.test(name)) continue
    if (look.liquid) return { render: 'liquid', top: look.top, side: look.top, alpha: look.alpha }
    if (look.glass || look.alpha) return { render: 'glass', top: look.top, side: look.side || look.top, alpha: look.alpha }
    return { render: entry.solid ? 'solid' : 'plant', top: look.top, side: look.side || look.top }
  }
  if (/flower|tulip|poppy|dandelion|orchid|allium|azure|daisy|lily|rose|peony|lilac|sunflower|cornflower/.test(name)) {
    return { render: 'plant', top: '#d84a4a', side: '#3f8a2a' }
  }
  if (/short_grass|tall_grass|^grass$|fern|bush|sapling|wheat|carrots|potatoes|beetroots|sugar_cane|kelp|seagrass|vine|crop/.test(name)) {
    return { render: 'plant', top: '#5f9e3a', side: '#5f9e3a' }
  }
  if (/torch|redstone_wire|rail|button|lever|pressure_plate|sign|banner|head|skull|pot|candle|item_frame/.test(name)) {
    return { render: 'plant', top: '#d9b44a', side: '#8a6a3a', small: true }
  }
  const color = hashColor(name)
  return { render: entry.solid ? 'solid' : 'plant', top: color, side: color, small: !entry.solid }
}

function withDefaults (look) {
  if (look.render !== 'none') {
    look.top = look.top || '#808080'
    look.side = look.side || look.top
  }
  return look
}

function shadeHex (hex, f) {
  const [r, g, b] = shade(hex, f)
  return `#${new THREE.Color(r, g, b).getHexString()}`
}

// --- Maillage -------------------------------------------------------------------------

const FACES = [
  { n: [0, 1, 0], light: 1.0, top: true, c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], light: 0.5, c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], light: 0.8, c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], light: 0.8, c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  { n: [1, 0, 0], light: 0.66, c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], light: 0.66, c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }
]

function decode (blocks) {
  const bin = atob(blocks.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return blocks.bytes === 2 ? new Uint16Array(bytes.buffer) : bytes
}

function noise (x, y, z) {
  let n = (x * 374761393 + y * 668265263 + z * 2147483647) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

function buildMeshes (blocks) {
  const data = decode(blocks)
  const { size, palette } = blocks
  const looks = palette.map((p, i) => (i === 0 ? { render: 'none' } : withDefaults(appearance(p))))
  const sx = size.x
  const sz = size.z
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= size.y || z >= sz ? 0 : data[(y * sz + z) * sx + x])
  const isOpaque = idx => idx !== 0 && looks[idx].render === 'solid'
  const buffers = { solid: { p: [], c: [] }, clear: { p: [], c: [] }, plant: { p: [], c: [] } }

  const pushQuad = (buf, corners, color) => {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      buf.p.push(corners[k][0], corners[k][1], corners[k][2])
      buf.c.push(color[0], color[1], color[2])
    }
  }

  let i = 0
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++, i++) {
        const idx = data[i]
        if (!idx) continue
        const look = looks[idx]
        if (look.render === 'none') continue
        const jitter = 0.94 + noise(x, y, z) * 0.12
        if (look.render === 'plant') {
          const s = look.small ? 0.3 : 0.45
          const hgt = look.small ? 0.6 : 0.85
          const col = shade(look.side, jitter)
          const cx = x + 0.5
          const cz = z + 0.5
          pushQuad(buffers.plant, [[cx - s, y, cz - s], [cx + s, y, cz + s], [cx + s, y + hgt, cz + s], [cx - s, y + hgt, cz - s]], col)
          pushQuad(buffers.plant, [[cx - s, y, cz + s], [cx + s, y, cz - s], [cx + s, y + hgt, cz - s], [cx - s, y + hgt, cz + s]], shade(look.top, jitter))
          continue
        }
        const buf = look.render === 'solid' ? buffers.solid : buffers.clear
        const liquidTop = look.render === 'liquid' && at(x, y + 1, z) !== idx ? 0.875 : 1
        for (const f of FACES) {
          const n = at(x + f.n[0], y + f.n[1], z + f.n[2])
          if (look.render === 'solid' ? isOpaque(n) : (n === idx || isOpaque(n))) continue
          let base = f.top ? look.top : look.side
          if (look.speck && noise(x + f.n[0], y + 3 * f.n[1], z + f.n[2]) < 0.35) base = look.speck
          const color = shade(base, f.light * jitter)
          pushQuad(buf, f.c.map(([cx, cy, cz]) => [x + cx, y + (cy ? liquidTop : 0), z + cz]), color)
        }
      }
    }
  }

  const meshes = []
  const make = (buf, material) => {
    if (!buf.p.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.c, 3))
    meshes.push(new THREE.Mesh(geo, material))
  }
  make(buffers.solid, new THREE.MeshBasicMaterial({ vertexColors: true }))
  make(buffers.plant, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
  make(buffers.clear, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }))
  return meshes
}

// --- Entités ---------------------------------------------------------------------------

const KIND_COLORS = { player: '#3c44aa', hostile: '#4f7f2f', passive: '#d8a86a', object: '#ffd84a' }

function labelSprite (text, color = '#ffffff') {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const font = '28px Monocraft, monospace'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 16
  canvas.width = w
  canvas.height = 40
  ctx.font = font
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.fillRect(0, 0, w, 40)
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 8, 21)
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  sprite.scale.set(w / 80, 0.5, 1)
  sprite.renderOrder = 10
  return sprite
}

function faceTexture (url) {
  const tex = new THREE.TextureLoader().load(url)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

function humanoid (color, faceUrl) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.3), new THREE.MeshBasicMaterial({ color }))
  body.position.y = 0.75 + 0.375
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.3), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) }))
  legs.position.y = 0.375
  const side = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.8) })
  const front = faceUrl ? new THREE.MeshBasicMaterial({ map: faceTexture(faceUrl) }) : side
  // L'avant de la tête regarde vers -z (le « nord » du modèle) : face index 5.
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), [side, side, side, side, side, front])
  head.position.y = 1.5 + 0.25
  g.add(body, legs, head)
  return g
}

// --- Visionneuse ---------------------------------------------------------------------------

export class BotViewer {
  constructor (container, { botId, api, face, onInfo }) {
    this.container = container
    this.botId = botId
    this.api = api
    this.face = face
    this.onInfo = onInfo || (() => {})
    this.mode = 'eyes'
    this.radius = 20
    this.orbit = { yaw: Math.PI / 4, pitch: 0.5, dist: 9 }
    this.world = new THREE.Group()
    this.entities = new Map()
    this.pose = null
    this.camPose = null
    this.lastBlocks = 0
    this.lastOrigin = null
    this.stopped = false

    this.renderer = new THREE.WebGLRenderer({ antialias: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.scene = new THREE.Scene()
    this.scene.add(this.world)
    this.entityGroup = new THREE.Group()
    this.scene.add(this.entityGroup)
    this.self = humanoid('#3c44aa', face(botId))
    this.self.visible = false
    this.scene.add(this.self)
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400)
    this.camera.rotation.order = 'YXZ'
    container.appendChild(this.renderer.domElement)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.bindControls()
    this.loop = this.loop.bind(this)
    requestAnimationFrame(this.loop)
    this.poll()
  }

  setMode (mode) {
    this.mode = mode
    this.self.visible = mode === 'orbit'
  }

  setRadius (radius) {
    this.radius = radius
    this.lastBlocks = 0
  }

  bindControls () {
    const el = this.renderer.domElement
    let drag = null
    el.addEventListener('mousedown', ev => {
      drag = { x: ev.clientX, y: ev.clientY, yaw: this.orbit.yaw, pitch: this.orbit.pitch }
      // Glisser depuis la vue « yeux » bascule en orbite autour du bot.
      if (this.mode === 'eyes') {
        this.setMode('orbit')
        this.onInfo({ mode: 'orbit' })
      }
    })
    window.addEventListener('mousemove', this._move = ev => {
      if (!drag) return
      this.orbit.yaw = drag.yaw - (ev.clientX - drag.x) * 0.008
      this.orbit.pitch = Math.max(-1.2, Math.min(1.45, drag.pitch + (ev.clientY - drag.y) * 0.006))
    })
    window.addEventListener('mouseup', this._up = () => { drag = null })
    el.addEventListener('wheel', ev => {
      ev.preventDefault()
      if (this.mode === 'eyes') return
      this.orbit.dist = Math.max(2, Math.min(60, this.orbit.dist * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)))
    }, { passive: false })
  }

  resize () {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  async poll () {
    while (!this.stopped) {
      const started = performance.now()
      try {
        const needBlocks = !this.lastOrigin || performance.now() - this.lastBlocks > 5000 || (this.pose && this.movedFar())
        const view = await this.api(`/api/bots/${encodeURIComponent(this.botId)}/view?radius=${this.radius}&height=${Math.round(this.radius * 0.6)}&blocks=${needBlocks ? 1 : 0}`)
        if (this.stopped) return
        this.apply(view)
        if (view.blocks) this.lastBlocks = performance.now()
        this.onInfo({ ok: true, view })
      } catch (err) {
        this.onInfo({ ok: false, error: err.message })
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      const elapsed = performance.now() - started
      await new Promise(resolve => setTimeout(resolve, Math.max(60, 220 - elapsed)))
    }
  }

  movedFar () {
    const o = this.lastOrigin
    const p = this.pose
    return Math.abs(p.x - o.x) > this.radius / 3 || Math.abs(p.z - o.z) > this.radius / 3 || Math.abs(p.y - o.y) > 4
  }

  apply (view) {
    this.pose = view.pose
    if (!this.camPose) this.camPose = { ...view.pose }
    if (view.blocks) this.setWorld(view.blocks)
    this.setEntities(view.entities)
    this.setSky(view.pose)
  }

  setWorld (blocks) {
    for (const m of this.world.children) {
      m.geometry.dispose()
      m.material.dispose()
    }
    this.world.clear()
    for (const m of buildMeshes(blocks)) this.world.add(m)
    this.world.position.set(blocks.origin.x, blocks.origin.y, blocks.origin.z)
    this.lastOrigin = { x: this.pose.x, y: this.pose.y, z: this.pose.z }
    this.blockInfo = blocks.size
  }

  setEntities (list) {
    const seen = new Set()
    for (const e of list) {
      seen.add(e.id)
      let obj = this.entities.get(e.id)
      if (!obj) {
        if (e.kind === 'object') {
          obj = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshBasicMaterial({ color: KIND_COLORS.object }))
        } else {
          obj = humanoid(KIND_COLORS[e.kind] || '#999', e.managed ? this.face(e.name) : null)
          if (e.kind !== 'player') obj.scale.setScalar(Math.max(0.4, Math.min(2.2, e.height / 1.8)))
          if (e.kind === 'player' || e.kind === 'hostile') {
            const label = labelSprite(e.name, e.kind === 'hostile' ? '#ff7070' : '#ffffff')
            label.position.y = 2.25
            obj.add(label)
          }
        }
        this.entities.set(e.id, obj)
        this.entityGroup.add(obj)
      }
      obj.position.set(e.x, e.y, e.z)
      obj.rotation.y = e.yaw
    }
    for (const [id, obj] of this.entities) {
      if (seen.has(id)) continue
      this.entityGroup.remove(obj)
      obj.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) [].concat(o.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose() })
      })
      this.entities.delete(id)
    }
  }

  setSky (pose) {
    const t = pose.timeOfDay ?? 6000
    // jour 0–12000, coucher 12000–13800, nuit, lever 22200–24000
    let k = 1
    if (t > 12000 && t < 13800) k = 1 - (t - 12000) / 1800
    else if (t >= 13800 && t < 22200) k = 0
    else if (t >= 22200) k = (t - 22200) / 1800
    if (pose.dimension && pose.dimension.includes('nether')) this.sky = new THREE.Color('#330808')
    else if (pose.dimension && pose.dimension.includes('end')) this.sky = new THREE.Color('#15111f')
    else this.sky = new THREE.Color('#0b1026').lerp(new THREE.Color(pose.isRaining ? '#8394a8' : '#7fa8ff'), k)
    this.scene.background = this.sky
    this.scene.fog = new THREE.Fog(this.sky, this.radius * 0.7, this.radius * 1.35)
  }

  loop () {
    if (this.stopped) return
    requestAnimationFrame(this.loop)
    if (!this.pose || document.hidden) return
    // Interpolation douce entre deux mises à jour de position.
    const c = this.camPose
    const p = this.pose
    const k = 0.25
    c.x += (p.x - c.x) * k
    c.y += (p.y - c.y) * k
    c.z += (p.z - c.z) * k
    let dy = p.yaw - c.yaw
    while (dy > Math.PI) dy -= 2 * Math.PI
    while (dy < -Math.PI) dy += 2 * Math.PI
    c.yaw += dy * k
    c.pitch += (p.pitch - c.pitch) * k
    const eyeY = c.y + (p.eye || 1.62)
    this.self.position.set(c.x, c.y, c.z)
    this.self.rotation.y = c.yaw
    if (this.mode === 'eyes') {
      this.camera.position.set(c.x, eyeY, c.z)
      this.camera.rotation.set(c.pitch, c.yaw, 0)
    } else {
      const o = this.orbit
      this.camera.position.set(
        c.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist,
        eyeY + Math.sin(o.pitch) * o.dist,
        c.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist)
      this.camera.lookAt(c.x, eyeY - 0.4, c.z)
    }
    this.renderer.render(this.scene, this.camera)
  }

  stop () {
    this.stopped = true
    this.resizeObserver.disconnect()
    window.removeEventListener('mousemove', this._move)
    window.removeEventListener('mouseup', this._up)
    this.setEntities([])
    for (const m of this.world.children) {
      m.geometry.dispose()
      m.material.dispose()
    }
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
