/**
 * Browser-half tests for dsh-plugin-speech, run without React or a DOM: the
 * hand-authored bundle is executed the way the shell does with a require shim,
 * then its pure logic and its slot wiring are driven directly.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** Minimal React stand-in: the factory only calls these while rendering. */
const React = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useId: () => 'id',
}
const primitives = new Proxy({}, { get: () => () => null })
const modules = {
  react: React,
  'react-dom': { createPortal: (node) => node },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

/**
 * Execute the shipped classic script with a loader facade and a require shim.
 * @param fetchImpl - optional fetch stand-in.
 * @returns the plugin module exports.
 */
function loadBundle (fetchImpl) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const style = { dataset: {}, remove () {}, textContent: '' }
  const document = {
    querySelector: () => null,
    createElement: () => style,
    head: { appendChild () {} },
    addEventListener () {},
    removeEventListener () {},
  }
  const window = {
    __ModuleLoader__: {
      load (definition) {
        this.definition = definition
        return this
      },
    },
    localStorage: {
      values: new Map(),
      getItem (key) { return this.values.has(key) ? this.values.get(key) : null },
      setItem (key, value) { this.values.set(key, value) },
    },
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout () {},
    setInterval: () => 0,
    clearInterval () {},
    requestAnimationFrame: (fn) => { fn(); return 0 },
    cancelAnimationFrame () {},
    innerWidth: 1200,
    innerHeight: 900,
  }
  const evaluate = new Function(
    'window', 'document', 'fetch', 'Audio', 'navigator', 'MediaRecorder',
    'AudioContext', 'OfflineAudioContext', 'Blob', 'URL',
    source,
  )
  const loader = window.__ModuleLoader__
  evaluate(
    window,
    document,
    fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ servers: [], defaults: {} }) })),
    function Audio () {},
    { mediaDevices: undefined },
    function MediaRecorder () {},
    function AudioContext () {},
    function OfflineAudioContext () {},
    globalThis.Blob,
    { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  )
  const definition = loader.definition
  const mod = { exports: {} }
  const required = definition.factory((id) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`)
    return modules[id]
  })
  return { definition, exports: required ?? mod.exports }
}

/** A client context recording slot, locale, and effect registrations. */
function fakeCtx () {
  const locales = []
  const slots = []
  const effects = []
  return {
    locales,
    slots,
    effects,
    ctx: {
      effect (fn) {
        effects.push(fn)
        fn()
        return () => {}
      },
      locale: {
        register (ns, dictionaries) {
          locales.push({ ns, dictionaries })
          return () => {}
        },
      },
      slots: {
        inject (name, callback) {
          callback()
          return () => {}
        },
        register (spec) {
          slots.push(spec)
          return () => {}
        },
      },
      sessions: { binding: () => undefined },
    },
  }
}

/* ------------------------------------------------------------------ contract */

test('the bundle registers the speech module the shell can find', () => {
  const { definition, exports } = loadBundle()
  assert.equal(definition.id, 'dsh-plugin-speech')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions'])
})

test('apply registers both dictionaries and mounts both halves', async () => {
  const { exports } = loadBundle()
  const fake = fakeCtx()
  exports.apply(fake.ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fake.locales.map((entry) => entry.ns), ['tts', 'stt'])
  assert.deepEqual(fake.slots.map((slot) => slot.id), [
    'speech-listen',
    'speech-read-aloud',
    'speech-caption',
    'speech-listening',
    'speech-dictate',
  ])
})

test('a route that answers 404 unmounts its half only', async () => {
  const { exports } = loadBundle(async (url) => ({
    ok: url === '/tts/info',
    status: url === '/tts/info' ? 200 : 404,
    json: async () => ({ servers: [], defaults: {}, languages: ['auto'] }),
  }))
  const fake = fakeCtx()
  exports.apply(fake.ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fake.slots.map((slot) => slot.id), ['speech-listen', 'speech-read-aloud', 'speech-caption'])
})

test('a probe failure (not a 404) still mounts the UI', async () => {
  const { exports } = loadBundle(async () => { throw new Error('offline') })
  const fake = fakeCtx()
  exports.apply(fake.ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.slots.length, 5)
})

/* -------------------------------------------------------------------- speech */

test('cleanForSpeech strips Markdown structure', () => {
  const { exports } = loadBundle()
  const text = exports.__internals.cleanForSpeech('## Title\n\n- item **bold** and `code` and [link](http://x)\n\n```js\nnope\n```')
  assert.ok(!text.includes('##'))
  assert.ok(!text.includes('**'))
  assert.ok(!text.includes('`'))
  assert.ok(!text.includes('http://x'))
  assert.ok(text.includes('item bold and code and link'))
})

