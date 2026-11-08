/**
 * dsh-plugin-speech — the engine row (`speech`).
 *
 * Owns the machine-facing half of speech for the whole bundle: the discovery of
 * the OpenAI-compatible audio providers configured in the profile, the wire
 * calls, the bundle's one event log, the component registry, and the inventory
 * routes that test the engine against itself (the component inventory and the
 * speak-then-transcribe round trip). It provides that engine as the
 * `speechAudio` service; the two surface rows inject it and contribute only
 * their routes and their preferences.
 *
 * This row is the bare package name on purpose: the shell discovers a package's
 * browser half only from a Loader row whose specifier is the package itself.
 * Switching this row off leaves the two surface rows waiting for the engine.
 *
 * Nothing is hardcoded. Servers come from the profile's model providers, every
 * model a server lists is offered, and capability decides what speaks.
 */

import { readFile } from 'node:fs/promises'

import z from '@deepseek-ai/schemastery'

import { DEFAULTS, LEVELS, createProtocol, isLocalEndpoint, liveOptions, number } from './lib/audio.js'
import { bodyError, json, readJson, routes } from './lib/http.js'

/** The sentence the round-trip test speaks when the request names none. */
const SAMPLE = 'The audio bundle is reading this sentence and hearing it back.'

/** Row defaults; the protocol defaults plus the round-trip sentence. */
const ROW_DEFAULTS = { ...DEFAULTS, sample: SAMPLE }

/** This package's own manifest, so the inventory reports the installed version. */
const MANIFEST = new URL('./package.json', import.meta.url)

/** The component record the inventory route reports while this row is mounted. */
const COMPONENT = {
  id: 'speech',
  order: 10,
  title: 'Speech engine',
  description: 'Discovers the OpenAI-compatible audio providers, performs the wire calls, and owns the shared event log and inventory',
  routes: ['/audio/log', '/audio/status', '/audio/echo'],
}

/**
 * This row's config schema. The Loader parses the row's config through it, so the
 * defaults here are the values a profile that sets nothing gets.
 *
 * The fields the configuration page edits are marked `.volatile()`: the settings
 * service publishes only volatile fields (`volatileForm` drops the rest and skips
 * an entry with none), so the mark is what gives the row a settings namespace and
 * a form at all. Everything else stays patch-only. Ranges stay in `apply`, which
 * clamps every value the row ever sees.
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
  sample: z.string().default(SAMPLE).description('Sentence the round-trip test speaks when the request names none').volatile(),
})

/** Required host services: routes, provider configuration, and the provider directory. */
export const inject = ['webServer', 'settings', 'llm']

/** The identity the inventory reports; read once, then reused. */
let identity

/**
 * Read this package's manifest.
 * @returns The parsed `package.json`, or an empty object when it cannot be read.
 */
async function whoami () {
  if (identity !== undefined) return identity
  try {
    identity = JSON.parse(await readFile(MANIFEST, 'utf8'))
  } catch {
    identity = {}
  }
  return identity
}

/**
 * Mount the engine, the shared routes, and the component record.
 * @param ctx - host context carrying the web server, settings, and the provider directory.
 * @param config - endpoint overrides, probe/log/transfer budgets, and the round-trip sentence.
 */
