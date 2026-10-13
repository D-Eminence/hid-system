// A small, dependency-free model of the parts of nginx the API gateway uses,
// so its configuration can be checked without an nginx binary or a container
// engine: the image entrypoint's envsubst step, the configuration grammar,
// location selection (exact, longest prefix, ^~, regular expressions and
// nested locations), the realip, geo and map modules, and the rewrite-phase
// `if`, `set` and `return` directives. It follows the nginx source
// (ngx_http_core_find_location, ngx_http_realip_module, ngx_http_proxy_eval)
// for those parts only; anything it does not model is reported as an error
// rather than guessed. It is a test model, not a substitute for running nginx.

import { BlockList, isIP } from 'node:net'

// The official image's 20-envsubst-on-templates.sh passes envsubst the list of
// variables that are defined in the environment, so only ${NAME} and $NAME
// references to defined variables are replaced; nginx's own $variables and
// references to undefined names are left as they are.
export function renderTemplate(template, environment) {
  return template.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, braced, bare) => {
      const name = braced ?? bare
      return Object.hasOwn(environment, name) ? String(environment[name]) : whole
    })
}

/** Every ${NAME} the template refers to (the image must define each one). */
export function templateVariables(template) {
  return [...new Set([...template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort()
}

function tokenize(text) {
  const tokens = []
  let index = 0
  let line = 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\n') { line += 1; index += 1; continue }
    if (/\s/.test(character)) { index += 1; continue }
    if (character === '#') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (character === '{' || character === '}' || character === ';') {
      tokens.push({ value: character, special: true, line })
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      let value = ''
      index += 1
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\' && index + 1 < text.length) {
          const next = text[index + 1]
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r'
            : next === character || next === '\\' ? next : `\\${next}`
          index += 2
          continue
        }
        if (text[index] === '\n') line += 1
        value += text[index]
        index += 1
      }
      if (index >= text.length) throw new Error(`unterminated quoted string on line ${line}`)
      index += 1
      tokens.push({ value, quoted: true, line })
      continue
    }
    let value = ''
    while (index < text.length && !/[\s;{}]/.test(text[index])) {
      // nginx accepts ${name} inside an unquoted token.
      if (text[index] === '$' && text[index + 1] === '{') {
        const end = text.indexOf('}', index)
        if (end < 0) throw new Error(`unterminated variable on line ${line}`)
        value += text.slice(index, end + 1)
        index = end + 1
        continue
      }
      value += text[index]
      index += 1
    }
    tokens.push({ value, line })
  }
  return tokens
}

/** Parses nginx configuration text into directives: { name, args, block?, line }. */
export function parseConfig(text) {
  const tokens = tokenize(text)
  let position = 0
  function parseBlock(closing) {
    const directives = []
    let current = null
    while (position < tokens.length) {
      const token = tokens[position++]
      if (token.special && token.value === '}') {
        if (current) throw new Error(`directive "${current.name}" on line ${current.line} has no terminating ";"`)
        if (!closing) throw new Error(`unexpected "}" on line ${token.line}`)
        return directives
      }
      if (token.special && token.value === ';') {
        if (!current) throw new Error(`unexpected ";" on line ${token.line}`)
        directives.push(current)
        current = null
        continue
      }
      if (token.special && token.value === '{') {
        if (!current) throw new Error(`unexpected "{" on line ${token.line}`)
        current.block = parseBlock(true)
        directives.push(current)
        current = null
        continue
      }
      if (!current) current = { name: token.value, args: [], line: token.line }
      else current.args.push(token.value)
    }
    if (current) throw new Error(`directive "${current.name}" on line ${current.line} is not terminated`)
    if (closing) throw new Error('unexpected end of configuration: a block is not closed')
    return directives
  }
  return parseBlock(false)
}

/** Replaces `include <path>;` with the parsed directives of that file. */
export function expandIncludes(directives, files) {
  return directives.flatMap((directive) => {
    if (directive.name === 'include') {
      const [path] = directive.args
      if (!Object.hasOwn(files, path)) throw new Error(`include of unknown file ${path}`)
      return expandIncludes(parseConfig(files[path]), files)
    }
    return [{ ...directive, ...(directive.block ? { block: expandIncludes(directive.block, files) } : {}) }]
  })
}

function location(directive) {
  const [first, second] = directive.args
  if (directive.args.length === 2) {
    if (!['=', '^~', '~', '~*'].includes(first)) throw new Error(`unsupported location modifier ${first}`)
    return { modifier: first, path: second, directive }
  }
  if (directive.args.length !== 1) throw new Error(`unsupported location on line ${directive.line}`)
  if (first.startsWith('@')) return { modifier: '@', path: first, directive }
  return { modifier: '', path: first, directive }
}

