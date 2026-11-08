/**
 * The same bundle against the deployment's real engines: audio.cpp (Kokoro,
 * Qwen3-TTS, OmniVoice, Phonon) and Ollama, configured exactly as the profile
 * configures them. The checks skip when those engines are not reachable, so the
 * suite still runs on a machine without a speech server.
 */

import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { before, test } from 'node:test'

import { mountAudio } from './harness.mjs'

const AUDIO_CPP = 'http://192.168.1.48:8080/v1'
const OLLAMA = 'http://192.168.1.48:11434/v1'

/** Provider profiles as the profile stores them under llm-pi-ai. */
const PROVIDERS = {
  'audio-cpp': { api: 'openai-completions', baseURL: AUDIO_CPP, models: [{ id: 'kokoro' }] },
  ollama: { api: 'openai-completions', baseURL: OLLAMA },
}

let engines = false

/**
 * Whether an engine answers at all.
 * @param baseURL - provider base URL.
 * @returns True when its model list answers.
 */
async function reachable (baseURL) {
  try {
    const response = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(4000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Mount the whole bundle over the live providers.
 * @param providers - provider profiles.
 * @param config - per-row config.
 * @returns The bundle origin plus a close handle.
 */
function mountLive (providers = PROVIDERS, config = {}) {
  return mountAudio({ providers, config: { core: { discoveryTtlMs: 0, ...(config.core ?? {}) }, ...config } })
}

before(async () => {
  engines = await reachable(AUDIO_CPP)
})

test('discovers the deployment providers that speak the OpenAI audio API', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['audio-cpp', 'ollama'], 'capability decides, not declared metadata')
    const server = body.servers[0]
    assert.equal(server.baseURL, AUDIO_CPP)
    assert.ok(server.models.length >= 4, 'every model the engine lists is offered')
    assert.ok(server.models.some((model) => model.id === 'kokoro'))
    const kokoro = server.models.find((model) => model.id === 'kokoro')
    /* Kokoro ships dozens of voices; the ids and their tags come from the engine. */
    assert.ok(kokoro.voices.length >= 20, 'the engine reports its whole catalogue')
    assert.deepEqual(kokoro.voices.find((voice) => voice.id === 'af_bella'), {
      id: 'af_bella',
      label: 'Bella',
      gender: 'female',
      language: 'en-us',
      category: null,
      default: false,
      description: null,
    })
    const qwen = server.models.find((model) => model.id === 'qwen-cv')
    assert.ok(qwen.voices.length >= 5, 'each model reports its own voices')
    assert.equal(body.defaults.server, 'audio-cpp')
    assert.equal(body.defaults.model, 'kokoro')
    assert.ok(body.defaults.voice !== null, 'a voice is chosen even before one is stored')
    assert.equal(body.defaults.speed, 1)

    /* Ollama speaks TTS from models that declare nothing; every model it lists is offered. */
    const ollama = body.servers.find((row) => row.id === 'ollama')
    const omni = ollama.models.find((model) => model.id === 'lfm3-omni:latest')
    assert.ok(omni !== undefined, 'models without a declared TTS task are still offered')
    assert.deepEqual(omni.voices, [], 'a provider without the voices route simply has no voices')
    assert.ok(ollama.models.length > 5)
  } finally {
    await plugin.close()
  }
})

test('speaks through the engine the request selects, and caches the audio', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const speak = () => fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Speaking through the discovered provider.', model: 'kokoro', voice: 'michael' }),
    })
    const response = await speak()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-tts-server'), 'audio-cpp')
    assert.equal(response.headers.get('x-tts-model'), 'kokoro')
    assert.match(response.headers.get('content-type') ?? '', /audio\/(wav|wave|x-wav)/)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')

    const again = await speak()
    assert.equal(again.headers.get('x-tts-cache'), 'hit')
  } finally {
    await plugin.close()
  }
})

test('speaks through the Ollama provider and another engine model', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const omni = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Spoken by the local omni model.', model: 'lfm3-omni:latest' }),
    })
    assert.equal(omni.status, 200)
    assert.equal(omni.headers.get('x-tts-server'), 'ollama')
    assert.equal(omni.headers.get('x-tts-model'), 'lfm3-omni:latest')

    const qwen = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A short line.', model: 'qwen-cv', voice: 'vivian' }),
    })
    assert.equal(qwen.status, 200)
    assert.equal(qwen.headers.get('x-tts-model'), 'qwen-cv')
  } finally {
    await plugin.close()
  }
})

test('applies the requested rate at synthesis time', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const speak = async (speed) => {
      const response = await fetch(`${plugin.origin}/tts/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Speaking rate changes duration.', model: 'kokoro', voice: 'bella', speed }),
      })
      assert.equal(response.status, 200)
      return Buffer.from(await response.arrayBuffer()).length
    }
    const fast = await speak(2)
    const normal = await speak(1)
    assert.ok(fast < normal, `rate 2 (${fast}) must be shorter than rate 1 (${normal})`)
  } finally {
    await plugin.close()
  }
})

test('a stale stored voice falls back to one the model offers', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Fallback still speaks.', model: 'kokoro', voice: 'no_such_voice_xyz' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-tts-model'), 'kokoro')
  } finally {
    await plugin.close()
  }
})

test('voices carry the tags the engine publishes in its catalog', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  /* The deployment's engine catalog; the check skips when it is not mounted. */
  const catalog = process.env.TTS_CATALOG ?? '/home/agent/stacks/ai/audio-cpp-server.json'
  try {
    await access(catalog)
  } catch {
    return t.skip('no engine catalog on this machine')
  }
  const plugin = await mountLive(PROVIDERS, { core: { voiceCatalog: catalog } })
  try {
    const info = await (await fetch(`${plugin.origin}/tts/info`)).json()
    const model = info.servers.find((row) => row.id === 'audio-cpp').models.find((row) => row.id === 'kokoro')
    const bella = model.voices.find((voice) => voice.id === 'af_bella')
    assert.equal(bella.label, 'Bella', 'the readable name wins over the catalog key')
    assert.equal(bella.gender, 'female')
    assert.equal(bella.language, 'en-us')
    assert.equal(bella.category, 'catalogue')
    assert.equal(bella.default, true, 'the engine default is carried through')
    assert.ok(model.voices.length >= 54, 'every preset is offered')
    assert.equal(info.defaults.voice, 'af_bella', 'the engine default wins over list position')
  } finally {
    await plugin.close()
  }
})

test('an empty provider list yields no servers and a clear refusal', async () => {
  const plugin = await mountAudio({ providers: {} })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [])
    assert.equal(body.defaults.server, null)
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'anything' }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'no-speech-model')
  } finally {
    await plugin.close()
  }
})

test('the round trip reads a sentence and hears it back through dictation', async (t) => {
  if (!engines) return t.skip('audio.cpp is not reachable')
  const plugin = await mountLive()
  try {
    const response = await fetch(`${plugin.origin}/audio/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'The audio bundle is reading this sentence and hearing it back.' }),
    })
    if (response.status === 409) return t.skip('no provider serves the other direction on this host')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(body.bytes > 1600, 'real audio went out')
    assert.equal(typeof body.transcript, 'string')
    assert.ok(body.transcript.length > 0, 'the transcription direction answered')
    assert.equal(typeof body.speakMs, 'number')
    assert.equal(typeof body.transcribeMs, 'number')
    assert.equal(body.server, 'audio-cpp')
  } finally {
    await plugin.close()
  }
})
