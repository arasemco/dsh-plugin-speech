/**
 * The bundle's surface: which routes each row owns, what the shared log holds,
 * what the inventory reports, and that the four components really are
 * independent — one switched off leaves the others serving.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { apply as core, inject as coreInject } from '../core/index.js'
import { apply as tts, inject as ttsInject } from '../tts/index.js'
import { apply as stt, inject as sttInject } from '../stt/index.js'
import { apply as status, inject as statusInject } from '../status/index.js'
import { fakeEngine, mountAudio, wavBytes } from './harness.mjs'

/** A stand-in for a `.volatile()` config reference: a value the settings service updates in place. */
function volatileRef (initial) {
  let current = initial
  const reference = {
    get: () => current,
    [Symbol.for('cosmokit.volatile.write')]: (next) => { current = next },
  }
  return { reference, set: (next) => reference[Symbol.for('cosmokit.volatile.write')](next) }
}

/** Provider profiles keyed by provider id, as the profile stores them. */
const providersOf = (engine, id = 'speech') => ({ [id]: { api: 'openai-completions', baseURL: engine.baseURL } })

test('each component declares the Host services it needs', () => {
  assert.deepEqual(coreInject, ['webServer', 'settings', 'llm'], 'the protocol row owns discovery')
  assert.deepEqual(ttsInject, ['webServer', 'audioProtocol'], 'the surfaces reach the protocol through its service')
  assert.deepEqual(sttInject, ['webServer', 'audioProtocol'])
  assert.deepEqual(statusInject, ['webServer', 'audioProtocol'])
})

test('the inventory reports the components the profile composed', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const body = await (await fetch(`${plugin.origin}/audio/status`)).json()
    assert.equal(body.name, 'dsh-plugin-audio')
    assert.equal(body.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    assert.deepEqual(body.components.map((component) => component.id), ['core', 'tts', 'stt', 'status'], 'declaration order')
    assert.deepEqual(body.components[0].routes, ['/audio/log'])
    assert.deepEqual(body.components[1].routes, ['/tts/info', '/tts/speak', '/tts/cast'])
    assert.deepEqual(body.components[3].routes, ['/audio/status', '/audio/echo'])
    assert.deepEqual(body.providers, { tts: { servers: null }, stt: { servers: null } }, 'nothing is probed by the inventory')
    assert.ok(body.components.every((component) => typeof component.mountedAt === 'number'))
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the inventory reports what discovery has learned so far', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    await fetch(`${plugin.origin}/tts/info`)
    await fetch(`${plugin.origin}/stt/info`)
    const body = await (await fetch(`${plugin.origin}/audio/status`)).json()
    assert.deepEqual(body.providers, { tts: { servers: ['speech'] }, stt: { servers: ['speech'] } })
    assert.ok(body.log.info > 0, 'the log counts travel with the report')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a component the profile left out is absent from the inventory and answers nothing', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const without = await mountAudio({ providers: providersOf(engine), rows: ['core', 'stt', 'status'] })
  try {
    const body = await (await fetch(`${without.origin}/audio/status`)).json()
    assert.deepEqual(body.components.map((component) => component.id), ['core', 'stt', 'status'], 'only what the profile composed')
    assert.equal((await fetch(`${without.origin}/tts/info`)).status, 404, 'no tts row, no tts route')
    assert.equal((await fetch(`${without.origin}/stt/info`)).status, 200)
  } finally {
    await without.close()
  }
  const only = await mountAudio({ providers: providersOf(engine), rows: ['core', 'tts'] })
  try {
    assert.equal((await fetch(`${only.origin}/stt/info`)).status, 404)
    assert.equal((await fetch(`${only.origin}/audio/status`)).status, 404, 'the inventory is its own component')
    assert.equal((await fetch(`${only.origin}/tts/info`)).status, 200)
  } finally {
    await only.close()
    await engine.close()
  }
})

