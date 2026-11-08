/**
 * dsh-plugin-speech — the read-aloud component (`speech-tts`).
 *
 * The browser never reaches a speech engine directly (no CORS, works from any
 * browser that can open the GUI, keeps engines on loopback):
 *
 *   GET  /tts/info    → discovered speech servers, their models and voices
 *   POST /tts/speak   → { text, server?, model?, voice?, speed? } → audio/wav bytes
 *   GET/POST /tts/cast → the multi-voice experiment flag the Host mirrors
 *
 * Discovery, the wire call, and the event log belong to the `speech-core` row and
 * arrive as the `audioProtocol` service; this row owns the read-aloud surface,
 * its preferences, and its audio cache.
 */

import { createHash } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { liveOptions, number, numbers } from '../lib/config.js'
import { bodyError, json, readJson, routes } from '../lib/http.js'

/** Read-aloud defaults; no server, model, or voice is assumed. */
const DEFAULTS = {
  /** Preferred server/model/voice; unset means "first discovered". */
  server: null,
  model: null,
  voice: null,
  /** Speaking rate applied when a request names none. */
  speed: 1,
  /** Rates offered by the GUI; the player applies them without new synthesis. */
  speeds: [0.75, 1, 1.25, 1.5, 2],
  /** Upper bound for one synthesis request; the GUI splits longer replies. */
  maxChars: 4000,
  /** Total bytes of synthesized audio kept for instant re-listening. */
  cacheBytes: 24 * 1024 * 1024,
}

/**
 * The instruction injected while the multi-voice experiment is on. It rides the
 * system prompt, so the operator's own message is never modified.
 */
const CAST_INSTRUCTION = [
  '## Reading aloud with several voices',
  'A text-to-speech experiment is active: this reply may be read by more than one voice.',
  '- Write as a small cast only when the content genuinely has several voices — a dialogue, an interview, a review with distinct roles. Otherwise keep one narrator voice.',
  '- In a cast, put each speaker at the start of a line as `Name: sentence`, with two to four short, distinct names, and prefer several short labelled turns over one long block.',
  '- Never label ordinary prose, code, or lists: the narrator reads everything unlabelled.',
].join('\n')

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'tts',
  order: 20,
  title: 'Read replies aloud',
  description: 'Speaks the discovered speech engine into a seekable player',
  routes: ['/tts/info', '/tts/speak', '/tts/cast'],
}

/**
 * This row's config schema: the read-aloud preferences. The fields the row's
 * configuration page edits are `.volatile()` because the settings service
 * publishes only volatile fields; a schema with none gets no form. Range
 * enforcement stays in `apply`.
 */
export const Config = z.object({
  server: z.union([z.string(), z.const(null)]).default(DEFAULTS.server).description('Preferred server id; unset means the first discovered').volatile(),
  model: z.union([z.string(), z.const(null)]).default(DEFAULTS.model).description('Preferred model id; unset means the first discovered').volatile(),
  voice: z.union([z.string(), z.const(null)]).default(DEFAULTS.voice).description('Preferred voice id or label; unset means the engine default').volatile(),
  speed: z.number().default(DEFAULTS.speed).description('Speaking rate applied when a request names none').volatile(),
  speeds: z.array(z.number()).default([...DEFAULTS.speeds]).description('Rates offered by the player'),
  maxChars: z.natural().default(DEFAULTS.maxChars).description('Longest text one synthesis request accepts').volatile(),
  cacheBytes: z.natural().default(DEFAULTS.cacheBytes).description('Bytes of synthesized audio kept for instant replay'),
})

/** Required Host services: routes and the bundle's protocol service. */
export const inject = ['webServer', 'audioProtocol']

/**
 * Mount the read-aloud routes and the multi-voice experiment.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Preferences, rate list, request ceiling, and cache budget.
 */
