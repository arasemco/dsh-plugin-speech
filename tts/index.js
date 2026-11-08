/**
 * dsh-plugin-speech — the read-aloud surface (`speech-tts`).
 *
 *   GET  /tts/info   → discovered speech servers, their models and voices, defaults
 *   POST /tts/speak  → { text, server?, model?, voice?, speed? } → audio/wav bytes
 *
 * The browser never reaches an engine directly: no CORS, the engine stays bound
 * where the profile put it, and any browser that can open the GUI can listen.
 * Discovery, the wire call, and credential handling belong to the engine row.
 */
import { number } from '../lib/audio.js'
import { bodyError, json, readJson, routes } from '../lib/http.js'

/** Read-aloud defaults; no server, model, or voice is assumed. */
const DEFAULTS = {
  server: null,
  model: null,
  voice: null,
  speed: 1,
  speeds: [0.75, 1, 1.25, 1.5, 2],
  maxChars: 4000,
}

/** Required host services: routes and the shared audio engine. */
export const inject = ['webServer', 'speechAudio']

/**
 * Mount the read-aloud routes.
 * @param ctx - host context carrying the web server and the audio engine.
 * @param config - preferred server/model/voice, offered rates, and the text ceiling.
 */
export function apply (ctx, config = {}) {
  const audio = ctx.speechAudio
  const prefs = {
    server: typeof config.server === 'string' && config.server !== '' ? config.server : null,
    model: typeof config.model === 'string' && config.model !== '' ? config.model : null,
    voice: typeof config.voice === 'string' && config.voice !== '' ? config.voice : null,
  }
  const speed = number(config.speed, DEFAULTS.speed, 0.25, 4)
  const speeds = Array.isArray(config.speeds) && config.speeds.length > 0
    ? config.speeds.map((value) => number(value, DEFAULTS.speed, 0.25, 4))
    : [...DEFAULTS.speeds]
  const maxChars = number(config.maxChars, DEFAULTS.maxChars, 1, 20000)

  /**
   * Discovered servers, their models and voices, and the defaults for the panel.
   */
  async function infoRoute (req, res, url) {
    const servers = await audio.discover('tts', url.searchParams.get('refresh') === '1')
    const fallback = audio.resolve('tts', {}, prefs)
    return json(res, 200, {
      servers: servers.map((server) => ({ id: server.id, name: server.name, baseURL: server.baseURL, models: server.models })),
      defaults: {
        server: fallback?.server.id ?? null,
        model: fallback?.model.id ?? null,
        voice: fallback?.voice ?? null,
        speed,
      },
      speeds,
      maxChars,
    })
  }

  /**
   * One synthesis: validate the text, select the engine, answer the audio.
   */
  async function speakRoute (req, res) {
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return bodyError(res, error)
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') return json(res, 400, { error: { code: 'text', message: 'text is required' } })
    if (text.length > maxChars) {
      return json(res, 413, { error: { code: 'text', message: `text exceeds ${maxChars} characters` } })
    }
    await audio.discover('tts')
    const chosen = audio.resolve('tts', {
      server: typeof body.server === 'string' && body.server !== '' ? body.server : undefined,
      model: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
      voice: typeof body.voice === 'string' && body.voice !== '' ? body.voice : undefined,
    }, prefs)
    if (chosen === null) {
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
    }
    const rate = number(body.speed, speed, 0.25, 4)
    try {
      const audioOut = await audio.speak(chosen.server.baseURL, text, chosen.model.id, chosen.voice, rate)
      res.writeHead(200, {
        'content-type': audioOut.type,
        'content-length': audioOut.body.length,
        'cache-control': 'no-store',
        'x-tts-server': chosen.server.id,
        'x-tts-model': chosen.model.id,
      })
      return res.end(audioOut.body)
    } catch (error) {
      return json(res, error.status ?? 502, {
        error: { code: error.code ?? 'speech', message: String(error.message ?? error).slice(0, 400) },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/tts',
    handler: routes([
      { path: '/tts/info', method: 'GET', handle: infoRoute },
      { path: '/tts/speak', method: 'POST', handle: speakRoute },
    ]),
  }), 'dsh-plugin-speech: /tts routes')
}
