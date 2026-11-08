/**
 * dsh-plugin-speech — the dictation component (`speech-stt`).
 *
 * Same shape as the read-aloud row, in the other direction: nothing is
 * transcribed here. The recording is forwarded to a provider that implements the
 * OpenAI transcription API and the text it produced is returned.
 *
 *   GET  /stt/info       → providers that can transcribe, and every model they list
 *   POST /stt/transcribe → WAV in, { text } out, via <provider>/audio/transcriptions
 *
 * Discovery, the wire call, and the event log belong to the `speech-core` row and
 * arrive as the `audioProtocol` service; this row owns the dictation surface and
 * its limits.
 */

import z from '@deepseek-ai/schemastery'

import { liveOptions, number } from '../lib/config.js'
import { bodyError, json, readBody, routes } from '../lib/http.js'

/** Dictation defaults; no server, model, or language is assumed. */
const DEFAULTS = {
  /** Preferred provider/model; unset means "first discovered". */
  server: null,
  model: null,
  /** Language hint; unset sends none and lets the model detect it. */
  language: null,
  /** Largest accepted recording. */
  maxAudioBytes: 32 * 1024 * 1024,
}

/** Language hints offered by the GUI; the provider decides what it supports. */
const LANGUAGES = ['auto', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'zh', 'ja', 'ko', 'yue']

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'stt',
  order: 30,
  title: 'Dictate instead of typing',
  description: 'Records the microphone on the Host and transcribes it with the discovered provider',
  routes: ['/stt/info', '/stt/transcribe'],
}

/**
 * This row's config schema: the dictation preferences. The fields the row's
 * configuration page edits are `.volatile()` because the settings service
 * publishes only volatile fields; a schema with none gets no form. Range
 * enforcement stays in `apply`.
 */
export const Config = z.object({
  server: z.union([z.string(), z.const(null)]).default(DEFAULTS.server).description('Preferred provider id; unset means the first discovered').volatile(),
  model: z.union([z.string(), z.const(null)]).default(DEFAULTS.model).description('Preferred model id; unset means the first discovered').volatile(),
  language: z.union([z.string(), z.const(null)]).default(DEFAULTS.language).description('Language hint, or null to let the model detect it').volatile(),
  maxAudioBytes: z.natural().default(DEFAULTS.maxAudioBytes).description('Largest accepted recording').volatile(),
})

/** Required Host services: routes and the bundle's protocol service. */
export const inject = ['webServer', 'audioProtocol']

/**
 * Mount the dictation routes.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Preferences and the accepted recording size.
 */
export function apply (ctx, config = {}) {
  /* The page's fields are live references; every read below clamps what the
     settings service last accepted, without a row restart. */
  const options = liveOptions(config, DEFAULTS, {
    maxAudioBytes: (value, fallback) => number(value, fallback, 1024, 512 * 1024 * 1024),
  })
  const protocol = ctx.audioProtocol

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('stt', level, event, detail)
  }

  /**
   * Resolve one request against the discovered providers.
   * @param wanted - explicitly requested provider and model.
   * @returns The resolved pair, or null when nothing corresponds.
   */
  function choose (wanted = {}) {
    return protocol.resolve('stt', wanted, {
      server: options.server ?? undefined,
      model: options.model ?? undefined,
    })
  }

  /**
   * Providers that accept transcriptions, their models, and the defaults.
   * @param res - node response.
   * @param url - parsed request URL.
   * @returns The response that was sent.
   */
  async function infoRoute (req, res, url) {
    const servers = await protocol.discover('stt', url.searchParams.get('refresh') === '1')
    const fallback = choose()
    return json(res, 200, {
      servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
      defaults: { server: fallback?.server.id ?? null, model: fallback?.model ?? null },
      languages: LANGUAGES,
      component: COMPONENT.id,
    })
  }

  /**
   * One transcription: take the recording, select the provider, answer the text.
   * @param req - node request.
   * @param res - node response.
   * @param url - parsed request URL.
   * @returns The response that was sent.
   */
  async function transcribeRoute (req, res, url) {
    await protocol.discover('stt')
    const chosen = choose({
      server: url.searchParams.get('server') ?? undefined,
      model: url.searchParams.get('model') ?? undefined,
    })
    if (chosen === null) {
      note('warn', 'no-speech-model', { providers: 0 })
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
    }
    const requested = url.searchParams.get('language') ?? options.language
    const language = requested === null || requested === undefined || requested === '' || requested === 'auto' ? null : requested
    let body
    try {
      body = await readBody(req, options.maxAudioBytes, 'recording is too large')
    } catch (error) {
      return bodyError(res, error)
    }
    if (body.length === 0) return json(res, 400, { error: { code: 'body', message: 'no audio received' } })
    /* The browser transcodes to WAV before uploading; anything else is not a
       recording this route can forward. */
    const riff = body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WAVE'
    if (!riff) return json(res, 400, { error: { code: 'audio', message: 'recording must be a WAV file' } })
    if (body.length < 1600) return json(res, 400, { error: { code: 'audio', message: 'recording is too short' } })
    try {
      const started = Date.now()
      const text = await protocol.transcribe(chosen.server.baseURL, chosen.model, body, language)
      const ms = Date.now() - started
      note('info', 'transcribed', {
        provider: chosen.server.id,
        model: chosen.model,
        chars: text.trim().length,
        bytes: body.length,
        language: language ?? 'auto',
        ms,
      })
      return json(res, 200, { text: text.trim(), server: chosen.server.id, model: chosen.model, ms })
    } catch (error) {
      note('error', 'transcription-failed', {
        provider: chosen.server.id,
        model: chosen.model,
        bytes: body.length,
        language: language ?? 'auto',
        status: error.status ?? 502,
        message: String(error.message ?? error).slice(0, 240),
      })
      return json(res, error.status ?? 502, { error: { code: 'transcribe', message: error.message } })
    }
  }

  note('info', 'ready', {
    maxAudioBytes: options.maxAudioBytes,
    language: options.language,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/stt',
    handler: routes([
      { path: '/stt/info', method: 'GET', handle: infoRoute },
      { path: '/stt/transcribe', method: 'POST', handle: transcribeRoute, body: 'audio' },
    ]),
  }), 'dsh-plugin-speech: /stt routes')
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-speech: stt component record')
}
