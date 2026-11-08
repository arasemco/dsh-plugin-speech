/**
 * dsh-plugin-speech — the inventory component (`audio-status`).
 *
 * The row that makes the bundle's component structure visible and testable:
 *
 *   GET  /audio/status → the components currently mounted, and what discovery
 *                        has learned so far without triggering a probe
 *   POST /audio/echo   → speak a sentence with the read-aloud engine, then
 *                        transcribe it back; the bundle testing itself
 *
 * Both routes work off the `audioProtocol` service, so they exist whenever this
 * row does — independently of whether the `tts` and `stt` route rows are on.
 */

import { readFile } from 'node:fs/promises'

import z from '@deepseek-ai/schemastery'

import { liveOptions } from '../lib/config.js'
import { json, readJson, bodyError, routes } from '../lib/http.js'

/** This package's own manifest, so the inventory reports the installed version. */
const MANIFEST = new URL('../package.json', import.meta.url)

/** The sentence the round-trip test speaks when the request names none. */
const SAMPLE = 'The audio bundle is reading this sentence and hearing it back.'

/** The component record the inventory row reports while this row is mounted. */
const COMPONENT = {
  id: 'status',
  order: 40,
  title: 'Bundle inventory and round-trip test',
  description: 'Reports the mounted components and speaks a sentence back through dictation',
  routes: ['/audio/status', '/audio/echo'],
}

/**
 * This row's config schema: the sentence the round-trip test speaks. It is
 * `.volatile()` because the settings service publishes only volatile fields.
 */
export const Config = z.object({
  sample: z.string().default(SAMPLE).description('Sentence the round-trip test speaks when the request names none').volatile(),
})

/** Required Host services: routes and the bundle's protocol service. */
export const inject = ['webServer', 'audioProtocol']

/** Loaded once: the package name and version this bundle reports. */
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
 * Mount the inventory routes.
 * @param ctx - Host context carrying the web server and the audio protocol service.
 * @param config - Optional sample sentence for the round-trip test.
 */
export function apply (ctx, config = {}) {
  const protocol = ctx.audioProtocol
  /* The sentence is a live reference: a settings write changes it without a restart. */
  const options = liveOptions(config, { sample: SAMPLE }, {
    sample: (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 400) : fallback),
  })

  /** Write one event to the bundle log, tagged as this component. */
  function note (level, event, detail) {
    protocol.note('status', level, event, detail)
  }

  /**
   * Which components the profile composed, which providers discovery knows, and
   * the log counts — all without probing anything.
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

  note('info', 'ready', { sample: options.sample.length })

  const handler = routes([
    { path: '/audio/status', method: 'GET', handle: statusRoute },
    { path: '/audio/echo', method: 'POST', handle: echoRoute, body: 'json' },
  ])
  for (const path of COMPONENT.routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), `dsh-plugin-speech: ${path} route`)
  }
  ctx.effect(() => protocol.registerComponent(COMPONENT), 'dsh-plugin-speech: status component record')
}
