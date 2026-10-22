'use strict'

/**
 * Mini-langage d'expressions sûr (aucun accès à JavaScript) utilisé dans les
 * paramètres des nœuds : `health < 10 && hasItem('bread')`, `"Salut " + event.username`,
 * `{{ bot.x }}` dans un texte, etc.
 *
 * Opérateurs : + - * / % == != === !== < > <= >= && || ?? ! ?: and or not
 * Littéraux : nombres, 'chaînes', "chaînes", true, false, null, [listes]
 * Accès : objet.champ, liste[0] ; appels : fonctions autorisées et quelques
 * méthodes de chaînes/listes (toLowerCase, includes, split, join...).
 */

class ExpressionError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ExpressionError'
  }
}

const FORBIDDEN = new Set([
  '__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__'
])

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_$À-ɏ][\w$À-ɏ]*)|(===|!==|==|!=|<=|>=|&&|\|\||\?\?|[-+*/%<>!?:.,()[\]]))/y

const WORD_OPS = new Map([['and', '&&'], ['or', '||'], ['not', '!']])

function unescapeString (raw) {
  const body = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = body[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case 'u': out += String.fromCharCode(parseInt(body.substr(i + 1, 4), 16) || 0); i += 4; break
      case '"': case "'": case '\\': out += n; break
      // séquence inconnue : on garde l'antislash (pratique pour les regex : "\d+")
      default: out += '\\' + n
    }
  }
  return out
}

function tokenize (src) {
  const tokens = []
  let pos = 0
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos
    const m = TOKEN_RE.exec(src)
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break
      throw new ExpressionError(`Caractère inattendu "${src.slice(pos).trim()[0]}" (position ${pos + 1})`)
    }
    pos = TOKEN_RE.lastIndex
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) })
    else if (m[2] !== undefined) tokens.push({ type: 'str', value: unescapeString(m[2]) })
    else if (m[3] !== undefined) {
      if (WORD_OPS.has(m[3])) tokens.push({ type: 'op', value: WORD_OPS.get(m[3]) })
      else tokens.push({ type: 'id', value: m[3] })
    } else tokens.push({ type: 'op', value: m[4] })
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

const BINARY_BP = {
  '??': 2,
  '||': 3,
  '&&': 4,
  '==': 5, '!=': 5, '===': 5, '!==': 5,
  '<': 6, '>': 6, '<=': 6, '>=': 6,
  '+': 7, '-': 7,
  '*': 8, '/': 8, '%': 8
}

function parse (src) {
  const tokens = tokenize(String(src))
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]
  const expect = value => {
    const t = next()
    if (t.type !== 'op' || t.value !== value) throw new ExpressionError(`"${value}" attendu, trouvé "${t.value || 'fin'}"`)
  }
  const lbp = t => {
    if (t.type !== 'op') return 0
    if (t.value === '?') return 1
    if (t.value === '.' || t.value === '[' || t.value === '(') return 10
    return BINARY_BP[t.value] || 0
  }

  function nud (t) {
    switch (t.type) {
      case 'num':
      case 'str':
        return { t: 'lit', v: t.value }
      case 'id':
        if (t.value === 'true') return { t: 'lit', v: true }
        if (t.value === 'false') return { t: 'lit', v: false }
        if (t.value === 'null') return { t: 'lit', v: null }
        if (t.value === 'undefined') return { t: 'lit', v: undefined }
        return { t: 'id', name: t.value }
      case 'op':
        if (t.value === '(') {
          const e = expr(0)
          expect(')')
          return e
        }
        if (t.value === '[') {
          const items = []
          if (!(peek().type === 'op' && peek().value === ']')) {
            do items.push(expr(0))
            while (peek().type === 'op' && peek().value === ',' && next())
          }
          expect(']')
          return { t: 'arr', items }
        }
        if (t.value === '-' || t.value === '+' || t.value === '!') return { t: 'un', op: t.value, a: expr(9) }
    }
    throw new ExpressionError(`Expression incomplète près de "${t.value || 'fin'}"`)
  }

  function led (t, left) {
    const op = t.value
    if (op === '?') {
      const yes = expr(0)
      expect(':')
      return { t: 'cond', c: left, a: yes, b: expr(0) }
    }
    if (op === '.') {
      const name = next()
      if (name.type !== 'id') throw new ExpressionError('Nom de champ attendu après "."')
      return { t: 'mem', o: left, p: { t: 'lit', v: name.value } }
    }
    if (op === '[') {
      const p = expr(0)
      expect(']')
      return { t: 'mem', o: left, p }
    }
    if (op === '(') {
      const args = []
      if (!(peek().type === 'op' && peek().value === ')')) {
        do args.push(expr(0))
        while (peek().type === 'op' && peek().value === ',' && next())
      }
      expect(')')
      return { t: 'call', f: left, args }
    }
    return { t: 'bin', op, a: left, b: expr(BINARY_BP[op]) }
  }

  function expr (rbp) {
    let left = nud(next())
    while (rbp < lbp(peek())) left = led(next(), left)
    return left
  }

  if (peek().type === 'eof') return { t: 'lit', v: undefined }
  const ast = expr(0)
  if (peek().type !== 'eof') throw new ExpressionError(`Symbole inattendu "${peek().value}"`)
  return ast
}