function locationsOf(block) {
  return (block ?? []).filter(item => item.name === 'location').map(location)
}

// ngx_http_core_find_location: an exact match ends the search; otherwise the
// longest prefix is remembered and its nested locations are searched; then,
// unless that prefix is ^~ (noregex), the regular expressions of this level are
// tried in order, and the first match (with its own nested search) replaces
// whatever this level had selected.
function findLocation(block, uri) {
  const candidates = locationsOf(block)
  const exact = candidates.find(item => item.modifier === '=' && item.path === uri)
  if (exact) return { result: 'OK', chain: [exact] }
  let best = null
  for (const item of candidates) {
    if ((item.modifier === '' || item.modifier === '^~') && uri.startsWith(item.path)
        && (!best || item.path.length > best.path.length)) best = item
  }
  let result = 'DECLINED'
  let chain = []
  if (best) {
    const nested = findLocation(best.directive.block, uri)
    chain = [best, ...nested.chain]
    if (nested.result === 'OK') return { result: 'OK', chain }
    result = 'AGAIN'
  }
  if (!best || best.modifier !== '^~') {
    for (const item of candidates.filter(entry => entry.modifier === '~' || entry.modifier === '~*')) {
      if (new RegExp(item.path, item.modifier === '~*' ? 'i' : '').test(uri)) {
        return { result: 'OK', chain: [item, ...findLocation(item.directive.block, uri).chain] }
      }
    }
  }
  return { result, chain }
}

/** The location chain (outermost first) nginx selects for a normalized URI. */
export function selectLocation(serverBlock, uri) {
  return findLocation(serverBlock, uri).chain
}