test('splitChunks bounds every group and keeps decimals', () => {
  const { exports } = loadBundle()
  const { splitChunks } = exports.__internals
  assert.deepEqual(splitChunks(''), [])
  assert.deepEqual(splitChunks('One sentence.'), ['One sentence.'])
  const groups = splitChunks('Sentence one is here. Sentence two is there. 12.5 stays one number. ' + 'word '.repeat(400), 120)
  assert.ok(groups.length > 2)
  for (const group of groups) assert.ok(group.length <= 120, `group too long: ${group.length}`)
  assert.ok(groups.some((group) => group.includes('12.5')))
})

test('selectionOf follows stored preferences, then host defaults', () => {
  const { exports } = loadBundle()
  const { selectionOf } = exports.__internals
  const discovered = {
    servers: [{ id: 'local', name: 'local', models: [{ id: 'kokoro', voices: ['af_heart', 'af_bella'] }] }],
    defaults: { server: 'local', model: 'kokoro', voice: 'af_heart', speed: 1 },
    speeds: [1, 2],
    maxChars: 4000,
  }
  const fromDefaults = selectionOf({ server: null, model: null, voice: null, speed: null }, discovered)
  assert.equal(fromDefaults.server.id, 'local')
  assert.equal(fromDefaults.model.id, 'kokoro')
  assert.equal(fromDefaults.voice, 'af_heart')
  assert.equal(fromDefaults.speed, 1)
  const stored = selectionOf({ server: 'local', model: 'kokoro', voice: 'af_bella', speed: 2 }, discovered)
  assert.equal(stored.voice, 'af_bella')
  assert.equal(stored.speed, 2)
  const stale = selectionOf({ server: 'gone', model: 'gone', voice: 'gone', speed: null }, discovered)
  assert.equal(stale.server.id, 'local', 'a stale preference falls back to the defaults')
  assert.equal(stale.voice, 'af_heart')
})

test('settings restore ignores foreign values and save persists them', () => {
  const { exports } = loadBundle()
  const { createSettingsStore } = exports.__internals
  const store = createSettingsStore('test-key', { autoplay: true, server: null }, (parsed, fallback) => ({
    autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : fallback.autoplay,
    server: typeof parsed.server === 'string' ? parsed.server : null,
  }))
  assert.deepEqual(store.getSnapshot(), { autoplay: true, server: null })
  store.save({ autoplay: false, server: 'local' })
  assert.deepEqual(store.getSnapshot(), { autoplay: false, server: 'local' })
  const again = createSettingsStore('test-key', { autoplay: true, server: null }, (parsed, fallback) => ({
    autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : fallback.autoplay,
    server: typeof parsed.server === 'string' ? parsed.server : null,
  }))
  assert.deepEqual(again.getSnapshot(), { autoplay: false, server: 'local' })
})

test('encodeWav writes a 16 kHz mono 16-bit header and samples', () => {
  const { exports } = loadBundle()
  const { encodeWav } = exports.__internals
  const blob = encodeWav(new Float32Array([0, 0.5, -0.5]), 16000)
  assert.equal(blob.type, 'audio/wav')
  return blob.arrayBuffer().then((buffer) => {
    const view = new DataView(buffer)
    const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length))
    assert.equal(text(0, 4), 'RIFF')
    assert.equal(text(8, 4), 'WAVE')
    assert.equal(text(36, 4), 'data')
    assert.equal(view.getUint32(24, true), 16000, 'sample rate')
    assert.equal(view.getUint16(22, true), 1, 'mono')
    assert.equal(view.getUint16(34, true), 16, '16-bit')
    assert.equal(view.getUint32(40, true), 6, 'three samples of two bytes')
  })
})
