/**
 * Host-side tests for dsh-plugin-speech: the engine against fake OpenAI audio
 * servers, and the two route rows driven end-to-end over a real HTTP listener.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { DEFAULTS, baseUrl, createAudio, number } from '../lib/audio.js'
import { apply as applyEngine } from '../index.js'
import { apply as applyTts } from '../tts/index.js'
import { apply as applyStt } from '../stt/index.js'

/* ------------------------------------------------------------------ harness */

/**
 * A fake OpenAI-compatible audio server.
 * @param spec - route behaviour, models, voices, delays, and response sizes.
 * @returns its base URL plus recorded requests and a close handle.
 */
async function fakeEngine (spec = {}) {
  const received = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      received.push({ path, method: req.method, type: req.headers['content-type'] ?? '', auth: req.headers.authorization ?? null })
      const delay = spec.delayMs ?? 0
      setTimeout(() => {
        if (path === '/models') {
          if (spec.modelsStatus !== undefined && spec.modelsStatus !== 200) {
            res.writeHead(spec.modelsStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'models failed' } }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            data: (spec.models ?? ['kokoro']).map((id) => ({ id })),
          }))
          return
        }
        if (path === '/audio/voices') {
          if (spec.voices === false) {
            res.writeHead(404).end()
            return
          }
          const model = url.searchParams.get('model')
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            voices: spec.voicesByModel?.[model] ?? [],
          }))
          return
        }
        if (path === '/audio/speech') {
          if (spec.speech === false) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no speech' } }))
            return
          }
          if (spec.speechStatus !== undefined && spec.speechStatus !== 200) {
            res.writeHead(spec.speechStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'refused' } }))
            return
          }
          if (spec.speechBytes !== undefined) {
            res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.alloc(spec.speechBytes, 1))
            return
          }
          res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from('RIFF....WAVEfmt '))
          return
        }
        if (path === '/audio/transcriptions') {
          if (spec.transcriptions === false) {
            res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no transcriptions' } }))
            return
          }
          if (spec.transcriptStatus !== undefined && spec.transcriptStatus !== 200) {
            res.writeHead(spec.transcriptStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'refused' } }))
            return
          }
          const multipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            text: multipart ? (spec.transcript ?? '  transcribed text  ') : 'not multipart',
          }))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no route' } }))
      }, delay)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `${baseUrl(`http://127.0.0.1:${server.address().port}`)}/v1`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * A fake host context whose provider directory lists the given providers.
 * A provider entry is `{ baseURL }` for a configured endpoint, or
 * `{ defaultBaseURL }` for an adapter default the profile does not point at.
 * @param providers - provider key to profile facts.
 * @returns a Cordis-shaped context.
 */
function engineCtx (providers) {
  const settings = {
    providers: Object.fromEntries(Object.entries(providers).map(([key, facts]) => [key, facts.baseURL === undefined ? {} : { baseURL: facts.baseURL, ...(facts.apiKeyEnv === undefined ? {} : { apiKeyEnv: facts.apiKeyEnv }) }])),
  }
  return {
    llm: {
      listConfigurableProviders: () => Object.entries(providers).map(([provider, facts]) => ({
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
        ...(facts.defaultBaseURL === undefined ? {} : { defaultBaseURL: facts.defaultBaseURL }),
      })),
    },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: settings }] },
  }
}

/** Engine options with the TTL knocked out, so a test drives discovery directly. */
function options (overrides = {}) {
  return { ...DEFAULTS, discoveryTtlMs: 0, failureTtlMs: 300000, probeTimeoutMs: 2000, ...overrides }
}

/**
 * Mount the three rows on one fake host and serve their routes over HTTP.
 * @param providers - provider directory the engine reads.
 * @param config - per-row config: `speech`, `tts`, `stt`.
 * @returns the origin plus a close handle.
 */