// nginx decodes %XX, merges slashes (merge_slashes on) and resolves "." and
// ".." segments before it selects a location; the proxied request keeps the
// client's unparsed URI when proxy_pass names no URI part. Its URI ends at the
// first "?" (the arguments) or, before that, at a "#" (ngx_http_parse_complex_uri);
// a backslash is an ordinary character outside Windows.
export function normalizeUri(raw) {
  const path = raw.split(/[?#]/, 1)[0]
  const decoded = path.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  const output = []
  for (const segment of decoded.split('/').slice(1)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (output.length === 0) throw Object.assign(new Error('URI escapes the root'), { status: 400 })
      output.pop()
      continue
    }
    output.push(segment)
  }
  const trailing = /\/\.?\.?$/.test(decoded) && output.length > 0 ? '/' : ''
  return `/${output.join('/')}${trailing}`
}

function addressMatches(list, address) {
  const family = isIP(address)
  if (family === 0) return false
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

function cidrList(values) {
  const list = new BlockList()
  for (const value of values) {
    const [address, prefix] = value.split('/')
    const family = isIP(address)
    if (family === 0) throw new Error(`not an address or CIDR: ${value}`)
    const type = family === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(address, type)
    else list.addSubnet(address, Number(prefix), type)
  }
  return list
}

/**
 * The gateway configuration as nginx would load it: the rendered server
 * template (http-level geo/map plus one server block) and its include files.
 */
export class GatewayModel {
  constructor(rendered, includeFiles = {}) {
    const top = expandIncludes(parseConfig(rendered), includeFiles)
    const servers = top.filter(item => item.name === 'server')
    if (servers.length !== 1) throw new Error(`expected one server block, found ${servers.length}`)
    this.top = top
    this.server = servers[0].block
    this.maps = new Map()
    for (const item of top.filter(entry => entry.name === 'map')) {
      const [source, variable] = item.args
      this.maps.set(variable, { source, entries: item.block })
    }
    this.geos = new Map()
    for (const item of top.filter(entry => entry.name === 'geo')) {
      if (item.args.length !== 1) throw new Error('only the single-argument geo form is modelled')
      this.geos.set(item.args[0], item.block)
    }
    // log_format name [escape=default|json|none] string ...: nginx joins the
    // strings into one format.
    this.logFormats = new Map()
    for (const item of top.filter(entry => entry.name === 'log_format')) {
      const [name, ...rest] = item.args
      const escape = rest[0]?.startsWith('escape=') ? rest.shift().slice('escape='.length) : 'default'
      if (this.logFormats.has(name)) throw new Error(`duplicate log_format ${name}`)
      this.logFormats.set(name, { escape, format: rest.join('') })
    }
    for (const item of top) {
      if (!['server', 'map', 'geo', 'log_format'].includes(item.name)) throw new Error(`unmodelled http-level directive ${item.name}`)
    }
    this.realIpFrom = cidrList(this.server.filter(item => item.name === 'set_real_ip_from').map(item => item.args[0]))
    this.realIpHeader = this.server.find(item => item.name === 'real_ip_header')?.args[0]
  }

  directives(name, block = this.server) {
    return block.filter(item => item.name === name)
  }

  /**
   * Routes one request. `peer` is the connecting address (the public ALB node
   * in AWS), `headers` the request headers, `uri` the raw request target.
   */
  route({ method = 'GET', uri, peer = '10.40.1.10', headers = {} }) {
    const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]))
    const variables = new Map()
    let remoteAddress = peer
    // realip: the header is used only when the connection comes from a trusted
    // address, and only when it parses as an address (the last one of a list).
    if (this.realIpHeader && addressMatches(this.realIpFrom, peer)) {
      const value = lowered[this.realIpHeader.toLowerCase()]
      const candidate = value?.split(',').at(-1)?.trim()
      if (candidate && isIP(candidate) !== 0) remoteAddress = candidate
    }
    let normalized
    try {
      normalized = normalizeUri(uri)
    } catch (error) {
      if (error.status === 400) return { action: 'return', status: 400, location: null }
      throw error
    }
    const builtins = {
      remote_addr: remoteAddress, realip_remote_addr: peer, uri: normalized, request_uri: uri,
      request_method: method, host: lowered.host ?? 'api.healthidentitydirectory.com', scheme: 'http',
    }
    const value = (name) => {
      if (variables.has(name)) return variables.get(name)
      if (Object.hasOwn(builtins, name)) return builtins[name]
      if (name.startsWith('http_')) return lowered[name.slice(5).replaceAll('_', '-')] ?? ''
      if (this.maps.has(`$${name}`)) {
        const result = this.evaluateMap(this.maps.get(`$${name}`), value)
        variables.set(name, result)
        return result
      }
      if (this.geos.has(`$${name}`)) {
        const result = this.evaluateGeo(this.geos.get(`$${name}`), remoteAddress)
        variables.set(name, result)
        return result
      }
      throw new Error(`unknown variable $${name}`)
    }
    const expand = (text) => text.replace(/\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/g,
      (_whole, braced, bare) => value(braced ?? bare))

    const serverOutcome = this.runRewrite(this.server, expand, variables, value)
    if (serverOutcome) return { ...serverOutcome, location: null, remoteAddress }

    const chain = selectLocation(this.server, normalized)
    if (chain.length === 0) return { action: 'none', location: null, remoteAddress }
    const selected = chain.at(-1)
    const outcome = this.runRewrite(selected.directive.block, expand, variables, value)
    const scopes = [...chain].reverse().map(item => item.directive.block)
    // Directives that a location inherits from its enclosing levels unless it
    // sets its own: where the request is logged, whether upstream error
    // statuses are replaced by error_page (nginx's default is off), and the
    // largest request body nginx accepts (its default is 1m).
    const inheritedSettings = {
      accessLog: this.inheritedAll('access_log', scopes).map(item => item.args),
      interceptErrors: (this.inherited('proxy_intercept_errors', scopes)?.[0] ?? 'off') === 'on',
      clientMaxBodySize: this.inherited('client_max_body_size', scopes)?.[0] ?? '1m',
    }
    if (outcome) {
      return {
        ...outcome,
        location: selected.path,
        contentType: this.inherited('default_type', scopes)?.[0],
        addHeaders: outcome.addHeaders ?? this.addHeaders(scopes),
        ...inheritedSettings,
        remoteAddress,
      }
    }
    const proxyPass = this.directives('proxy_pass', selected.directive.block)[0]
    if (!proxyPass) throw new Error(`location ${selected.path} neither returns nor proxies`)
    const target = expand(proxyPass.args[0])
    const upstream = new URL(target)
    if (upstream.pathname !== '/' || target.replace(/\/$/, '') !== `${upstream.protocol}//${upstream.host}`) {
      throw new Error(`proxy_pass in ${selected.path} has a URI part (${target}); the client URI would be rewritten`)
    }
    const upstreamHeaders = {}
    for (const item of this.inheritedAll('proxy_set_header', scopes)) {
      upstreamHeaders[item.args[0].toLowerCase()] = expand(item.args[1])
    }
    return {
      action: 'proxy',
      location: selected.path,
      proxyPassArgument: proxyPass.args[0],
      upstream: `${upstream.protocol}//${upstream.host}`,
      // ngx_http_proxy_create_request: with a variable proxy_pass and no URI
      // part, the unparsed client URI is sent unchanged.
      upstreamUri: uri,
      upstreamHeaders,
      ...inheritedSettings,
      remoteAddress,
    }
  }

  /** The server-level error_page mappings, as { status: target }. */
  errorPages() {
    const pages = {}
    for (const item of this.directives('error_page')) {
      const target = item.args.at(-1)
      const codes = item.args.slice(0, -1).filter(argument => /^\d{3}$/.test(argument))
      for (const code of codes) pages[code] = { target, replaceStatus: item.args.includes('=') }
    }
    return pages
  }

  /**
   * The answer of a named location (an error_page target), which nginx enters
   * by an internal redirect: its rewrite phase, content type and headers.
   */
  named(name) {
    const found = locationsOf(this.server).find(item => item.modifier === '@' && item.path === name)
    if (!found) throw new Error(`no named location ${name}`)
    const block = found.directive.block
    const outcome = this.runRewrite(block, (text) => text, new Map(), (variable) => {
      throw new Error(`named location ${name} reads $${variable}, which is not modelled`)
    })
    if (!outcome) throw new Error(`named location ${name} does not return`)
    const scopes = [block]
    return {
      ...outcome,
      location: name,
      contentType: this.inherited('default_type', scopes)?.[0],
      addHeaders: outcome.addHeaders ?? this.addHeaders(scopes),
      accessLog: this.inheritedAll('access_log', scopes).map(item => item.args),
    }
  }

  runRewrite(block, expand, variables, value) {
    for (const item of block ?? []) {
      if (item.name === 'set') {
        const [name, setting] = item.args
        variables.set(name.slice(1), expand(setting))
      } else if (item.name === 'return') {
        return { action: 'return', status: Number(item.args[0]), body: item.args[1] === undefined ? undefined : expand(item.args[1]) }
      } else if (item.name === 'if') {
        if (this.condition(item.args, expand, value)) {
          for (const inner of item.block) {
            if (!['return', 'add_header'].includes(inner.name)) {
              throw new Error(`unmodelled directive "${inner.name}" inside if on line ${inner.line}`)
            }
          }
          const result = this.runRewrite(item.block.filter(inner => inner.name === 'return'), expand, variables, value)
          const headers = this.directives('add_header', item.block)
          if (result) return headers.length ? { ...result, addHeaders: Object.fromEntries(headers.map(header => [header.args[0], header.args[1]])) } : result
        }
      } else if (['rewrite', 'break'].includes(item.name)) {
        throw new Error(`unmodelled rewrite directive "${item.name}" on line ${item.line}`)
      }
    }
    return null
  }

  condition(args, expand, value) {
    const text = args.join(' ')
    const match = /^\(\s*\$([A-Za-z0-9_]+)\s*(?:(=|!=|~\*|~|!~\*|!~)\s*(.*?))?\s*\)$/.exec(text)
    if (!match) throw new Error(`unmodelled if condition ${text}`)
    const [, name, operator, operand] = match
    const actual = value(name)
    if (!operator) return actual !== '' && actual !== '0'
    const expected = expand(operand)
    if (operator === '=') return actual === expected
    if (operator === '!=') return actual !== expected
    const pattern = new RegExp(expected, operator.includes('*') ? 'i' : '')
    return operator.startsWith('!') ? !pattern.test(actual) : pattern.test(actual)
  }

  evaluateMap(map, value) {
    const source = map.source.replace(/\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/g,
      (_whole, braced, bare) => value(braced ?? bare))
    let fallback = ''
    const regexes = []
    for (const entry of map.entries) {
      const [key, result] = [entry.name, entry.args[0]]
      if (entry.args.length !== 1) throw new Error(`unmodelled map entry on line ${entry.line}`)
      if (key === 'default') { fallback = result; continue }
      if (key.startsWith('~')) { regexes.push([key, result]); continue }
      if (key === source) return result
    }
    for (const [key, result] of regexes) {
      const caseless = key.startsWith('~*')
      if (new RegExp(key.slice(caseless ? 2 : 1), caseless ? 'i' : '').test(source)) return result
    }
    return fallback
  }

  evaluateGeo(entries, address) {
    let fallback = ''
    let best = null
    for (const entry of entries) {
      const result = entry.args[0]
      if (entry.name === 'default') { fallback = result; continue }
      const [network, prefix = isIP(entry.name) === 6 ? '128' : '32'] = entry.name.split('/')
      if (addressMatches(cidrList([`${network}/${prefix}`]), address)
          && (!best || Number(prefix) > best.prefix)) best = { prefix: Number(prefix), result }
    }
    return best ? best.result : fallback
  }

  inherited(name, scopes) {
    for (const scope of [...scopes, this.server]) {
      const found = this.directives(name, scope)
      if (found.length) return found.at(-1).args
    }
    return undefined
  }

  inheritedAll(name, scopes) {
    for (const scope of [...scopes, this.server]) {
      const found = this.directives(name, scope)
      if (found.length) return found
    }
    return []
  }

  addHeaders(scopes) {
    return Object.fromEntries(this.inheritedAll('add_header', scopes).map(header => [header.args[0], header.args[1]]))
  }
}
