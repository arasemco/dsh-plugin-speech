/**
 * Discovery rules of the `speech-core` row against fake engines: which configured
 * providers become speech servers for each direction, how their models and
 * voices are read, and what happens when a provider is down or is not a speech
 * server at all. The surface rows only forward what this report says.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isLocalEndpoint } from '../lib/protocol.js'
import { fakeEngine, mountAudio } from './harness.mjs'

/** Provider profiles keyed by provider id, as the profile stores them. */
const providersOf = (engine, id = 'speech') => ({ [id]: { api: 'openai-completions', baseURL: engine.baseURL } })

test('a TTS provider contributes its models and their voices', async () => {
  const engine = await fakeEngine({
    models: [
      { id: 'voice-a', task: 'tts', family: 'kokoro_tts' },
      { id: 'voice-b', task: 'tts', family: 'qwen3_tts' },
    ],
    voices: { 'voice-a': ['af_heart', 'am_michael'], 'voice-b': ['Vivian'] },
  })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [{
      id: 'speech',
      name: 'speech',
      baseURL: engine.baseURL,
      models: [
        {
          id: 'voice-a',
          label: 'voice-a',
          voices: [
            { id: 'af_heart', label: 'Heart', gender: 'female', language: 'en-us', category: null, default: false, description: null },
            { id: 'am_michael', label: 'Michael', gender: 'male', language: 'en-us', category: null, default: false, description: null },
          ],
        },
        {
          id: 'voice-b',
          label: 'voice-b',
          voices: [{ id: 'Vivian', label: 'Vivian', gender: null, language: null, category: null, default: false, description: null }],
        },
      ],
    }])
    assert.deepEqual(body.defaults, { server: 'speech', model: 'voice-a', voice: 'af_heart', speed: 1 })
    assert.equal(body.component, 'tts')

    const spoken = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', model: 'voice-b' }),
    })
    assert.equal(spoken.status, 200)
    assert.equal(spoken.headers.get('x-tts-model'), 'voice-b')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a provider without the audio route is not offered, whatever its models say', async () => {
  const engine = await fakeEngine({ speech: false, transcriptions: false, voices: false, models: [{ id: 'llama3.1:8b' }, { id: 'qwen3:8b' }] })
  const plugin = await mountAudio({ providers: providersOf(engine, 'ollama') })
  try {
    assert.deepEqual((await (await fetch(`${plugin.origin}/tts/info`)).json()).servers, [])
    assert.deepEqual((await (await fetch(`${plugin.origin}/stt/info`)).json()).servers, [])
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a provider that speaks without declaring TTS models is offered', async () => {
  /* The Ollama case: `lfm3-omni` answers /audio/speech and declares no task. */
  const engine = await fakeEngine({ models: [{ id: 'lfm3-omni:latest' }, { id: 'llama3.1:8b' }] })
  const plugin = await mountAudio({ providers: providersOf(engine, 'ollama') })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['ollama'])
    assert.deepEqual(body.servers[0].models.map((model) => model.id), ['lfm3-omni:latest', 'llama3.1:8b'], 'no model is filtered out')
    assert.deepEqual(body.servers[0].models[0].voices, [])
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('only endpoints on this machine or the local network are classified local', () => {
  for (const url of [
    'http://127.0.0.1:8080/v1',
    'http://localhost:11434/v1',
    'http://192.168.1.48:8080/v1',
    'http://10.1.2.3/v1',
    'http://172.20.3.4/v1',
    'http://[::1]:8080/v1',
    'http://127.0.0.1:9/v1',
  ]) {
    assert.equal(isLocalEndpoint(url), true, url)
  }
  for (const url of ['https://api.deepseek.com/v1', 'https://api.openai.com/v1', 'http://8.8.8.8/v1']) {
    assert.equal(isLocalEndpoint(url), false, url)
  }
})

test('a configured cloud provider is not probed', async () => {
  const plugin = await mountAudio({ providers: { cloud: { baseURL: 'https://api.deepseek.com/v1' } } })
  try {
    assert.deepEqual((await (await fetch(`${plugin.origin}/tts/info`)).json()).servers, [])
    const log = await (await fetch(`${plugin.origin}/audio/log?level=debug&tail=200`)).json()
    assert.ok(log.entries.some((entry) => entry.event === 'provider-skipped' && entry.detail.provider === 'cloud'),
      'the skipped provider is reported')
  } finally {
    await plugin.close()
  }
})

