/**
 * dsh-plugin-speech — the audio protocol engine.
 *
 * One implementation of the OpenAI-compatible audio API for the whole bundle:
 * which providers serve it, what models and voices they announce, the synthesis
 * and transcription requests, one bounded event log, and the registry of mounted
 * components. `speech-core` owns this engine and provides it as the
 * `audioProtocol` service; the other three rows inject it and contribute only
 * their routes and their preferences.
 *
 * Discovery is capability-based, not name-based: a provider is offered when its
 * audio route answers at all, every model it lists is offered (audio.cpp
 * declares `task: "tts"`, Ollama serves speech from models that declare
 * nothing), and declaration only decides ordering.
 */

import { readFile } from 'node:fs/promises'

import { baseUrl, follow, number } from './config.js'

/** Protocol behaviour defaults; no server, model, or voice is assumed. */
export const DEFAULTS = {
  /** Extra servers that are not configured as model providers. */
  endpoints: [],
  /** How long a discovery result is reused before probing the engines again. */
  discoveryTtlMs: 15000,
  /** How long a provider that failed its capability probe is left alone. */
  failureTtlMs: 300000,
  /** How long one capability probe may take before it is called inconclusive. */
  probeTimeoutMs: 8000,
  /** Retained entries in the bundle event log. */
  logLimit: 200,
  /** One synthesis may take a while on a slow model. */
  speakTimeoutMs: 120000,
  /** One transcription may take a while on a cold model. */
  transcribeTimeoutMs: 300000,
  /** Paths to the engines' own `server.json` catalogs, for voice tags. */
  voiceCatalog: [],
}

/** Log levels a reader can filter by. */
export const LEVELS = ['debug', 'info', 'warn', 'error']

/** The directions this bundle speaks, each with its own discovery result. */
export const KINDS = ['tts', 'stt']

/** Kokoro ids encode language and gender in their prefix. */
const KOKORO_LANGUAGES = { a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'zh' }

/** Private IPv4 ranges an audio engine plausibly runs on: 10/8, 172.16/12, 192.168/16. */
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * Whether an endpoint is on this machine or the local network.
 *
 * Discovery probes reach out with the profile's credentials, so a provider the
 * profile configures for text must not be probed on a cloud URL by default: the
 * two wire calls would land on somebody's paid API without anyone asking. Local
 * and private endpoints stay automatic; a remote engine is probed when the
 * operator lists it in the core row's `endpoints`.
 * @param value - provider base URL.
 * @returns True for loopback, link-local, and RFC 1918/4193 addresses.
 */
export function isLocalEndpoint (value) {
  let host
  try {
    host = new URL(String(value)).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  if (host === '0.0.0.0' || host === '[::]' || host === '::') return true
  if (host.startsWith('127.')) return true
  if (PRIVATE_V4.test(host)) return true
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.startsWith('::ffff:')) return true
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true
  return false
}

/** A model name that looks like a speech model. Ordering only. */
const AUDIO_NAME = /(audio|omni|whisper|transcri|speech|asr|parakeet|sensevoice|canary)/i

/** A model name that looks like a text-to-speech model. Ordering only. */
const TTS_NAME = /(audio|omni|tts|speech|kokoro|whisper)/i

/**
 * Present an engine voice id as a title-case label (`af_heart` → `Af Heart`).
 * @param id - engine voice identity.
 * @returns Display label.
 */