export function apply (ctx, config = {}) {
  /* The page's fields are live references; every read below clamps what the
     settings service last accepted, without a row restart. */
  const options = liveOptions(config, DEFAULTS, {
    speed: (value, fallback) => number(value, fallback, 0.25, 4),
    speeds: (value, fallback) => numbers(value, fallback),
    maxChars: (value, fallback) => number(value, fallback, 1, 20000),
    cacheBytes: (value, fallback) => number(value, fallback, 0, 512 * 1024 * 1024),
  })
  const protocol = ctx.audioProtocol

  /** Synthesized-audio cache: key → audio. Insertion order doubles as LRU order. */
  const cache = new Map()
  let cacheBytes = 0
  /** Whether the multi-voice experiment is on, as the browser last reported it. */
  let castEnabled = false

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('tts', level, event, detail)
  }

  /** Drop the oldest entries until the budget holds again. */
  function evict () {
    while (cacheBytes > options.cacheBytes && cache.size > 0) {
      const [key, entry] = cache.entries().next().value
      cache.delete(key)
      cacheBytes -= entry.body.length
    }
  }

  /**
   * Resolve one request against the discovered servers.
   * @param wanted - explicitly requested server, model, and voice.
   * @returns The resolved selection, or null when nothing corresponds.
   */
  function choose (wanted = {}) {
    return protocol.resolve('tts', wanted, {
      server: options.server ?? undefined,
      model: options.model ?? undefined,
      voice: options.voice ?? undefined,
    })
  }

  /**
   * Synthesize one request, serving the buffered audio when it is already known.
   * @param chosen - the resolved server/model/voice.
   * @param text - prose to synthesize.
   * @param speed - speaking rate.
   * @returns Audio, its type, and whether it came from the cache.
   */
  async function synthesize (chosen, text, speed) {
    const key = createHash('sha256')
      .update(`${chosen.server.baseURL}\u0000${chosen.model.id}\u0000${chosen.voice?.id ?? ''}\u0000${speed}\u0000${text}`)
      .digest('hex')
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return { ...hit, cached: true }
    }
    const audio = await protocol.speak(chosen.server.baseURL, text, chosen.model.id, chosen.voice?.id ?? null, speed)
    if (options.cacheBytes > 0 && audio.body.length <= options.cacheBytes) {
      cache.set(key, audio)
      cacheBytes += audio.body.length
      evict()
    }
    return { ...audio, cached: false }
  }

  /**
   * Discovered servers, their models and voices, and the defaults for the panel.
   * @param res - node response.
   * @param url - parsed request URL.
   * @returns The response that was sent.
   */
  async function infoRoute (req, res, url) {
    const servers = await protocol.discover('tts', url.searchParams.get('refresh') === '1')
    const fallback = choose()
    return json(res, 200, {
      /* Ordering hints stay on the Host; the browser sees only what it renders. */
      servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
      defaults: {
        server: fallback?.server.id ?? null,
        model: fallback?.model.id ?? null,
        voice: fallback?.voice?.id ?? null,
        speed: options.speed,
      },
      speeds: options.speeds,
      maxChars: options.maxChars,
      component: COMPONENT.id,
    })
  }

  /**
   * The multi-voice experiment flag: the browser mirrors it, the Host owns the
   * prompt section that follows from it.
   * @param req - node request.
   * @param res - node response.
   * @returns The response that was sent.
   */
  async function castRoute (req, res) {
    if (req.method === 'POST') {
      let body
      try {
        body = await readJson(req, 2048)
      } catch (error) {
        return bodyError(res, error)
      }
      const enabled = body?.enabled === true
      if (enabled !== castEnabled) {
        castEnabled = enabled
        note('info', enabled ? 'cast-enabled' : 'cast-disabled')
      }
      return json(res, 200, { enabled: castEnabled })
    }
    if (req.method === 'GET') return json(res, 200, { enabled: castEnabled })
    return json(res, 405, { error: { code: 'method', message: 'GET or POST /tts/cast' } })
  }

  /**
   * One synthesis: validate the text, select the engine, answer the audio.
   * @param req - node request.
   * @param res - node response.
   * @returns The response that was sent.
   */
  async function speakRoute (req, res) {
    let body
    try {
      body = await readJson(req, 64 * 1024)
    } catch (error) {
      return bodyError(res, error)
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') return json(res, 400, { error: { code: 'text', message: 'text is required' } })
    if (text.length > options.maxChars) {
      return json(res, 413, { error: { code: 'text', message: `text exceeds ${options.maxChars} characters` } })
    }
    await protocol.discover('tts')
    const chosen = choose({
      server: typeof body.server === 'string' && body.server !== '' ? body.server : undefined,
      model: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
      voice: typeof body.voice === 'string' && body.voice !== '' ? body.voice : undefined,
    })
    if (chosen === null) {
      note('warn', 'no-speech-model', { requested: { server: body.server ?? null, model: body.model ?? null } })
      return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
    }
    const speed = number(body.speed, options.speed, 0.25, 4)
    try {
      const audio = await synthesize(chosen, text, speed)
      if (audio.cached) note('debug', 'synthesis-cache-hit', { model: chosen.model.id, chars: text.length })
      res.writeHead(200, {
        'content-type': audio.type,
        'content-length': audio.body.length,
        'cache-control': 'no-store',
        'x-tts-server': chosen.server.id,
        'x-tts-model': chosen.model.id,
        'x-tts-cache': audio.cached ? 'hit' : 'miss',
      })
      return res.end(audio.body)
    } catch (error) {
      note('error', 'synthesis-failed', {
        provider: chosen.server.id,
        model: chosen.model.id,
        voice: chosen.voice?.id ?? null,
        chars: text.length,
        status: error.status ?? 502,
        message: String(error.message ?? error).slice(0, 240),
      })
      return json(res, error.status ?? 502, { error: { code: 'speech', message: error.message } })
    }
  }

  /* Optional service: the routes above work even when no prompt registry exists. */
  ctx.inject?.(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dsh-audio-cast',
      order: 950,
      text: () => (castEnabled ? CAST_INSTRUCTION : ''),
    }), 'dsh-plugin-speech: multi-voice instruction')
    note('info', 'cast-instruction-registered', { chars: CAST_INSTRUCTION.length })
  })

  note('info', 'ready', {
    model: options.model,
    cacheBytes: options.cacheBytes,
    maxChars: options.maxChars,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/tts',
    handler: routes([
      { path: '/tts/info', method: 'GET', handle: infoRoute },
      { path: '/tts/cast', method: '*', handle: castRoute, body: 'json' },
      { path: '/tts/speak', method: 'POST', handle: speakRoute, body: 'json' },
    ]),
  }), 'dsh-plugin-speech: /tts routes')
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-speech: tts component record')
}