async function mountSpeech (providers, config = {}) {
  const routes = new Map()
  const services = {}
  const make = () => ({
    effect: (fn) => fn(),
    provide: (name, value) => { services[name] = value; return () => { delete services[name] } },
    webServer: {
      register: (route) => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    llm: { listConfigurableProviders: () => engineCtx(providers).llm.listConfigurableProviders() },
    settings: { describe: () => engineCtx(providers).settings.describe() },
    logger: { warn () {}, error () {}, debug () {} },
  })
  applyEngine(make(), config.speech ?? {})
  const ttsCtx = make()
  ttsCtx.speechAudio = services.speechAudio
  applyTts(ttsCtx, config.tts ?? {})
  const sttCtx = make()
  sttCtx.speechAudio = services.speechAudio
  applyStt(sttCtx, config.stt ?? {})
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = [...routes.entries()]
      .filter(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`))
      .sort((left, right) => right[0].length - left[0].length)[0]
    if (match === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'route' } }))
      return
    }
    match[1].handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** POST/GET one route on the mounted host. */
async function request (origin, path, init = {}) {
  const response = await fetch(`${origin}${path}`, init)
  const buffer = Buffer.from(await response.arrayBuffer())
  let json
  try {
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    json = undefined
  }
  return { response, buffer, json }
}

/* ------------------------------------------------------------------ engine */

test('only a provider with an explicit baseURL is probed', async () => {
  const configured = await fakeEngine({ speech: true, models: ['kokoro'] })
  const cloudDefault = await fakeEngine({ speech: true, models: ['tts-1'] })
  try {
    const audio = createAudio(engineCtx({
      local: { baseURL: configured.baseURL },
      cloud: { defaultBaseURL: cloudDefault.baseURL },
    }), options())
    const servers = await audio.discover('tts')
    assert.deepEqual(servers.map((server) => server.id), ['local'])
    assert.equal(cloudDefault.received.length, 0, 'the adapter default endpoint is never contacted')
  } finally {
    await configured.close()
    await cloudDefault.close()
  }
})

test('a credential named by the profile authenticates every probe', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'] })
  process.env.DSH_TEST_AUDIO_KEY = 'secret'
  try {
    const audio = createAudio(engineCtx({ local: { baseURL: engine.baseURL, apiKeyEnv: 'DSH_TEST_AUDIO_KEY' } }), options())
    await audio.discover('tts')
    const probed = engine.received.filter((entry) => entry.path !== '/audio/voices')
    assert.ok(probed.length > 0)
    for (const entry of probed) assert.equal(entry.auth, 'Bearer secret')
  } finally {
    delete process.env.DSH_TEST_AUDIO_KEY
    await engine.close()
  }
})

test('a provider that refuses the speech route is cached as a refusal', async () => {
  const engine = await fakeEngine({ speech: false })
  try {
    const audio = createAudio(engineCtx({ local: { baseURL: engine.baseURL } }), options({ discoveryTtlMs: 0 }))
    assert.deepEqual(await audio.discover('tts'), [])
    assert.equal(engine.received.length, 1, 'the refusal is cached, not re-probed')
    assert.deepEqual(await audio.discover('tts'), [])
    assert.equal(engine.received.length, 1)
  } finally {
    await engine.close()
  }
})

test('a transient model-list failure keeps the last good provider', async () => {
  let failing = false
  const engine = createServer((req, res) => {
    if (failing) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'busy' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'kokoro' }] }))
  })
  await new Promise((resolve) => server_listen(engine, resolve))
  const base = `http://127.0.0.1:${engine.address().port}/v1`
  try {
    const audio = createAudio(engineCtx({ local: { baseURL: base } }), options())
    const first = await audio.discover('tts')
    assert.deepEqual(first.map((server) => server.id), ['local'])
    failing = true
    const second = await audio.discover('tts', true)
    assert.deepEqual(second.map((server) => server.id), ['local'], 'the provider survives a busy model list')
    assert.equal(second[0].models[0].id, 'kokoro', 'the last good models are kept')
  } finally {
    await new Promise((resolve) => engine.close(resolve))
  }
})

function server_listen (server, resolve) {
  server.listen(0, '127.0.0.1', resolve)
}

test('concurrent discovery runs one pass', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'], delayMs: 40 })
  try {
    const audio = createAudio(engineCtx({ local: { baseURL: engine.baseURL } }), options())
    const [left, right] = await Promise.all([audio.discover('tts'), audio.discover('tts')])
    assert.equal(left, right, 'the in-flight result is shared')
    const models = engine.received.filter((entry) => entry.path === '/models')
    assert.equal(models.length, 1, 'the model list is fetched once')
  } finally {
    await engine.close()
  }
})

test('a model named without its server routes across providers', async () => {
  const left = await fakeEngine({ speech: true, models: ['kokoro'] })
  const right = await fakeEngine({ speech: true, models: ['other-tts'] })
  try {
    const audio = createAudio(engineCtx({
      left: { baseURL: left.baseURL },
      right: { baseURL: right.baseURL },
    }), options())
    await audio.discover('tts')
    const chosen = audio.resolve('tts', { model: 'other-tts' })
    assert.equal(chosen.server.id, 'right')
    assert.equal(chosen.model.id, 'other-tts')
  } finally {
    await left.close()
    await right.close()
  }
})

test('a response larger than the engine budget is refused', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'], speechBytes: 4096 })
  try {
    const audio = createAudio(engineCtx({ local: { baseURL: engine.baseURL } }), options({ maxResponseBytes: 1024 }))
    await audio.discover('tts')
    await assert.rejects(
      () => audio.speak(engine.baseURL, 'hello', 'kokoro', null, 1),
      (error) => error.status === 502 && error.code === 'too-large',
    )
  } finally {
    await engine.close()
  }
})

/* ------------------------------------------------------------------ routes */