export function apply (ctx, config = {}) {
  /* Fields the configuration page edits arrive as live references; these getters
     read them at use time, so a settings write lands without a row restart. */
  const options = liveOptions(config, ROW_DEFAULTS, {
    endpoints: (value) => (Array.isArray(value) ? value : []),
    discoveryTtlMs: (value, fallback) => number(value, fallback, 0, 600000),
    failureTtlMs: (value, fallback) => number(value, fallback, 0, 3600000),
    probeTimeoutMs: (value, fallback) => number(value, fallback, 250, 120000),
    logLimit: (value, fallback) => number(value, fallback, 1, 5000),
    speakTimeoutMs: (value, fallback) => number(value, fallback, 1000, 3600000),
    transcribeTimeoutMs: (value, fallback) => number(value, fallback, 1000, 3600000),
    voiceCatalog: (value) => (Array.isArray(value) ? value : [value]).filter((path) => typeof path === 'string' && path !== ''),
    sample: (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 400) : fallback),
  })
  const protocol = createProtocol(ctx, options)

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('speech', level, event, detail)
  }

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
    const component = typeof entry?.component === 'string' && protocol.isComponent(entry.component) ? entry.component : 'speech'
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

  /**
   * Which components the profile composed, which providers discovery knows, and
   * the log counts — all without probing anything.
   * @param req - node request.
   * @param res - node response.
   * @returns The response that was sent.
   */
  async function statusRoute (req, res) {
    const manifest = await whoami()
    return json(res, 200, {
      name: typeof manifest.name === 'string' ? manifest.name : 'dsh-plugin-speech',
      version: typeof manifest.version === 'string' ? manifest.version : null,
      components: protocol.components(),
      providers: protocol.summary(),
      log: protocol.counts(),
    })
  }

  /**
   * Speak one sentence, then transcribe the audio that came back: the two
   * directions of the protocol answering each other.
   * @param req - node request.
   * @param res - node response.
   * @returns The response that was sent.
   */
  async function echoRoute (req, res) {
    let body
    try {
      body = await readJson(req, 4096)
    } catch (error) {
      return bodyError(res, error)
    }
    const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim().slice(0, 500) : options.sample
    await Promise.all([protocol.discover('tts'), protocol.discover('stt')])
    const spoken = protocol.resolve('tts', {}, {})
    if (spoken === null) {
      note('warn', 'no-speech-model', { direction: 'tts' })
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
    }
    const heard = protocol.resolve('stt', {}, {})
    if (heard === null) {
      note('warn', 'no-speech-model', { direction: 'stt' })
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
    }
    const startedSpeak = Date.now()
    let audio
    try {
      audio = await protocol.speak(spoken.server.baseURL, text, spoken.model.id, spoken.voice?.id ?? null, 1)
    } catch (error) {
      note('error', 'echo-speak-failed', { provider: spoken.server.id, status: error.status ?? 502, message: String(error.message ?? error).slice(0, 240) })
      return json(res, error.status ?? 502, { error: { code: 'speech', message: error.message } })
    }
    const speakMs = Date.now() - startedSpeak
    const startedTranscribe = Date.now()
    try {
      const transcript = await protocol.transcribe(heard.server.baseURL, heard.model, audio.body, null)
      const transcribeMs = Date.now() - startedTranscribe
      note('info', 'echo', {
        server: spoken.server.id,
        model: spoken.model.id,
        voice: spoken.voice?.id ?? null,
        bytes: audio.body.length,
        chars: text.length,
        transcript: transcript.slice(0, 240),
        speakMs,
        transcribeMs,
      })
      return json(res, 200, {
        input: text,
        transcript,
        server: spoken.server.id,
        model: spoken.model.id,
        voice: spoken.voice?.id ?? null,
        bytes: audio.body.length,
        speakMs,
        transcribeMs,
        heardBy: { server: heard.server.id, model: heard.model },
      })
    } catch (error) {
      note('error', 'echo-transcribe-failed', {
        provider: heard.server.id,
        status: error.status ?? 502,
        message: String(error.message ?? error).slice(0, 240),
      })
      return json(res, error.status ?? 502, { error: { code: 'transcribe', message: error.message } })
    }
  }

  protocol.note('speech', 'info', 'ready', {
    logLimit: options.logLimit,
    discoveryTtlMs: options.discoveryTtlMs,
    probeTimeoutMs: options.probeTimeoutMs,
    sample: options.sample.length,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/audio',
    handler: routes([
      { path: '/audio/log', method: '*', handle: logRoute, body: 'json' },
      { path: '/audio/status', method: 'GET', handle: statusRoute },
      { path: '/audio/echo', method: 'POST', handle: echoRoute, body: 'json' },
    ]),
  }), 'dsh-plugin-speech: /audio routes')
  ctx.provide('speechAudio', protocol)
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-speech: engine component record')
}
