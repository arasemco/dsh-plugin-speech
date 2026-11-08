/**
 * dsh-plugin-speech — the dictation surface (`speech-stt`).
 *
 *   GET  /stt/info       → providers that accept transcriptions, and every model they list
 *   POST /stt/transcribe → WAV in, { text } out, via <provider>/audio/transcriptions
 *
 * Nothing is transcribed here: the recording is forwarded to a provider that
 * implements the OpenAI transcription API, and the text it produced is returned.
 * Discovery, the wire call, and credential handling belong to the engine row.
 */
import { number } from '../lib/audio.js'
import { bodyError, json, readBody, routes } from '../lib/http.js'

/** Dictation defaults; no server, model, or language is assumed. */
const DEFAULTS = {
  server: null,
  model: null,
  language: null,
  maxAudioBytes: 32 * 1024 * 1024,
}

/** Language hints offered by the GUI; the provider decides what it supports. */
const LANGUAGES = ['auto', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'zh', 'ja', 'ko', 'yue']

/** Smallest body that can be a recording rather than a truncated upload. */
const MIN_AUDIO_BYTES = 1600

/** Required host services: routes and the shared audio engine. */
export const inject = ['webServer', 'speechAudio']

/**
 * Mount the dictation routes.
 * @param ctx - host context carrying the web server and the audio engine.
 * @param config - preferred provider/model, language hint, and the recording ceiling.
 */
export function apply (ctx, config = {}) {
  const audio = ctx.speechAudio
  const prefs = {
    server: typeof config.server === 'string' && config.server !== '' ? config.server : null,
    model: typeof config.model === 'string' && config.model !== '' ? config.model : null,
  }
  const language = typeof config.language === 'string' && config.language !== '' ? config.language : null
  const maxAudioBytes = number(config.maxAudioBytes, DEFAULTS.maxAudioBytes, 1024, 512 * 1024 * 1024)

  /** Providers that accept transcriptions, their models, and the defaults. */
  async function infoRoute (req, res, url) {
    const servers = await audio.discover('stt', url.searchParams.get('refresh') === '1')
    const fallback = audio.resolve('stt', {}, prefs)
    return json(res, 200, {
      servers: servers.map((server) => ({ id: server.id, name: server.name, baseURL: server.baseURL, models: server.models })),
      defaults: { server: fallback?.server.id ?? null, model: fallback?.model ?? null },
      languages: LANGUAGES,
    })
  }

  /** One transcription: take the recording, select the provider, answer the text. */
  async function transcribeRoute (req, res, url) {
    const type = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!type.startsWith('audio/')) {
      return json(res, 415, { error: { code: 'type', message: 'content-type must be audio/*' } })
    }
    await audio.discover('stt')
    const chosen = audio.resolve('stt', {
      server: url.searchParams.get('server') ?? undefined,
      model: url.searchParams.get('model') ?? undefined,
    }, prefs)
    if (chosen === null) {
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
    }
    const requested = url.searchParams.get('language') ?? language
    const hint = requested === null || requested === undefined || requested === '' || requested === 'auto' ? null : requested
    let body
    try {
      body = await readBody(req, maxAudioBytes, 'recording is too large')
    } catch (error) {
      return bodyError(res, error)
    }
    if (body.length === 0) return json(res, 400, { error: { code: 'body', message: 'no audio received' } })
    if (body.length < MIN_AUDIO_BYTES) return json(res, 400, { error: { code: 'audio', message: 'recording is too short' } })
    try {
      const started = Date.now()
      const text = await audio.transcribe(chosen.server.baseURL, chosen.model, body, hint)
      return json(res, 200, {
        text: text.trim(),
        server: chosen.server.id,
        model: chosen.model,
        language: hint ?? 'auto',
        ms: Date.now() - started,
      })
    } catch (error) {
      return json(res, error.status ?? 502, {
        error: { code: error.code ?? 'transcribe', message: String(error.message ?? error).slice(0, 400) },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/stt',
    handler: routes([
      { path: '/stt/info', method: 'GET', handle: infoRoute },
      { path: '/stt/transcribe', method: 'POST', handle: transcribeRoute },
    ]),
  }), 'dsh-plugin-speech: /stt routes')
}