test('/tts/info reports servers, defaults, rates, and the text ceiling', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro', 'plain'], voicesByModel: { kokoro: ['af_heart', 'af_bella'] } })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } }, { tts: { maxChars: 1234 } })
  try {
    const { response, json } = await request(host.origin, '/tts/info?refresh=1')
    assert.equal(response.status, 200)
    assert.deepEqual(json.servers.map((server) => server.id), ['local'])
    assert.deepEqual(json.servers[0].models[0], { id: 'kokoro', voices: ['af_heart', 'af_bella'] })
    assert.equal(json.defaults.server, 'local')
    assert.equal(json.defaults.model, 'kokoro')
    assert.equal(json.defaults.voice, 'af_heart')
    assert.deepEqual(json.speeds, [0.75, 1, 1.25, 1.5, 2])
    assert.equal(json.maxChars, 1234)
  } finally {
    await host.close()
    await engine.close()
  }
})

test('/tts/speak answers audio with the selected engine in headers', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'] })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } }, { tts: { voice: 'af_bella' } })
  try {
    const { response, buffer } = await request(host.origin, '/tts/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ' hello there ' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/wav')
    assert.equal(response.headers.get('x-tts-server'), 'local')
    assert.equal(response.headers.get('x-tts-model'), 'kokoro')
    assert.deepEqual(buffer, Buffer.from('RIFF....WAVEfmt '))
    const spoken = engine.received.filter((entry) => entry.path === '/audio/speech')
    assert.ok(spoken.length > 0)
  } finally {
    await host.close()
    await engine.close()
  }
})

test('/tts/speak validates the request', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'] })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } }, { tts: { maxChars: 10 } })
  try {
    const wrongType = await request(host.origin, '/tts/speak', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    assert.equal(wrongType.response.status, 415)
    const empty = await request(host.origin, '/tts/speak', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }),
    })
    assert.equal(empty.response.status, 400)
    const tooLong = await request(host.origin, '/tts/speak', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(11) }),
    })
    assert.equal(tooLong.response.status, 413)
  } finally {
    await host.close()
    await engine.close()
  }
})

test('every route refuses a cross-site request', async () => {
  const host = await mountSpeech({}, {})
  try {
    const info = await request(host.origin, '/tts/info', {
      headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(info.response.status, 403)
    assert.equal(info.json.error.code, 'origin')
    const speak = await request(host.origin, '/tts/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ text: 'hi' }),
    })
    assert.equal(speak.response.status, 403)
  } finally {
    await host.close()
  }
})

test('an upstream auth refusal is reported as a provider failure, not a bad request', async () => {
  const engine = await fakeEngine({ speech: true, models: ['kokoro'], speechStatus: 401 })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } })
  try {
    const { response, json } = await request(host.origin, '/tts/speak', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    assert.equal(response.status, 502)
    assert.equal(json.error.code, 'provider-auth')
  } finally {
    await host.close()
    await engine.close()
  }
})

test('/stt/transcribe forwards the recording and returns the text', async () => {
  const engine = await fakeEngine({ transcriptions: true, models: ['lfm3-audio'] })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } })
  try {
    const info = await request(host.origin, '/stt/info?refresh=1')
    assert.equal(info.response.status, 200)
    assert.deepEqual(info.json.servers[0].models, ['lfm3-audio'])
    const recording = Buffer.alloc(2000, 7)
    const result = await request(host.origin, '/stt/transcribe?language=en', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: recording,
    })
    assert.equal(result.response.status, 200)
    assert.equal(result.json.text, 'transcribed text')
    const forwarded = engine.received.filter((entry) => entry.path === '/audio/transcriptions' && entry.method === 'POST')
    assert.ok(forwarded.some((entry) => entry.type.startsWith('multipart/form-data')))
  } finally {
    await host.close()
    await engine.close()
  }
})

test('/stt/transcribe validates type and length', async () => {
  const engine = await fakeEngine({ transcriptions: true, models: ['lfm3-audio'] })
  const host = await mountSpeech({ local: { baseURL: engine.baseURL } })
  try {
    const wrongType = await request(host.origin, '/stt/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(wrongType.response.status, 415)
    const tiny = await request(host.origin, '/stt/transcribe', {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100, 1),
    })
    assert.equal(tiny.response.status, 400)
  } finally {
    await host.close()
    await engine.close()
  }
})

test('an empty provider list answers a clear refusal', async () => {
  const host = await mountSpeech({})
  try {
    const info = await request(host.origin, '/tts/info')
    assert.deepEqual(info.json.servers, [])
    const speak = await request(host.origin, '/tts/speak', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    assert.equal(speak.response.status, 409)
    assert.equal(speak.json.error.code, 'no-speech-model')
  } finally {
    await host.close()
  }
})

test('unknown paths and methods answer JSON, not HTML', async () => {
  const host = await mountSpeech({})
  try {
    const unknown = await request(host.origin, '/tts/nope')
    assert.equal(unknown.response.status, 404)
    assert.equal(unknown.json.error.code, 'route')
    const method = await request(host.origin, '/tts/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(method.response.status, 405)
  } finally {
    await host.close()
  }
})