test('a provider with no explicit endpoint is not probed', async () => {
  const plugin = await mountAudio({ providers: { hosted: { api: 'openai-completions' } } })
  try {
    assert.deepEqual((await (await fetch(`${plugin.origin}/tts/info`)).json()).servers, [])
  } finally {
    await plugin.close()
  }
})

test('a dead provider is skipped while the live one still answers', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({
    providers: {
      dead: { baseURL: 'http://127.0.0.1:9/v1' },
      speech: { baseURL: engine.baseURL },
    },
  })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['speech'])
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('an endpoint listed in the core config is offered too', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ config: { core: { endpoints: [{ id: 'local', name: 'Local audio', baseURL: engine.baseURL }] } } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['local'])
    assert.equal(body.servers[0].name, 'Local audio')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('an engine refusal surfaces as a JSON error', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] }, speechError: 'model failed to load' })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'speech')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a configured preference wins over the first discovered row', async () => {
  const engine = await fakeEngine({
    models: [{ id: 'voice-a', task: 'tts' }, { id: 'voice-b', task: 'tts' }],
    voices: { 'voice-a': ['af_heart'], 'voice-b': ['Vivian'] },
  })
  const plugin = await mountAudio({ providers: providersOf(engine), config: { tts: { model: 'voice-b', voice: 'Vivian' } } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.defaults, { server: 'speech', model: 'voice-b', voice: 'Vivian', speed: 1 })
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the transcription direction offers only providers that accept recordings', async () => {
  const engine = await fakeEngine({ speech: false, voices: false, models: [{ id: 'llama3.1:8b' }, { id: 'lfm3-audio:latest' }, { id: 'gemma4:26b' }] })
  const chat = await fakeEngine({ speech: false, transcriptions: false, voices: false, models: [{ id: 'llama3.1:8b' }] })
  const plugin = await mountAudio({
    providers: {
      ollama: { baseURL: engine.baseURL },
      chatonly: { baseURL: chat.baseURL },
    },
  })
  try {
    const body = await (await fetch(`${plugin.origin}/stt/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['ollama'], 'a provider without the audio route is dropped')
    assert.equal(body.servers[0].baseURL, engine.baseURL)
    assert.deepEqual(body.servers[0].models, ['lfm3-audio:latest', 'llama3.1:8b', 'gemma4:26b'], 'audio-looking names lead, nothing is filtered')
    assert.deepEqual(body.defaults, { server: 'ollama', model: 'lfm3-audio:latest' })
    assert.ok(body.languages.includes('auto'))
  } finally {
    await plugin.close()
    await engine.close()
    await chat.close()
  }
})

test('the shared log records the discovery report of both directions', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    await fetch(`${plugin.origin}/tts/info`)
    await fetch(`${plugin.origin}/stt/info`)
    const body = await (await fetch(`${plugin.origin}/audio/log?tail=100&level=debug&component=core`)).json()
    const discovered = body.entries.filter((entry) => entry.event === 'discovered')
    assert.deepEqual(discovered.map((entry) => entry.detail.kind).sort(), ['stt', 'tts'], 'one discovery per direction, tagged core')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a provider whose whole catalogue declares TTS ranks after one that may transcribe', async () => {
  /* The deployment shape: audio.cpp lists only tts models, Ollama lists models
     that declare nothing — both answer the transcriptions probe. */
  const ttsOnly = await fakeEngine({ speech: false, voices: false, models: [{ id: 'omnivoice', task: 'tts', family: 'omnivoice' }] })
  const maybe = await fakeEngine({ speech: false, voices: false, models: [{ id: 'lfm3-audio:latest' }, { id: 'llama3.1:8b' }] })
  const plugin = await mountAudio({
    providers: {
      'audio-cpp': { baseURL: ttsOnly.baseURL },
      ollama: { baseURL: maybe.baseURL },
    },
  })
  try {
    const body = await (await fetch(`${plugin.origin}/stt/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['ollama', 'audio-cpp'], 'declared TTS-only languages last')
    assert.deepEqual(body.defaults, { server: 'ollama', model: 'lfm3-audio:latest' })
  } finally {
    await plugin.close()
    await ttsOnly.close()
    await maybe.close()
  }
})