test('the round trip works while both surface rows are switched off', async () => {
  /* The point of the split: the protocol row is the engine, the surfaces are
     consumers, and the demo row composes them without either surface. */
  const engine = await fakeEngine({
    models: [{ id: 'voice-a', task: 'tts' }, { id: 'lfm3-audio' }],
    voices: { 'voice-a': ['af_heart'] },
    transcript: 'the bundle heard itself',
  })
  const plugin = await mountAudio({ providers: providersOf(engine), rows: ['core', 'status'] })
  try {
    const response = await fetch(`${plugin.origin}/audio/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'one sentence through both directions' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.input, 'one sentence through both directions')
    assert.equal(body.transcript, 'the bundle heard itself')
    assert.equal(body.server, 'speech')
    assert.ok(body.bytes > 0)
    assert.equal(typeof body.speakMs, 'number')
    assert.equal(typeof body.transcribeMs, 'number')
    assert.deepEqual(body.heardBy, { server: 'speech', model: 'lfm3-audio' })
    const upload = engine.received.filter((row) => row.path === '/audio/transcriptions' && row.type.startsWith('multipart/form-data'))
    assert.equal(upload.length, 1, 'the synthesized audio is what dictation received')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the round trip speaks a sample when the request names no text', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }, { id: 'lfm3-audio' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const body = await (await fetch(`${plugin.origin}/audio/echo`, { method: 'POST' })).json()
    assert.match(body.input, /The audio bundle is reading this sentence/)
    assert.equal(body.voice, 'af_heart')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the round trip refuses when a direction has no provider', async () => {
  const engine = await fakeEngine({ transcriptions: false, voices: false, models: [{ id: 'voice-a', task: 'tts' }] })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const response = await fetch(`${plugin.origin}/audio/echo`, { method: 'POST' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'no-speech-model')
    assert.equal((await fetch(`${plugin.origin}/audio/echo`)).status, 405)
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('read aloud: requests are validated before any engine is called', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine), config: { tts: { maxChars: 40 } } })
  try {
    const missing = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
    assert.equal((await missing.json()).error.code, 'text')

    const oversized = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(41) }),
    })
    assert.equal(oversized.status, 413)

    assert.equal((await fetch(`${plugin.origin}/tts/speak`)).status, 405)
    assert.equal((await fetch(`${plugin.origin}/tts/nope`)).status, 404)
    assert.equal((await fetch(`${plugin.origin}/tts/info`, { method: 'POST' })).status, 405)
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('read aloud: a stale stored voice falls back to one the model offers', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine), config: { tts: { voice: 'no_such_voice_xyz' } } })
  try {
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Fallback still speaks.', voice: 'no_such_voice_xyz' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-tts-model'), 'voice-a')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('read aloud: identical audio is served from the cache', async () => {
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mountAudio({ providers: providersOf(engine) })
  try {
    const speak = () => fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'the same line twice', model: 'voice-a', voice: 'af_heart' }),
    })
    assert.equal((await speak()).headers.get('x-tts-cache'), 'miss')
    assert.equal((await speak()).headers.get('x-tts-cache'), 'hit')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the multi-voice experiment mirrors its flag and injects one prompt section', async () => {
  const plugin = await mountAudio({ rows: ['core', 'tts'] })
  try {
    const section = plugin.sections.get('dsh-audio-cast')
    assert.ok(section !== undefined, 'the section is registered')
    assert.equal(section.order, 950)
    assert.equal(section.text({}), '', 'the instruction is absent while the experiment is off')

    const posted = await fetch(`${plugin.origin}/tts/cast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(posted.status, 200)
    assert.equal((await posted.json()).enabled, true)
    assert.match(section.text({}), /Reading aloud with several voices/)
    assert.match(section.text({}), /Name: sentence/)
    assert.equal((await (await fetch(`${plugin.origin}/tts/cast`)).json()).enabled, true)

    await fetch(`${plugin.origin}/tts/cast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(section.text({}), '', 'turning it off removes the instruction')
    assert.equal((await fetch(`${plugin.origin}/tts/cast`, { method: 'PUT' })).status, 405)
  } finally {
    await plugin.close()
  }
})

test('dictation: the recording goes out as multipart and the text comes back', async () => {
  const engine = await fakeEngine({
    speech: false,
    voices: false,
    models: [{ id: 'llama3.1:8b' }, { id: 'lfm3-audio:latest' }],
    transcript: '  transcribed by the fake engine  ',
  })
  const plugin = await mountAudio({ providers: providersOf(engine, 'ollama') })
  try {
    engine.received.length = 0
    const response = await fetch(`${plugin.origin}/stt/transcribe?server=ollama&model=lfm3-audio:latest&language=en`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wavBytes(),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.text, 'transcribed by the fake engine')
    assert.equal(body.server, 'ollama')
    assert.equal(body.model, 'lfm3-audio:latest')
    /* The capability probe also hits this route, so count only the real upload. */
    const uploads = engine.received.filter((row) => row.type.startsWith('multipart/form-data'))
    assert.equal(uploads.length, 1)
    assert.match(uploads[0].type, /^multipart\/form-data; boundary=/)
    const text = uploads[0].body.toString('latin1')
    assert.match(text, /name="model"[\s\S]*lfm3-audio:latest/)
    assert.match(text, /name="file"; filename="recording.wav"/)
    assert.match(text, /name="language"[\s\S]*en/)
    assert.match(text, /name="response_format"[\s\S]*json/)
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('dictation: the language hint is omitted when it is auto, and bad bodies are refused', async () => {
  const engine = await fakeEngine({ speech: false, voices: false, models: [{ id: 'lfm3-audio:latest' }] })
  const plugin = await mountAudio({ providers: providersOf(engine, 'ollama') })
  try {
    engine.received.length = 0
    assert.equal((await fetch(`${plugin.origin}/stt/transcribe?language=auto`, { method: 'POST', body: wavBytes() })).status, 200)
    const upload = engine.received.filter((row) => row.type.startsWith('multipart/form-data')).at(-1)
    assert.doesNotMatch(upload.body.toString('latin1'), /name="language"/)

    assert.equal((await fetch(`${plugin.origin}/stt/transcribe`, { method: 'POST', body: Buffer.alloc(0) })).status, 400)
    const tiny = await fetch(`${plugin.origin}/stt/transcribe`, { method: 'POST', body: wavBytes(0.01) })
    assert.equal(tiny.status, 400)
    assert.equal((await tiny.json()).error.code, 'audio')
    assert.equal((await fetch(`${plugin.origin}/stt/transcribe`)).status, 405)
    assert.equal((await fetch(`${plugin.origin}/stt/nope`)).status, 404)
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a volatile config field is read live, without re-applying the row', async () => {
  /* A `.volatile()` field reaches the plugin as a reference the settings service
     updates in place; the row must see the new value without a restart. */
  const engine = await fakeEngine({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const limit = volatileRef(40)
  const plugin = await mountAudio({ providers: providersOf(engine), config: { tts: { maxChars: limit.reference } } })
  try {
    const speak = (text) => fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, model: 'voice-a', voice: 'af_heart' }),
    })
    assert.equal((await speak('x'.repeat(41))).status, 413, 'the initial bound applies')
    limit.set(4000)
    assert.equal((await speak('x'.repeat(41))).status, 200, 'the updated bound applies without re-mounting')
    const info = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.equal(info.maxChars, 4000)
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('the shared log filters by component and level, and clears', async () => {
  const plugin = await mountAudio({ rows: ['core', 'tts', 'stt', 'status'] })
  try {
    const post = (entry) => fetch(`${plugin.origin}/audio/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    })
    assert.equal((await post({ component: 'tts', level: 'warn', event: 'highlight-miss', detail: { reason: 'no-anchors' } })).status, 204)
    assert.equal((await post({ component: 'stt', level: 'error', event: 'transcription-failed', detail: { message: 'boom' } })).status, 204)
    assert.equal((await post({ level: 'info', event: 'unattributed' })).status, 204, 'an unnamed component lands on core')

    const all = await (await fetch(`${plugin.origin}/audio/log?tail=100`)).json()
    const miss = all.entries.find((entry) => entry.event === 'highlight-miss')
    assert.equal(miss.component, 'tts')
    assert.equal(miss.detail.reason, 'no-anchors')
    assert.ok(all.entries.some((entry) => entry.event === 'ready'), 'each row logs its own startup')

    const ttsOnly = await (await fetch(`${plugin.origin}/audio/log?component=tts`)).json()
    assert.ok(ttsOnly.entries.length > 0)
    assert.ok(ttsOnly.entries.every((entry) => entry.component === 'tts'))

    const errorsOnly = await (await fetch(`${plugin.origin}/audio/log?level=error`)).json()
    assert.ok(errorsOnly.entries.length >= 1)
    assert.ok(errorsOnly.entries.every((entry) => entry.level === 'error'))

    assert.equal((await fetch(`${plugin.origin}/audio/log?level=nope`)).status, 400)
    assert.equal((await fetch(`${plugin.origin}/audio/log?component=nope`)).status, 400)
    assert.equal((await fetch(`${plugin.origin}/audio/log`, { method: 'PUT' })).status, 405)

    const cleared = await (await fetch(`${plugin.origin}/audio/log`, { method: 'DELETE' })).json()
    assert.ok(cleared.cleared >= 3)
    assert.deepEqual((await (await fetch(`${plugin.origin}/audio/log`)).json()).entries, [])
  } finally {
    await plugin.close()
  }
})