const STRING_METHODS = new Set([
  'toLowerCase', 'toUpperCase', 'trim', 'includes', 'startsWith', 'endsWith', 'split', 'slice',
  'substring', 'indexOf', 'lastIndexOf', 'charAt', 'at', 'replace', 'replaceAll'
])
const ARRAY_METHODS = new Set(['includes', 'indexOf', 'join', 'slice', 'at'])
const NUMBER_METHODS = new Set(['toFixed'])

function getMember (obj, key) {
  if (obj === null || obj === undefined) return undefined
  if (typeof key !== 'number') key = String(key)
  if (FORBIDDEN.has(key)) throw new ExpressionError(`Accès interdit : ${key}`)
  if (typeof obj === 'string' || Array.isArray(obj)) {
    if (key === 'length') return obj.length
    if (typeof key === 'number' || /^\d+$/.test(key)) return obj[Number(key)]
    return undefined
  }
  if (typeof obj === 'object') {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined
    const v = obj[key]
    return typeof v === 'function' ? undefined : v
  }
  return undefined
}

function callMethod (obj, name, args) {
  if (typeof obj === 'string' && STRING_METHODS.has(name)) {
    if ((name === 'replace' || name === 'replaceAll') && typeof args[0] !== 'string') {
      throw new ExpressionError('replace() n\'accepte que du texte (utilisez la fonction replace(texte, regex, remplacement))')
    }
    return String.prototype[name].apply(obj, args.map(a => (typeof a === 'function' ? undefined : a)))
  }
  if (Array.isArray(obj) && ARRAY_METHODS.has(name)) return Array.prototype[name].apply(obj, args)
  if (typeof obj === 'number' && NUMBER_METHODS.has(name)) return Number(obj.toFixed(Math.min(10, Math.max(0, args[0] || 0))))
  throw new ExpressionError(`Méthode non autorisée : ${name}()`)
}

function evaluateAst (node, scope) {
  switch (node.t) {
    case 'lit':
      return node.v
    case 'arr':
      return node.items.map(n => evaluateAst(n, scope))
    case 'id':
      return scope.get(node.name)
    case 'un': {
      const v = evaluateAst(node.a, scope)
      if (node.op === '!') return !v
      if (node.op === '-') return -v
      return +v
    }
    case 'cond':
      return evaluateAst(node.c, scope) ? evaluateAst(node.a, scope) : evaluateAst(node.b, scope)
    case 'mem':
      return getMember(evaluateAst(node.o, scope), evaluateAst(node.p, scope))
    case 'call': {
      const args = node.args.map(a => evaluateAst(a, scope))
      if (node.f.t === 'id') {
        const fn = scope.fn(node.f.name)
        if (typeof fn !== 'function') throw new ExpressionError(`Fonction inconnue : ${node.f.name}()`)
        return fn(...args)
      }
      if (node.f.t === 'mem') {
        const obj = evaluateAst(node.f.o, scope)
        const name = evaluateAst(node.f.p, scope)
        return callMethod(obj, String(name), args)
      }
      throw new ExpressionError('Appel invalide')
    }
    case 'bin': {
      const op = node.op
      if (op === '&&') return evaluateAst(node.a, scope) && evaluateAst(node.b, scope)
      if (op === '||') return evaluateAst(node.a, scope) || evaluateAst(node.b, scope)
      if (op === '??') return evaluateAst(node.a, scope) ?? evaluateAst(node.b, scope)
      const a = evaluateAst(node.a, scope)
      const b = evaluateAst(node.b, scope)
      switch (op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return a / b
        case '%': return a % b
        // eslint-disable-next-line eqeqeq
        case '==': return a == b
        // eslint-disable-next-line eqeqeq
        case '!=': return a != b
        case '===': return a === b
        case '!==': return a !== b
        case '<': return a < b
        case '>': return a > b
        case '<=': return a <= b
        case '>=': return a >= b
      }
    }
  }
  throw new ExpressionError(`Nœud d'expression inconnu : ${node.t}`)
}

const cache = new Map()

function compile (src) {
  const key = String(src)
  let ast = cache.get(key)
  if (!ast) {
    ast = parse(key)
    if (cache.size > 2000) cache.clear()
    cache.set(key, ast)
  }
  return ast
}

function toText (v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch (err) {
      return String(v)
    }
  }
  return String(v)
}

function toRegex (pattern, flags) {
  const s = String(pattern)
  const f = String(flags ?? 'i').replace(/[^gimsuy]/g, '')
  try {
    return new RegExp(s, f)
  } catch (err) {
    throw new ExpressionError(`Regex invalide : ${s}`)
  }
}

