/**
 * dsh-plugin-speech — the protocol component (`audio-core`).
 *
 * Owns the machine-facing half of speech for the whole bundle: the discovery of
 * the OpenAI-compatible audio providers configured in the profile, the wire
 * calls, the bundle's one event log, and the registry of mounted components.
 * It provides that engine as the `audioProtocol` service; the other three rows
 * inject it and contribute only their routes and their preferences.
 *
 * Nothing is hardcoded. Servers come from the profile's model providers, every
 * model a server lists is offered, and capability decides what speaks.
 */

import z from '@deepseek-ai/schemastery'

import { liveOptions, number } from '../lib/config.js'
import { bodyError, json, readJson, routes } from '../lib/http.js'
import { DEFAULTS, LEVELS, createProtocol } from '../lib/protocol.js'

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'core',
  order: 10,
  title: 'Audio protocol',
  description: 'Discovers the OpenAI-compatible audio providers, performs the wire calls, and owns the shared event log',
  routes: ['/audio/log'],
}

/**
 * This row's config schema. The Loader parses the row's config through it, so the
 * defaults here are the values a profile that sets nothing gets.
 *
 * The fields this row's configuration page edits are marked `.volatile()`: the
 * settings service publishes only volatile fields (`volatileForm` drops the rest
 * and skips an entry with none), so the mark is what gives the row a settings
 * namespace and a form at all. Everything else stays patch-only. Ranges stay in
 * `optionsOf`, which clamps every value the row ever sees.
 */
export const Config = z.object({
  endpoints: z.array(z.any()).default(DEFAULTS.endpoints).description('Audio servers to offer besides the local ones: remote engines, and anything that is not a configured model provider'),
  discoveryTtlMs: z.natural().default(DEFAULTS.discoveryTtlMs).description('How long a discovery result is reused, in milliseconds').volatile(),
  failureTtlMs: z.natural().default(DEFAULTS.failureTtlMs).description('How long a provider that failed its probe is left alone, in milliseconds'),
  probeTimeoutMs: z.natural().default(DEFAULTS.probeTimeoutMs).description('Upper bound for one capability probe, in milliseconds'),
  logLimit: z.natural().default(DEFAULTS.logLimit).description('Retained entries in the shared event log').volatile(),
  speakTimeoutMs: z.natural().default(DEFAULTS.speakTimeoutMs).description('Upper bound for one synthesis request, in milliseconds'),
  transcribeTimeoutMs: z.natural().default(DEFAULTS.transcribeTimeoutMs).description('Upper bound for one transcription request, in milliseconds'),
  voiceCatalog: z.array(z.string()).default(DEFAULTS.voiceCatalog).description('Paths to the engines own server.json catalogs, for voice tags').volatile(),
})

/** Required Host services: routes, provider configuration, and the provider directory. */
export const inject = ['webServer', 'settings', 'llm']

/**
 * Mount the protocol engine, its shared log route, and the component record.
 * @param ctx - Host context carrying the web server, settings, and the provider directory.
 * @param config - Endpoint overrides and probe/log budgets.
 */
export function apply (ctx, config = {}) {
  /* Fields the configuration page edits arrive as live references; these getters
     read them at use time, so a settings write lands without a row restart. */
  const options = liveOptions(config, DEFAULTS, {
    endpoints: (value) => (Array.isArray(value) ? value : []),
    discoveryTtlMs: (value, fallback) => number(value, fallback, 0, 600000),
    failureTtlMs: (value, fallback) => number(value, fallback, 0, 3600000),
    probeTimeoutMs: (value, fallback) => number(value, fallback, 250, 120000),
    logLimit: (value, fallback) => number(value, fallback, 1, 5000),
    speakTimeoutMs: (value, fallback) => number(value, fallback, 1000, 3600000),
    transcribeTimeoutMs: (value, fallback) => number(value, fallback, 1000, 3600000),
    voiceCatalog: (value) => (Array.isArray(value) ? value : [value]).filter((path) => typeof path === 'string' && path !== ''),
  })
  const protocol = createProtocol(ctx, options)

  /**
   * Keep one log payload under the wire budget without ever parsing a string it
   * just cut: oversized details become `{ truncated }` plus their JSON prefix.
   * @param value - the client-supplied detail, if any.
   * @returns A bounded plain value, or undefined.
   */
  function bounded (value) {
    if (value === undefined) return undefined
    let text
    try {
      text = JSON.stringify(value)
    } catch {
      return undefined
    }
    if (typeof text !== 'string') return undefined
    if (text.length <= 2000) return JSON.parse(text)
    return { truncated: true, json: text.slice(0, 1900) }
  }

  /**
   * Apply one client log post.
   * @param req - node request.
   * @param res - node response.
   * @returns The response that was sent.
   */
  async function postEntry (req, res) {
    let entry
    try {
      entry = await readJson(req, 8192)
    } catch (error) {
      return bodyError(res, error)
    }
    const level = LEVELS.includes(entry?.level) ? entry.level : 'warn'
    /* Only a mounted component may post under its own name; anything else is a
       Host-side note. */
    const component = typeof entry?.component === 'string' && protocol.isComponent(entry.component) ? entry.component : 'core'
    const event = typeof entry?.event === 'string' ? entry.event.slice(0, 40) : 'client-event'
    const detail = entry?.detail !== null && typeof entry?.detail === 'object' ? entry.detail : undefined
    protocol.note(component, level, event, bounded(detail))
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }

  /**
   * Answer one log read, filterable by level and component.
   * @param res - node response.
   * @param url - parsed request URL.
   * @returns The response that was sent.
   */
  function readEntries (res, url) {
    const tail = number(url.searchParams.get('tail'), 20, 1, 200)
    const level = url.searchParams.get('level') ?? undefined
    if (level !== undefined && !LEVELS.includes(level)) {
      return json(res, 400, { error: { code: 'level', message: `unknown level: ${level}` } })
    }
    const component = url.searchParams.get('component') ?? undefined
    if (component !== undefined && !protocol.isComponent(component)) {
      return json(res, 400, { error: { code: 'component', message: `unknown component: ${component}` } })
    }
    /* Debug is opt-in: a plain read shows what a reader can act on. */
    const entries = level === undefined
      ? protocol.entries(tail, { component }).filter((entry) => entry.level !== 'debug')
      : protocol.entries(tail, { component, level })
    return json(res, 200, { entries, counts: protocol.counts() })
  }

  /**
   * The bundle's shared log: read, append a client event, or clear.
   * @param req - node request.
   * @param res - node response.
   * @param url - parsed request URL.
   * @returns The response that was sent.
   */
  async function logRoute (req, res, url) {
    if (req.method === 'POST') return postEntry(req, res)
    if (req.method === 'GET') return readEntries(res, url)
    if (req.method === 'DELETE') return json(res, 200, { cleared: protocol.clear() })
    return json(res, 405, { error: { code: 'method', message: 'GET, POST, or DELETE /audio/log' } })
  }

  protocol.note('core', 'info', 'ready', {
    logLimit: options.logLimit,
    discoveryTtlMs: options.discoveryTtlMs,
    probeTimeoutMs: options.probeTimeoutMs,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/audio/log',
    handler: routes([{ path: '/audio/log', method: '*', handle: logRoute, body: 'json' }]),
  }), 'dsh-plugin-speech: /audio/log route')
  ctx.provide('audioProtocol', protocol)
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-speech: core component record')
}
