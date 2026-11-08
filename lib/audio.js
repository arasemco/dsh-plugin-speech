/**
 * dsh-plugin-speech — the audio engine.
 *
 * One implementation of the OpenAI-compatible audio API for both directions:
 * which of the profile's explicitly configured providers serve it, what models
 * (and, for speech, voices) they announce, the two wire calls, and the
 * selection of the server/model/voice a request means.
 *
 * Discovery is deliberately narrow and forgiving:
 *  - only providers whose profile sets an explicit `baseURL` are probed, so an
 *    adapter's shipped cloud default is never contacted and no credential is
 *    ever sent to a route the profile did not point at;
 *  - one discovery pass runs at a time per direction;
 *  - a provider that stops answering its model list is kept from the previous
 *    result instead of being dropped for the whole failure TTL — only a server
 *    that answers "no such route" is treated as a refusal.
 */

/** Engine defaults; no server, model, or voice is assumed. */
export const DEFAULTS = {
  /** Extra servers that are not configured model providers. */
  endpoints: [],
  /** How long a discovery result is reused, in milliseconds. */
  discoveryTtlMs: 15000,
  /** How long a provider that answered "no such route" is left alone, in milliseconds. */
  failureTtlMs: 300000,
  /** Upper bound for one capability or model-list request, in milliseconds. */
  probeTimeoutMs: 8000,
  /** Upper bound for one synthesis request, in milliseconds. */
  speakTimeoutMs: 120000,
  /** Upper bound for one transcription request, in milliseconds. */
  transcribeTimeoutMs: 300000,
  /** Largest audio body accepted from an engine, in bytes. */
  maxResponseBytes: 32 * 1024 * 1024,
  /** Most models asked for voices per server. */
  voiceModels: 12,
  /** Concurrent voice-list requests per server. */
  voiceConcurrency: 4,
}

/** A model name that looks like a speech model. Ordering only. */
const AUDIO_NAME = /(audio|omni|whisper|transcri|speech|asr|parakeet|sensevoice|canary)/i

/** A model name that looks like a text-to-speech model. Ordering only. */
const SPEECH_NAME = /(audio|omni|tts|speech|kokoro|whisper)/i

/**
 * Clamp one numeric config value.
 * @param value - raw config value.
 * @param fallback - value used when the input is not finite.
 * @param min - lowest accepted value.
 * @param max - highest accepted value.
 */
export function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Strip trailing slashes so endpoint building is predictable.
 * @param value - base URL as configured.
 */