/** Fonctions pures disponibles dans toutes les expressions. */
const BUILTINS = {
  random: () => Math.random(),
  randInt: (min, max) => Math.floor(Math.random() * (Math.floor(max) - Math.ceil(min) + 1)) + Math.ceil(min),
  pick: list => (Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : undefined),
  round: (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
  min: (...a) => Math.min(...a.flat()),
  max: (...a) => Math.max(...a.flat()),
  sqrt: Math.sqrt,
  pow: Math.pow,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  len: v => {
    if (v === null || v === undefined) return 0
    if (Array.isArray(v) || typeof v === 'string') return v.length
    if (typeof v === 'object') return Object.keys(v).length
    return String(v).length
  },
  str: v => toText(v),
  num: v => Number(v),
  int: v => parseInt(v, 10),
  bool: v => !!v,
  lower: v => String(v ?? '').toLowerCase(),
  upper: v => String(v ?? '').toUpperCase(),
  trim: v => String(v ?? '').trim(),
  contains: (s, sub) => (Array.isArray(s) ? s.includes(sub) : String(s ?? '').toLowerCase().includes(String(sub ?? '').toLowerCase())),
  startsWith: (s, p) => String(s ?? '').startsWith(String(p)),
  endsWith: (s, p) => String(s ?? '').endsWith(String(p)),
  matches: (s, pattern, flags) => toRegex(pattern, flags).test(String(s ?? '')),
  match: (s, pattern, flags) => {
    const m = String(s ?? '').match(toRegex(pattern, flags))
    return m ? [...m] : null
  },
  replace: (s, pattern, replacement, flags = 'gi') => String(s ?? '').replace(toRegex(pattern, flags), String(replacement ?? '')),
  split: (s, sep = ',') => String(s ?? '').split(String(sep)),
  join: (list, sep = ', ') => (Array.isArray(list) ? list.map(toText).join(String(sep)) : toText(list)),
  keys: obj => (obj && typeof obj === 'object' ? Object.keys(obj) : []),
  json: v => toText(v),
  parseJson: s => {
    try {
      return JSON.parse(String(s))
    } catch (err) {
      return null
    }
  },
  now: () => Date.now(),
  time: () => new Date().toLocaleTimeString('fr-FR'),
  date: () => new Date().toLocaleDateString('fr-FR'),
  typeOf: v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v),
  dist: (x1, y1, z1, x2, y2, z2) => Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2)
}

/**
 * Crée une portée d'évaluation.
 * - layers : objets consultés dans l'ordre pour résoudre un identifiant
 * - constants : valeurs ou fonctions paresseuses (getter sans argument) comme `bot`
 * - functions : fonctions supplémentaires (liées au bot)
 */
function createScope ({ layers = [], constants = {}, functions = {} } = {}) {
  return {
    get (name) {
      if (FORBIDDEN.has(name)) throw new ExpressionError(`Accès interdit : ${name}`)
      for (const layer of layers) {
        if (layer && Object.prototype.hasOwnProperty.call(layer, name)) return layer[name]
      }
      if (Object.prototype.hasOwnProperty.call(constants, name)) {
        const c = constants[name]
        return typeof c === 'function' ? c() : c
      }
      if (name === 'PI') return Math.PI
      return undefined
    },
    fn (name) {
      if (Object.prototype.hasOwnProperty.call(functions, name)) return functions[name]
      if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) return BUILTINS[name]
      return undefined
    }
  }
}

function evaluate (src, scope = createScope()) {
  if (typeof src === 'number' || typeof src === 'boolean' || src === null || src === undefined) return src
  return evaluateAst(compile(src), scope)
}

/** Remplace les {{ expressions }} dans un texte. Un texte réduit à une seule expression renvoie sa valeur brute. */
function interpolate (text, scope = createScope()) {
  if (typeof text !== 'string' || !text.includes('{{')) return text
  const whole = text.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/)
  if (whole) return evaluate(whole[1], scope)
  return text.replace(/\{\{([\s\S]+?)\}\}/g, (all, e) => toText(evaluate(e, scope)))
}

/** Paramètre numérique/booléen : "{{ ... }}" est interpolé, sinon le texte est une expression. */
function interpolateOrEval (value, scope = createScope()) {
  if (typeof value !== 'string') return value
  return value.includes('{{') ? interpolate(value, scope) : evaluate(value, scope)
}

/** Vérifie la syntaxe sans évaluer ; renvoie null ou un message d'erreur. */
function check (src) {
  try {
    if (typeof src === 'string' && src.includes('{{')) {
      for (const m of src.matchAll(/\{\{([\s\S]+?)\}\}/g)) parse(m[1])
    } else {
      parse(src)
    }
    return null
  } catch (err) {
    return err.message
  }
}

module.exports = {
  ExpressionError,
  parse,
  compile,
  evaluate,
  interpolate,
  interpolateOrEval,
  createScope,
  check,
  toText,
  BUILTINS,
  FUNCTION_NAMES: Object.keys(BUILTINS)
}