function voiceLabel (id) {
  return String(id)
    .split(/[_-]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Tags carried by a voice id alone, for engines that follow the Kokoro naming.
 * @param id - voice id from the engine.
 * @returns Label plus gender and language when the id encodes them.
 */
function deriveVoice (id) {
  const match = /^([a-z])([fm])_([a-z0-9]+)$/.exec(id)
  if (match === null) return { label: voiceLabel(id), gender: null, language: null }
  return {
    label: match[3].charAt(0).toUpperCase() + match[3].slice(1),
    gender: match[2] === 'f' ? 'female' : 'male',
    language: KOKORO_LANGUAGES[match[1]] ?? null,
  }
}

/** Whether one model name looks like a transcription model. Ordering only. */
function looksAudio (id) {
  return AUDIO_NAME.test(id)
}

/** Whether one model name looks like a TTS model. Ordering only. */
function looksSpeech (id) {
  return TTS_NAME.test(id)
}

/**
 * Whether one model declares itself a text-to-speech model. Ordering only:
 * engines such as Ollama serve speech from models that declare no task at all
 * (`lfm3-omni`), so no model is dropped for staying silent about itself.
 * @param model - model record from the server's list.
 * @returns True when its task or family names TTS.
 */
function declaresTts (model) {
  return /tts/i.test(model.task ?? '') || /tts/i.test(model.family ?? '')
}

/**
 * Bounded in-memory event log: the last `limit` entries, newest last.
 * @param limitOf - reads the current bound, so a live settings write resizes it.
 * @returns Log with `add`, `tail`, `clear`, and `counts`.
 */
function createLog (limitOf) {
  const entries = []
  const bound = () => Math.max(1, Number(limitOf()) || 200)
  return {
    add (component, level, event, detail) {
      const entry = { at: Date.now(), component, level, event }
      if (detail !== undefined && detail !== null) entry.detail = detail
      entries.push(entry)
      while (entries.length > bound()) entries.shift()
      return entry
    },
    tail (count, filter = {}) {
      const matching = entries.filter((entry) =>
        (filter.level === undefined || entry.level === filter.level) &&
        (filter.component === undefined || entry.component === filter.component))
      return matching.slice(-count)
    },
    clear () {
      const total = entries.length
      entries.length = 0
      return total
    },
    counts () {
      const counts = { debug: 0, info: 0, warn: 0, error: 0 }
      for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1
      return counts
    },
  }
}

/**
 * Build the protocol service bound to one Host context.
 * @param ctx - Host context carrying the settings and provider directories.
 * @param options - `optionsOf()` output.
 * @returns The `audioProtocol` service the other rows inject.
 */
export function createProtocol (ctx, options) {
  /** Per-direction discovery state: last result, when it was taken, failed endpoints. */
  const state = {}
  for (const kind of KINDS) state[kind] = { discovered: null, at: 0, failures: new Map() }
  /** Credential variable per endpoint, so every request authenticates like discovery. */
  const authByEndpoint = new Map()
  /** Voice tags by model and voice id, loaded from the providers' own catalogs. */
  let catalog = new Map()
  let catalogAt = 0
  /** The live components, keyed by component id, in mount order. */
  const mounted = new Map()
  /** Host and browser events, bounded, shared by every component. */
  const log = createLog(() => options.logLimit)

  /**
   * Write one event to the shared log and, when available, the Host logger.
   * @param component - reporting component id.
   * @param level - one of `LEVELS`.
   * @param event - short event name.
   * @param detail - optional structured detail.
   */
  function note (component, level, event, detail) {
    log.add(component, level, event, detail)
    const writer = level === 'error' ? ctx.logger?.error : level === 'warn' ? ctx.logger?.warn : ctx.logger?.debug
    try {
      writer?.call(ctx.logger, `[audio:${component}] ${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    } catch { /* logging must never break a request */ }
  }

  /**
   * Load `server.json`-shaped catalogs, so a voice can carry the tags its engine
   * published (gender, language, category, description) instead of a bare id.
   * @returns Model id → voice id → tags.
   */
  async function loadCatalog () {
    if (Date.now() - catalogAt < 60_000) return catalog
    catalogAt = Date.now()
    const table = new Map()
    for (const path of options.voiceCatalog) {
      let parsed
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        continue
      }
      for (const model of Array.isArray(parsed?.models) ? parsed.models : []) {
        const presets = model?.voice_presets
        if (presets === null || typeof presets !== 'object' || typeof model?.id !== 'string') continue
        const voices = table.get(model.id) ?? new Map()
        for (const [key, preset] of Object.entries(presets)) {
          if (preset === null || typeof preset !== 'object') continue
          const tags = {
            label: key,
            gender: typeof preset.gender === 'string' ? preset.gender : null,
            language: typeof preset.language === 'string' ? preset.language : null,
            category: typeof preset.category === 'string' ? preset.category : null,
            default: preset.default === true,
            description: typeof preset.description === 'string' ? preset.description.slice(0, 240) : null,
          }
          voices.set(key, tags)
          if (typeof preset.voice_id === 'string' && preset.voice_id !== key) voices.set(preset.voice_id, tags)
        }
        table.set(model.id, voices)
      }
    }
    catalog = table
    return table
  }

  /**
   * Every provider this Host can reach over HTTP, plus any endpoint listed in
   * the protocol row's own config. No provider is dropped for lacking an
   * endpoint: the directory's default URL is used when the profile sets none,
   * and the capability probe decides what actually speaks.
   * @returns Unique candidates in provider order.
   */
  function candidates () {
    const found = []
    const seen = new Set()
    /**
     * Add one candidate unless its endpoint was already offered.
     * @param id - provider key.
     * @param name - display name.
     * @param endpoint - base URL.
     * @param apiKeyEnv - environment variable holding the provider's credential.
     */
    const add = (id, name, endpoint, apiKeyEnv) => {
      const normalized = baseUrl(endpoint ?? '')
      if (normalized === '') return
      if (seen.has(normalized)) return
      seen.add(normalized)
      authByEndpoint.set(normalized, typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined)
      found.push({ id, name: name ?? id, baseURL: normalized, apiKeyEnv: typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined })
    }
    let entries = []
    try {
      entries = ctx.llm.listConfigurableProviders()
    } catch {
      entries = []
    }
    let descriptors = []
    try {
      descriptors = ctx.settings.describe()
    } catch {
      descriptors = []
    }
    const values = new Map(descriptors.map((descriptor) => [descriptor.ns, descriptor.value]))
    for (const entry of entries) {
      const path = entry.settingsPath ?? []
      /* Configured, not merely known: the catalog lists every route an adapter
         ships, and probing those would offer cloud models nobody asked for. */
      const section = follow(values.get(entry.settingsNs), path.slice(0, -1))
      const key = path[path.length - 1]
      if (section === null || typeof section !== 'object' || key === undefined || !Object.hasOwn(section, key)) continue
      const profile = section[key]
      const endpoint = profile !== null && typeof profile === 'object' && typeof profile.baseURL === 'string'
        ? profile.baseURL
        : entry.defaultBaseURL
      const apiKeyEnv = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
        ? profile.apiKeyEnv
        : undefined
      const normalized = baseUrl(endpoint ?? '')
      if (normalized !== '' && !isLocalEndpoint(normalized)) {
        /* A text provider on a cloud URL is not an audio engine; probing it would
           spend the operator's quota on two requests that cannot become audio. */
        note('core', 'debug', 'provider-skipped', { provider: entry.provider, endpoint: normalized, reason: 'remote-endpoint' })
        continue
      }
      add(entry.provider, entry.displayName, endpoint, apiKeyEnv)
    }
    /* An explicit entry is an explicit request: it is probed wherever it lives. */
    for (const extra of options.endpoints) {
      if (extra !== null && typeof extra === 'object' && typeof extra.baseURL === 'string') {
        add(extra.id ?? extra.baseURL, extra.name, extra.baseURL, extra.apiKeyEnv)
      }
    }
    return found
  }

  /**
   * Request headers for one provider, including its credential when the profile
   * names an environment variable that is set. The value never leaves the Host.
   * @param endpoint - provider base URL.
   * @param jsonBody - whether the request carries a JSON body.
   * @returns Headers for every request to that provider.
   */
  function headersOf (endpoint, jsonBody = false) {
    const headers = { accept: 'application/json' }
    const variable = authByEndpoint.get(endpoint)
    const value = variable === undefined ? undefined : process.env[variable]
    if (typeof value === 'string' && value !== '') headers.authorization = `Bearer ${value}`
    if (jsonBody) headers['content-type'] = 'application/json'
    return headers
  }

  /**
   * Fetch one server's model list.
   * @param endpoint - provider base URL.
   * @returns Model records with their declared task/family, or null when the
   *   list cannot be read at all.
   */
  async function fetchModels (endpoint) {
    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: headersOf(endpoint),
        signal: AbortSignal.timeout(options.probeTimeoutMs),
      })
      if (!response.ok) return null
      const body = await response.json().catch(() => null)
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      return rows
        .map((row) => ({
          id: typeof row?.id === 'string' ? row.id : typeof row === 'string' ? row : undefined,
          task: typeof row?.task === 'string' ? row.task : undefined,
          family: typeof row?.family === 'string' ? row.family : undefined,
        }))
        .filter((row) => row.id !== undefined)
    } catch {
      return null
    }
  }

  /**
   * The OpenAI capability test for one audio route: a deliberately empty body is
   * sent — a handler rejects it (400/422/500), a non-speech server answers
   * 404/405/501. Nothing is synthesized, so the probe costs no GPU time.
   * @param endpoint - provider base URL.
   * @param path - `/audio/speech` or `/audio/transcriptions`.
   * @returns `yes`, `no`, or `unknown` when the server is busy, slow, or absent.
   */
  async function supportsRoute (endpoint, path) {
    try {
      const response = await fetch(`${endpoint}${path}`, {
        method: 'POST',
        headers: headersOf(endpoint, true),
        body: '{}',
        signal: AbortSignal.timeout(options.probeTimeoutMs),
      })
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return response.status !== 404 && response.status !== 405 && response.status !== 501 ? 'yes' : 'no'
    } catch {
      /* Busy, slow, or unreachable: unknown, not a refusal. */
      return 'unknown'
    }
  }

  /**
   * Whether the provider also implements the voice listing of the audio API.
   * @param endpoint - provider base URL.
   * @returns True when `/audio/voices` answers.
   */
  async function listsVoices (endpoint) {
    try {
      const response = await fetch(`${endpoint}/audio/voices`, {
        headers: headersOf(endpoint),
        signal: AbortSignal.timeout(options.probeTimeoutMs),
      })
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Ask one model which voices it can speak.
   * @param endpoint - provider base URL.
   * @param model - engine model id.
   * @returns Voice rows in engine order, or an empty list.
   */
  async function fetchVoices (endpoint, model) {
    try {
      const response = await fetch(`${endpoint}/audio/voices?model=${encodeURIComponent(model)}`, {
        headers: headersOf(endpoint),
        signal: AbortSignal.timeout(options.probeTimeoutMs),
      })
      if (!response.ok) return []
      const body = await response.json().catch(() => null)
      const ids = Array.isArray(body?.voices) ? body.voices : []
      const tables = await loadCatalog()
      const tagsOf = tables.get(model)
      return ids
        .filter((voice) => typeof voice === 'string' && voice.trim() !== '')
        .map((id) => {
          const tags = tagsOf?.get(id)
          const derived = deriveVoice(id)
          return {
            id,
            label: derived.label !== id ? derived.label : tags?.label ?? derived.label,
            gender: tags?.gender ?? derived.gender,
            language: tags?.language ?? derived.language,
            category: tags?.category ?? null,
            default: tags?.default === true,
            description: tags?.description ?? null,
          }
        })
    } catch {
      return []
    }
  }

  /**
   * Probe one candidate for one direction.
   * @param kind - `tts` or `stt`.
   * @param candidate - id, name, endpoint, and credential variable.
   * @returns The server row, or the reason it was refused.
   */
  async function probe (kind, candidate) {
    const route = kind === 'tts' ? '/audio/speech' : '/audio/transcriptions'
    const audio = await supportsRoute(candidate.baseURL, route)
    if (audio === 'no') return { server: null, reason: 'no-speech' }
    const models = await fetchModels(candidate.baseURL)
    if (models === null) return { server: null, reason: audio === 'unknown' ? 'timeout' : 'no-models' }
    if (kind === 'stt') {
      const ordered = [...models].sort((left, right) => Number(looksAudio(right.id)) - Number(looksAudio(left.id)))
      return {
        server: {
          id: candidate.id,
          name: candidate.name,
          baseURL: candidate.baseURL,
          declaresAudio: ordered.some((model) => looksAudio(model.id)),
          /* A server whose whole catalogue declares itself TTS speaks no
             transcriptions; it stays offered, but after the servers that do. */
          onlyTts: models.length > 0 && models.every((model) => declaresTts(model)),
          models: ordered.map((model) => model.id),
        },
        reason: null,
      }
    }
    const voiceAware = await listsVoices(candidate.baseURL)
    const announced = await Promise.all(models.map(async (model) => ({
      id: model.id,
      label: model.id,
      declaresTts: declaresTts(model),
      voices: voiceAware ? await fetchVoices(candidate.baseURL, model.id) : [],
    })))
    /* Declared speech models lead the list; the rest keep the server's order. */
    announced.sort((left, right) => Number(right.declaresTts) - Number(left.declaresTts))
    return {
      server: {
        id: candidate.id,
        name: candidate.name,
        baseURL: candidate.baseURL,
        declaresTts: announced.some((model) => model.declaresTts),
        models: announced.map(({ declaresTts: _declaresTts, ...model }) => model),
      },
      reason: null,
    }
  }

  /**
   * Discover the servers that serve one direction, reusing the last result until
   * it expires.
   * @param kind - `tts` or `stt`.
   * @param force - probe again even when the cached result is fresh.
   * @returns Server rows in provider order.
   */
  async function discover (kind, force = false) {
    const current = state[kind]
    if (!force && current.discovered !== null && Date.now() - current.at < options.discoveryTtlMs) return current.discovered
    /* Two surfaces waking at once (the reply action and the composer control)
       must share one probe round instead of doubling the load on every engine. */
    if (current.pending !== undefined) return current.pending
    current.pending = probeRound(kind, force).finally(() => { current.pending = undefined })
    return current.pending
  }

  /**
   * Run one probe round for a direction and publish what it found.
   * @param kind - `tts` or `stt`.
   * @param force - probe every candidate, including recently failed ones.
   * @returns Server rows in provider order.
   */
  async function probeRound (kind, force) {
    const current = state[kind]
    const probes = candidates().filter((candidate) => {
      /* An explicit refresh probes everything; a cached failure only delays the rest. */
      if (force) return true
      const failedAt = current.failures.get(candidate.baseURL)
      return failedAt === undefined || Date.now() - failedAt > options.failureTtlMs
    })
    const lastGood = new Map((current.discovered ?? []).map((server) => [server.baseURL, server]))
    const probed = await Promise.all(probes.map(async (candidate) => {
      const result = await probe(kind, candidate)
      if (result.server !== null) {
        current.failures.delete(candidate.baseURL)
        return result.server
      }
      if (result.reason === 'timeout') {
        /* Still loading a model, or too busy to answer: keep what it offered
           before rather than deleting the provider for five minutes. */
        const kept = lastGood.get(candidate.baseURL)
        if (kept !== undefined) {
          note('core', 'debug', 'provider-slow', { kind, provider: candidate.id, endpoint: candidate.baseURL })
          return kept
        }
        return null
      }
      current.failures.set(candidate.baseURL, Date.now())
      note('core', 'debug', 'provider-unusable', { kind, provider: candidate.id, endpoint: candidate.baseURL, reason: result.reason })
      return null
    }))
    /* Servers that declare speech models lead, so a fresh browser defaults to one
       that can actually speak; every other server stays available after them. */
    const declared = kind === 'tts' ? 'declaresTts' : 'declaresAudio'
    current.discovered = probed
      .filter((server) => server !== null)
      .sort((left, right) =>
        Number(right[declared]) - Number(left[declared]) ||
        Number(left.onlyTts === true) - Number(right.onlyTts === true))
    current.at = Date.now()
    note('core', 'debug', 'discovered', {
      kind,
      servers: current.discovered.map((server) => `${server.id}:${server.models.length}`),
      probed: probes.length,
    })
    return current.discovered
  }

  /**
   * Resolve the server/model/voice a request means, honouring the calling row's
   * preferences. A model named without its server is looked up across every
   * provider, so a flat model list stays routable when two servers share a panel.
   * @param kind - `tts` or `stt`.
   * @param wanted - explicitly requested server, model, and voice.
   * @param preferences - the owning row's configured server/model/voice.
   * @returns The resolved selection, or null when nothing corresponds.
   */
  function resolve (kind, wanted = {}, preferences = {}) {
    const servers = state[kind].discovered ?? []
    let server = servers.find((row) => row.id === wanted.server) ??
      servers.find((row) => row.id === preferences.server) ??
      servers[0]
    if (server === undefined) return null
    if (kind === 'stt') {
      let model = wanted.model === undefined ? undefined : server.models.find((id) => id === wanted.model)
      if (model === undefined && wanted.model !== undefined && wanted.server === undefined) {
        const owner = servers.find((row) => row.models.includes(wanted.model))
        if (owner !== undefined) {
          server = owner
          model = wanted.model
        }
      }
      model = model ?? server.models.find((id) => id === preferences.model) ?? server.models[0]
      if (model === undefined) return null
      return { server, model, voice: null }
    }
    let model = wanted.model === undefined ? undefined : server.models.find((row) => row.id === wanted.model)
    if (model === undefined && wanted.model !== undefined && wanted.server === undefined) {
      const owner = servers.find((row) => row.models.some((candidate) => candidate.id === wanted.model))
      if (owner !== undefined) {
        server = owner
        model = owner.models.find((row) => row.id === wanted.model)
      }
    }
    model = model ??
      server.models.find((row) => row.id === preferences.model) ??
      /* Prefer something that can speak: a provider that lists voices knows its
         speech models; otherwise fall back to names that look like speech. */
      server.models.find((row) => row.voices.length > 0) ??
      server.models.find((row) => looksSpeech(row.id)) ??
      server.models[0]
    if (model === undefined) return null
    const byId = (value) => (value === undefined || value === null ? undefined : model.voices.find((row) => row.id === value))
    const byLabel = (value) => {
      if (value === undefined || value === null) return undefined
      const wantedLabel = String(value).toLowerCase()
      return model.voices.find((row) => String(row.label ?? '').toLowerCase() === wantedLabel)
    }
    const voice = byId(wanted.voice) ?? byLabel(wanted.voice) ??
      byId(preferences.voice) ?? byLabel(preferences.voice) ??
      model.voices.find((row) => row.default === true) ??
      model.voices[0]
    return { server, model, voice: voice ?? null }
  }

  /**
   * Turn a refused audio request into an error the routes can serialise. Engines
   * answer with the OpenAI error envelope; unwrap it for the panel.
   * @param response - the refused fetch response.
   * @param what - what the call was, for the fallback message.
   * @returns The error, carrying the status the route answers.
   */
  async function failureOf (response, what) {
    const detail = await response.text().catch(() => '')
    let message = detail.trim().slice(0, 400) || `${what} answered ${response.status}`
    try {
      const parsed = JSON.parse(detail)
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 400)
    } catch { /* not a JSON error body */ }
    const error = new Error(message)
    error.status = response.status >= 500 ? 502 : 400
    return error
  }

  /**
   * POST one synthesis to an engine and buffer the audio.
   * @param endpoint - engine base URL.
   * @param text - prose to synthesize.
   * @param model - engine model id.
   * @param voice - engine voice id, or null for the model's own default.
   * @param speed - speaking rate.
   * @returns Buffered audio and its media type.
   */
  async function speak (endpoint, text, model, voice, speed) {
    const payload = { model, input: text, response_format: 'wav', speed }
    if (voice !== null && voice !== undefined) payload.voice = voice
    const response = await fetch(`${endpoint}/audio/speech`, {
      method: 'POST',
      headers: headersOf(endpoint, true),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.speakTimeoutMs),
    })
    if (!response.ok) throw await failureOf(response, 'speech server')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length === 0) {
      const error = new Error('speech server returned no audio')
      error.status = 502
      throw error
    }
    return { body, type: response.headers.get('content-type') ?? 'audio/wav' }
  }

  /**
   * Forward one recording to a provider's transcription endpoint.
   * @param endpoint - provider base URL.
   * @param model - provider model id.
   * @param audio - WAV bytes.
   * @param language - language hint, or null to let the model detect it.
   * @returns The provider's text.
   */
  async function transcribe (endpoint, model, audio, language) {
    const form = new FormData()
    form.set('model', model)
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
    form.set('response_format', 'json')
    if (language !== null && language !== undefined) form.set('language', language)
    const response = await fetch(`${endpoint}/audio/transcriptions`, {
      method: 'POST',
      headers: headersOf(endpoint),
      body: form,
      signal: AbortSignal.timeout(options.transcribeTimeoutMs),
    })
    const raw = await response.text().catch(() => '')
    if (!response.ok) {
      let message = raw.trim().slice(0, 400) || `transcription answered ${response.status}`
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 400)
      } catch { /* not a JSON error body */ }
      const error = new Error(message)
      error.status = response.status >= 500 ? 502 : 400
      throw error
    }
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed?.text === 'string' ? parsed.text : ''
    } catch {
      /* Providers without response_format support may answer plain text. */
      return raw.trim()
    }
  }

  /**
   * Register one mounted component, so the inventory row can report it and the
   * shared log accepts events tagged with it.
   * @param row - component id, title, description, order, and its routes.
   * @returns The disposer that removes the record when the row unloads.
   */
  function registerComponent (row) {
    mounted.set(row.id, { ...row, mountedAt: Date.now() })
    note('core', 'debug', 'component-mounted', { component: row.id })
    return () => mounted.delete(row.id)
  }

  return {
    note,

    /** Every component the profile composed, in declaration order. */
    components () {
      /* Declaration order, not mount order: the rows mount in Loader order,
         which is stable but not the order the bundle patch lists. */
      return [...mounted.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    },

    /** Whether a component id belongs to a mounted row (the log accepts only those). */
    isComponent (id) {
      return mounted.has(id)
    },

    discover,
    resolve,
    speak,
    transcribe,
    registerComponent,

    /**
     * What discovery has learned so far, without triggering a probe.
     * @returns Per direction: the server ids, or null when nothing was discovered yet.
     */
    summary () {
      const out = {}
      for (const kind of KINDS) {
        out[kind] = { servers: state[kind].discovered === null ? null : state[kind].discovered.map((server) => server.id) }
      }
      return out
    },

    /**
     * Log entries, newest last.
     * @param tail - how many entries.
     * @param filter - level and/or component.
     * @returns The matching entries.
     */
    entries (tail = 20, filter = {}) {
      return log.tail(tail, filter)
    },

    counts () {
      return log.counts()
    },

    clear () {
      return log.clear()
    },
  }
}