export function baseUrl (value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Walk one path through a settings value.
 * @param value - section root.
 * @param path - path segments from the provider directory.
 */
function follow (value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * Map one list with bounded concurrency, preserving order.
 * @param items - input items.
 * @param limit - maximum in flight.
 * @param fn - async mapper.
 * @returns the mapped values.
 */
async function mapLimited (items, limit, fn) {
  const output = new Array(items.length)
  let next = 0
  async function worker () {
    while (next < items.length) {
      const index = next++
      output[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

/**
 * Read a response body under a hard byte limit.
 * @param response - fetch response.
 * @param limit - largest accepted body.
 * @returns the buffered body.
 */
async function readCapped (response, limit) {
  if (response.body === null) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`response exceeds ${limit} bytes`)
      error.status = 502
      error.code = 'too-large'
      throw error
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Map an upstream status onto this proxy's status and code.
 * @param upstream - status the engine answered.
 */
function mappedStatus (upstream) {
  if (upstream === 401 || upstream === 403) return { status: 502, code: 'provider-auth' }
  if (upstream === 429) return { status: 429, code: 'provider-rate-limit' }
  if (upstream >= 500) return { status: 502, code: 'provider' }
  return { status: 400, code: 'provider-request' }
}

/**
 * Build the protocol engine bound to one host context.
 * @param ctx - host context carrying the settings and provider directories.
 * @param options - `DEFAULTS`-shaped, already clamped.
 */
export function createAudio (ctx, options) {
  /** Per-direction discovery state: last result, when it was taken, refused endpoints. */
  const state = {
    tts: { discovered: null, at: 0, failures: new Map() },
    stt: { discovered: null, at: 0, failures: new Map() },
  }
  /** The one in-flight discovery per direction. */
  const inflight = {}
  /** Credential variable per endpoint, so every request authenticates like discovery. */
  const authByEndpoint = new Map()

  /**
   * Every provider this Host can reach that the profile points at explicitly,
   * plus any endpoint listed in the engine's own config.
   * @returns unique candidates in provider order.
   */
  function candidates () {
    const found = []
    const seen = new Set()
    const add = (id, name, endpoint, apiKeyEnv) => {
      const normalized = baseUrl(endpoint ?? '')
      if (normalized === '') return
      if (seen.has(normalized)) return
      seen.add(normalized)
      authByEndpoint.set(normalized, typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined)
      found.push({ id, name: name ?? id, baseURL: normalized })
    }
    let entries = []
    try {
      entries = ctx.llm.listConfigurableProviders()
    } catch {
      entries = []
    }
    let values = new Map()
    try {
      values = new Map(ctx.settings.describe().map((descriptor) => [descriptor.ns, descriptor.value]))
    } catch {
      values = new Map()
    }
    for (const entry of entries) {
      const path = entry.settingsPath ?? []
      const root = values.get(entry.settingsNs)
      const profile = path.length === 0 ? root : follow(root, path)
      if (profile === null || typeof profile !== 'object') continue
      /* Explicit endpoint only. Falling back to the adapter's `defaultBaseURL`
         would probe cloud routes the profile never pointed this plugin at. */
      if (typeof profile.baseURL !== 'string' || profile.baseURL === '') continue
      add(entry.provider, entry.displayName, profile.baseURL, profile.apiKeyEnv)
    }
    for (const extra of options.endpoints) {
      if (extra !== null && typeof extra === 'object' && typeof extra.baseURL === 'string') {
        add(extra.id ?? extra.baseURL, extra.name, extra.baseURL, extra.apiKeyEnv)
      }
    }
    return found
  }

  /**
   * Request headers for one endpoint, including its credential when set.
   * The value never leaves the Host.
   * @param endpoint - provider base URL.
   * @param jsonBody - whether the request carries a JSON body.
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
   * @returns model ids, or null when the list cannot be read.
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
        .map((row) => (typeof row?.id === 'string' ? row.id : typeof row === 'string' ? row : undefined))
        .filter((id) => id !== undefined)
    } catch {
      return null
    }
  }

  /**
   * The capability test for one audio route: a deliberately empty JSON body is
   * sent. A handler rejects it (400/422/500), a non-audio server answers
   * 404/405/501.
   * @param kind - `tts` or `stt`.
   * @param endpoint - provider base URL.
   * @returns `yes`, `no`, or `unknown` (busy, slow, or absent).
   */
  async function supportsRoute (kind, endpoint) {
    const path = kind === 'tts' ? '/audio/speech' : '/audio/transcriptions'
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
      return 'unknown'
    }
  }

  /** Whether the provider also implements the voice listing of the audio API. */
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
   * @returns voice ids.
   */
  async function fetchVoices (endpoint, model) {
    try {
      const response = await fetch(`${endpoint}/audio/voices?model=${encodeURIComponent(model)}`, {
        headers: headersOf(endpoint),
        signal: AbortSignal.timeout(options.probeTimeoutMs),
      })
      if (!response.ok) return []
      const body = await response.json().catch(() => null)
      return Array.isArray(body?.voices) ? body.voices.filter((id) => typeof id === 'string' && id !== '') : []
    } catch {
      return []
    }
  }

  /**
   * Probe one candidate for one direction.
   * @param kind - `tts` or `stt`.
   * @param candidate - id, name, endpoint.
   * @returns the server row, or a refusal/transient reason.
   */
  async function probe (kind, candidate) {
    const capability = await supportsRoute(kind, candidate.baseURL)
    if (capability === 'no') return { server: null, reason: 'no-capability' }
    const models = await fetchModels(candidate.baseURL)
    if (models === null) return { server: null, reason: 'unavailable' }
    if (kind === 'stt') {
      const ordered = [...models].sort((left, right) => Number(AUDIO_NAME.test(right)) - Number(AUDIO_NAME.test(left)))
      return {
        server: { id: candidate.id, name: candidate.name, baseURL: candidate.baseURL, models: ordered },
        reason: null,
      }
    }
    const voices = await listsVoices(candidate.baseURL)
    const announced = await mapLimited(
      models.slice(0, options.voiceModels),
      options.voiceConcurrency,
      async (id) => ({ id, voices: voices ? await fetchVoices(candidate.baseURL, id) : [] }),
    )
    /* A model that announces voices can speak; the rest keep the server's order. */
    announced.sort((left, right) => Number(right.voices.length > 0) - Number(left.voices.length > 0))
    return {
      server: { id: candidate.id, name: candidate.name, baseURL: candidate.baseURL, models: announced },
      reason: null,
    }
  }

  /**
   * Discover the servers that serve one direction, reusing the last result until
   * it expires and never running two passes at once.
   * @param kind - `tts` or `stt`.
   * @param force - bypass the success TTL (the failure TTL is not bypassed).
   * @returns server rows in provider order.
   */
  function discover (kind, force = false) {
    const current = state[kind]
    if (!force && current.discovered !== null && Date.now() - current.at < options.discoveryTtlMs) {
      return Promise.resolve(current.discovered)
    }
    if (inflight[kind] !== undefined) return inflight[kind]
    inflight[kind] = (async () => {
      const candidatesNow = candidates()
      const live = new Set(candidatesNow.map((candidate) => candidate.baseURL))
      for (const endpoint of current.failures.keys()) if (!live.has(endpoint)) current.failures.delete(endpoint)
      const lastGood = new Map((current.discovered ?? []).map((server) => [server.baseURL, server]))
      const probes = candidatesNow.filter((candidate) => {
        const failedAt = current.failures.get(candidate.baseURL)
        return failedAt === undefined || Date.now() - failedAt > options.failureTtlMs
      })
      const results = await Promise.all(probes.map(async (candidate) => {
        const result = await probe(kind, candidate)
        if (result.server !== null) {
          current.failures.delete(candidate.baseURL)
          return result.server
        }
        if (result.reason === 'no-capability') {
          current.failures.set(candidate.baseURL, Date.now())
          return null
        }
        /* Transient (busy, loading, unreachable): keep what this endpoint offered
           before, and never cache the failure. */
        return lastGood.get(candidate.baseURL) ?? null
      }))
      const declared = kind === 'tts'
        ? (server) => server.models.some((model) => model.voices.length > 0)
        : (server) => server.models.some((id) => AUDIO_NAME.test(id))
      current.discovered = results
        .filter((server) => server !== null)
        .sort((left, right) => Number(declared(right)) - Number(declared(left)))
      current.at = Date.now()
      return current.discovered
    })().finally(() => { inflight[kind] = undefined })
    return inflight[kind]
  }

  /**
   * Resolve the server/model/voice a request means, honouring the calling row's
   * preferences. A model named without its server is looked up across every
   * provider, so a flat model list stays routable when two servers share a panel.
   * @param kind - `tts` or `stt`.
   * @param wanted - explicitly requested server, model, and voice.
   * @param preferences - the owning row's configured server/model/voice.
   * @returns the resolved selection, or null when nothing corresponds.
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
      server.models.find((row) => row.voices.length > 0) ??
      server.models.find((row) => SPEECH_NAME.test(row.id)) ??
      server.models[0]
    if (model === undefined) return null
    const voice = model.voices.find((id) => id === wanted.voice) ??
      model.voices.find((id) => id === preferences.voice) ??
      model.voices[0] ?? null
    return { server, model, voice }
  }

  /**
   * Build the error one refused upstream request answers.
   * @param response - the refused fetch response.
   * @param what - what the call was, for the fallback message.
   */
  async function failureOf (response, what) {
    const detail = (await readCapped(response, 8192)).toString('utf8').trim()
    let message = detail.slice(0, 400) || `${what} answered ${response.status}`
    try {
      const parsed = JSON.parse(detail)
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 400)
    } catch { /* not a JSON error body */ }
    const { status, code } = mappedStatus(response.status)
    const error = new Error(message)
    error.status = status
    error.code = code
    return error
  }

  /**
   * POST one synthesis and buffer the audio.
   * @param endpoint - engine base URL.
   * @param text - prose to synthesize.
   * @param model - engine model id.
   * @param voice - engine voice id, or null for the model's own default.
   * @param speed - speaking rate.
   * @returns buffered audio and its media type.
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
    const body = await readCapped(response, options.maxResponseBytes)
    if (body.length === 0) {
      const error = new Error('speech server returned no audio')
      error.status = 502
      error.code = 'empty'
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
   * @returns the provider's text.
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
    if (!response.ok) throw await failureOf(response, 'transcription server')
    const raw = (await readCapped(response, 1024 * 1024)).toString('utf8')
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed?.text === 'string' ? parsed.text : ''
    } catch {
      /* Providers without response_format support may answer plain text. */
      return raw.trim()
    }
  }

  return { discover, resolve, speak, transcribe }
}
