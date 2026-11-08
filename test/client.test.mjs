/**
 * Merged browser-half tests: load the hand-authored bundle the way the shell
 * does, mount it against a fake Cordis context, render both surfaces in jsdom,
 * drive the speech engine with a fake transport, and drive a whole recording →
 * transcription → insertion round with stubbed browser audio APIs.
 * Run with `node --test test/client.test.mjs`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

/* React chooses its build when it is required, and `act()` only exists in the
   development build. Pin it before loading React, whatever the caller's env. */
process.env.NODE_ENV = 'development'

const React = (await import('react')).default
const ReactDOM = (await import('react-dom')).default
const ReactDOMClient = (await import('react-dom/client')).default
const ReactDOMServer = (await import('react-dom/server')).default
const ReactTestUtils = (await import('react-dom/test-utils')).default
const { createPortal } = ReactDOM
const { renderToStaticMarkup } = ReactDOMServer
const { act } = ReactTestUtils

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Prose long enough to be split into many sentence groups. */
const LONG = Array.from({ length: 24 }, (_, index) => `Sentence number ${index} is here, and it carries enough words to matter.`).join(' ')

/** Voice roster the fake Host reports for the first model. */
const VOICES = [
  { id: 'bella', label: 'Bella' },
  { id: 'heart', label: 'Heart' },
  { id: 'michael', label: 'Michael' },
  { id: 'emma', label: 'Emma' },
  { id: 'xiaobei', label: 'Xiaobei' },
]
/** Model roster the fake Host discovers from the configured provider. */
const MODELS = [
  { id: 'kokoro', label: 'kokoro', voices: VOICES },
  { id: 'qwen-cv', label: 'qwen-cv', voices: [{ id: 'vivian', label: 'Vivian' }, { id: 'serena', label: 'Serena' }] },
]
/** Rate roster the fake Host reports. */
const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

/** Read-aloud discovery the fake Host serves from `/tts/info`. */
const TTS_INFO = {
  servers: [{ id: 'audio-cpp', name: 'audio-cpp', baseURL: 'http://127.0.0.1:8080/v1', models: MODELS }],
  defaults: { server: 'audio-cpp', model: 'kokoro', voice: 'bella', speed: 1 },
  speeds: SPEEDS,
  maxChars: 4000,
}

/** Dictation provider state the fake Host serves from `/stt/info`. */
const STT_INFO = {
  servers: [{
    id: 'ollama',
    name: 'ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['lfm3-audio:latest', 'llama3.1:8b', 'gemma4:26b'],
  }],
  defaults: { server: 'ollama', model: 'lfm3-audio:latest' },
  languages: ['auto', 'en', 'ja'],
}

/** Component inventory the fake Host serves from `/audio/status`. */
const AUDIO_STATUS = {
  name: 'dsh-plugin-speech',
  version: '0.0.1',
  components: [
    { id: 'core', title: 'Core', routes: ['/audio/log', '/audio/echo'] },
    { id: 'tts', title: 'Read aloud', routes: ['/tts/info', '/tts/speak', '/tts/cast'] },
    { id: 'stt', title: 'Dictation', routes: ['/stt/info', '/stt/transcribe'] },
    { id: 'status', title: 'Status', routes: ['/audio/status'] },
  ],
  providers: { tts: { servers: 1 }, stt: { servers: 1 } },
}

/* ------------------------------------------------------------------ harness */

/**
 * Load the merged browser bundle the way the shell does and return its exports.
 * @param dom - jsdom window bound as the bundle's `window`.
 * @param env - transport and browser-API overrides.
 * @returns The plugin module exports.
 */
function loadBundle (dom, env) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const icon = (name) => (props) => React.createElement('svg', { ...props, 'data-icon': name })
  const modules = {
    react: React,
    'react-dom': { createPortal },
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconPlayOutlineRegular: icon('play'),
      IconCloseOutlineRegular: icon('close'),
      IconStopFillRegular: icon('stop'),
      IconChevronDownOutlineRegular: icon('chevron'),
      IconChevronLeftOutlineRegular: icon('chevron-left'),
      IconChevronRightOutlineRegular: icon('chevron-right'),
      IconPauseOutlineRegular: icon('pause'),
      IconMicrophoneOutlineRegular: icon('mic'),
      IconCheckOutlineRegular: icon('check'),
      Switch: ({ checked, label, onChange }) => React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        onClick: () => onChange(!checked),
      }),
    },
  }
  const requireShim = (id) => {
    if (id in modules) return modules[id]
    throw new Error(`unexpected require: ${id}`)
  }
  const evaluate = new Function(
    'window', 'document', 'Audio', 'fetch', 'URL', 'navigator', 'MediaRecorder', 'AudioContext', 'OfflineAudioContext', 'Blob',
    source,
  )
  dom.window.__ModuleLoader__ = { load: (value) => { dom.window.__ModuleLoader__.definition = value } }
  evaluate(
    dom.window,
    dom.window.document,
    env.Audio,
    env.fetch,
    env.URL,
    env.navigator ?? dom.window.navigator,
    env.MediaRecorder,
    env.AudioContext,
    env.OfflineAudioContext,
    env.Blob ?? globalThis.Blob,
  )
  const definition = dom.window.__ModuleLoader__.definition
  assert.ok(definition !== undefined, 'bundle must register a module definition')
  assert.equal(definition.id, 'dsh-plugin-speech')
  return definition.factory(requireShim)
}

/** Create a fresh jsdom document. */
function makeDom () {
  return new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
}

/**
 * Publish one jsdom as the ambient browser for react-dom, which reads the
 * globals rather than a passed document.
 * @param dom - jsdom instance to install.
 * @returns Restore callback.
 */
function useDom (dom) {
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent']
  const saved = new Map()
  for (const name of names) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'window' ? dom.window : dom.window[name]
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/**
 * The conversation-slot registrations, in mount order: the speech surfaces only,
 * without the Plugins-screen configuration pages the bundle also registers.
 * @param registrations - every slot registration the bundle made.
 * @returns The surface registrations.
 */
function surfaces (registrations) {
  return registrations.filter((row) => row.spec.name !== 'plugins.row.config')
}

/** The configuration pages the bundle registered, keyed by Host row. */
function pages (registrations) {
  return registrations.filter((row) => row.spec.name === 'plugins.row.config')
}

/** Wait for the `/audio/status` probe and the slot registrations it decides. */
async function settle () {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Fake transport for both halves plus the stubbed browser audio APIs.
 * @param options - transport and audio overrides (speech failures, dictation
 *   failures, the status payload, chunk duration, ...).
 * @returns Environment plus recording buffers.
 */
function makeEnvironment (options = {}) {
  const spoken = []
  const played = []
  const infos = []
  const pauses = []
  const requests = []
  const elements = []
  const http = []
  const inserts = []
  const tracks = { stopped: 0 }
  class FakeRecorder {
    constructor (stream) {
      this.stream = stream
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
      this.ondataavailable = null
      this.onstop = null
    }

    start () { this.state = 'recording' }

    stop () {
      this.state = 'inactive'
      if (this.ondataavailable !== null) this.ondataavailable({ data: new Blob(['recorded audio bytes']) })
      if (this.onstop !== null) this.onstop()
    }
  }
  const environment = {
    spoken,
    played,
    infos,
    pauses,
    requests,
    elements,
    http,
    inserts,
    tracks,
    fetch: async (url, init) => {
      const target = String(url)
      const method = init?.method ?? 'GET'
      http.push({ url: target, method, body: init?.body })
      if (target.includes('/audio/status')) {
        if (options.status === 'error') throw new TypeError('NetworkError when attempting to fetch resource.')
        if (options.status === 404) return { ok: false, status: 404, json: async () => null }
        return { ok: true, status: 200, json: async () => options.status ?? AUDIO_STATUS }
      }
      if (target.includes('/audio/log')) return { ok: true, status: 204, json: async () => null }
      if (target.includes('/audio/echo')) {
        if (options.failEcho === true) {
          return { ok: false, status: 502, json: async () => ({ error: { message: 'echo failed' } }) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transcript: options.transcript ?? 'the quick brown fox jumps over the lazy dog',
            speakMs: 120,
            transcribeMs: 340,
            server: 'audio-cpp',
            model: 'kokoro',
            voice: 'bella',
            bytes: 48000,
          }),
        }
      }
      if (target.includes('/tts/cast')) return { ok: true, status: 200, json: async () => ({ enabled: true }) }
      if (target.includes('/tts/speak') && options.failSpeak === true) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { code: 'speech', message: '"chat-model" does not support audio input' } }),
        }
      }
      if (target.includes('/tts/info')) {
        infos.push(target)
        return { ok: true, status: 200, json: async () => TTS_INFO }
      }
      if (target.includes('/stt/info')) {
        return { ok: true, status: 200, json: async () => options.info ?? STT_INFO }
      }
      if (target.includes('/stt/transcribe')) {
        if (options.failTranscribe === true) {
          return { ok: false, status: 502, json: async () => ({ error: { code: 'transcribe', message: 'provider exploded' } }) }
        }
        return { ok: true, status: 200, json: async () => ({ text: options.text ?? 'hello world' }) }
      }
      /* Anything else is one synthesis request for the speech engine. */
      const payload = JSON.parse(init?.body ?? '{}')
      spoken.push(payload.text)
      requests.push(payload)
      if (typeof options.failNetworkTimes === 'number' && options.failNetworkTimes > 0) {
        options.failNetworkTimes -= 1
        throw new TypeError('NetworkError when attempting to fetch resource.')
      }
      if (options.phonemeLimit !== undefined && payload.text.length > options.phonemeLimit) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: { message: 'Kokoro phoneme string exceeds 510 symbols; segmenting is not implemented in the framework path yet' } }),
        }
      }
      if (Array.isArray(options.failModels) && options.failModels.includes(payload.model)) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: `"${payload.model}" does not support audio input` } }),
        }
      }
      return {
        ok: true,
        status: 200,
        blob: async () => ({ size: (payload.text?.length ?? 1) * 10, type: 'audio/wav' }),
      }
    },
    URL: { createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: () => {} },
    Audio: class FakeAudio {
      constructor (url) {
        this.url = url
        this.onended = null
        this.onerror = null
        this.onloadedmetadata = null
        this.ontimeupdate = null
        this.duration = options.chunkSeconds ?? 4
        this.currentTime = 0
        this.playbackRate = 1
        this.preservesPitch = false
        elements.push(this)
      }

      pause () {
        pauses.push(this.url)
      }

      play () {
        if (options.blocked === true) {
          const error = new Error('blocked')
          error.name = 'NotAllowedError'
          return Promise.reject(error)
        }
        played.push(this.url)
        if (this.onloadedmetadata !== null) this.onloadedmetadata()
        const step = options.chunkSeconds ?? 4
        setTimeout(() => {
          this.currentTime = Math.min(step, this.currentTime + step / 2)
          if (this.ontimeupdate !== null) this.ontimeupdate()
        }, Math.max(1, (options.duration ?? 1) / 2))
        setTimeout(() => { if (this.onended !== null) this.onended() }, options.duration ?? 1)
        return Promise.resolve()
      }

      removeAttribute () {}
      load () {}
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          if (options.deny === true) {
            const error = new Error('denied')
            error.name = 'NotAllowedError'
            throw error
          }
          return { getTracks: () => [{ stop: () => { tracks.stopped += 1 } }] }
        },
      },
    },
    MediaRecorder: FakeRecorder,
    AudioContext: class {
      async decodeAudioData () {
        return {
          length: 16000,
          numberOfChannels: 1,
          sampleRate: 16000,
          getChannelData: () => new Float32Array(16000),
        }
      }

      async close () {}
    },
    OfflineAudioContext: class {
      createBuffer () { return { copyToChannel () {} } }
      createBufferSource () { return { connect () {}, start () {}, buffer: null } }
      get destination () { return {} }
      async startRendering () { return { getChannelData: () => new Float32Array(16000) } }
    },
    Blob: globalThis.Blob,
  }
  return environment
}

/** Build an engine from the bundle internals over a fake transport. */
function makeEngine (environment, discovered) {
  const dom = makeDom()
  const mod = loadBundle(dom, environment)
  const info = mod.__internals.createStore({
    status: 'ready',
    value: discovered ?? TTS_INFO,
    error: null,
  })
  const settings = mod.__internals.createSettingsStore()
  const highlighter = mod.__internals.createHighlighter()
  const engine = mod.__internals.createEngine(settings, info, highlighter, () => {})
  return { engine, dom, mod, highlighter, settings, info }
}

/**
 * Fake client context: records slot registrations and locale dictionaries,
 * exposes one Session, and binds injected observables as selector hooks.
 * @param registrations - array the surface registrations are collected into.
 * @param entries - the Session event window the fake binding serves.
 * @param options - `locales` collects the registered dictionaries.
 * @returns The fake context, plus `publish` for Session-driven tests.
 */
function fakeContext (registrations, entries = [], options = {}) {
  const subscribers = new Set()
  const locales = options.locales ?? []
  const binding = {
    eventSource: {
      getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: null }),
      subscribe: (listener) => {
        subscribers.add(listener)
        return () => subscribers.delete(listener)
      },
    },
  }
  return {
    publish (mutate) {
      mutate()
      for (const listener of [...subscribers]) listener()
    },
    effect (fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ ns: namespace, dicts: dictionaries })
        return () => {}
      },
    },
    sessions: { binding: (sessionId) => (sessionId === 's1' ? binding : undefined) },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (spec, component) => {
        const injected = spec.inject === undefined ? {} : spec.inject('s1')
        const { hooks, ...rest } = injected
        const props = { ...rest }
        for (const [key, observable] of Object.entries(hooks ?? {})) {
          /* The renderer binds every injected observable as a selector hook. */
          props[`use${key.charAt(0).toUpperCase()}${key.slice(1)}`] = (selector) => React.useSyncExternalStore(
            (listener) => observable.subscribe(listener),
            () => selector(observable.getSnapshot()),
            () => selector(observable.getSnapshot()),
          )
        }
        registrations.push({ spec, component, injected: props })
        return () => {}
      },
    },
  }
}

/** Render every registration of one context into the root, with per-surface props. */
async function renderAll (dom, registrations, props = {}) {
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  await act(async () => {
    root.render(React.createElement(React.Fragment, null, registrations.map((row, index) =>
      React.createElement(row.component, { key: index, ...row.injected, messageId: 'm-1', sessionId: 's1', t, ...props }))))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  return { container, root, restore, t }
}

/** Mount the dictation control and the listening bar, as the shell does. */
async function mountControl (environment, options = {}) {
  const dom = makeDom()
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations))
  await settle()
  const control = registrations.find((row) => row.spec.id === 'stt-dictate')
  const bar = registrations.find((row) => row.spec.id === 'stt-listening')
  const restore = useDom(dom)
  const container = dom.window.document.getElementById('root')
  const barHost = dom.window.document.createElement('div')
  barHost.id = 'bar-host'
  dom.window.document.body.appendChild(barHost)
  const root = ReactDOMClient.createRoot(container)
  const barRoot = ReactDOMClient.createRoot(barHost)
  const t = (key, params) => {
    if (params === undefined) return key
    if (typeof params === 'object') return `${key} ${JSON.stringify(params)}`
    return `${key} ${params}`
  }
  const inputActions = {
    captureInsertion: () => ({ rev: 1, from: 0, to: 0 }),
    insertText: (text, span) => {
      environment.inserts.push({ text, span })
      return options.rejectFirstInsert === true && environment.inserts.length === 1 ? false : true
    },
    setDraft: () => {},
    persistDraft: () => {},
  }
  await act(async () => {
    root.render(React.createElement(control.component, {
      ...control.injected,
      sessionId: 's1',
      inputActions,
      useInput: (selector) => selector({ draft: options.draft ?? '' }),
      t,
    }))
    barRoot.render(React.createElement(bar.component, { ...bar.injected, sessionId: 's1', t }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  return { dom, container, barHost, root, barRoot, restore, environment, mod, t }
}

/** One click on an element inside act(). */
async function click (dom, element, wait = 20) {
  assert.ok(element !== null && element !== undefined, 'the element to click exists')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, wait))
  })
}

/**
 * Set a form control's value through the native setter and dispatch the event
 * React listens for, so a controlled or uncontrolled field sees the change.
 * @param dom - jsdom window owning the element.
 * @param element - the input, textarea, or select.
 * @param value - the new value.
 * @param eventName - `change` for a select, `focusout` for a field committed on blur.
 * @returns Completion after React processed the event.
 */
async function edit (dom, element, value, eventName) {
  await act(async () => {
    const prototype = element.tagName === 'SELECT'
      ? dom.window.HTMLSelectElement.prototype
      : element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
    element.dispatchEvent(new dom.window.Event(eventName, { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

/** End any capture a test left running, so its timers stop. */
async function cancelCapture (dom, container) {
  const cancel = container.querySelector('.dsh-stt-round[aria-label=cancel]')
  if (cancel !== null) await click(dom, cancel, 20)
}

test('both dictionaries carry the same keys', () => {
  const dom = makeDom()
  const { en, zh } = loadBundle(dom, makeEnvironment()).__internals.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(en).length >= 15)
  dom.window.close()
})

/* ------------------------------------------------------------- text helpers */

test('cleans markdown before speaking', () => {
  const { cleanForSpeech } = bundleInternals()
  const prose = cleanForSpeech([
    '# Heading',
    '',
    'Here is **bold**, _italic_, and `inline code`.',
    '',
    '```js',
    'const hidden = true',
    '```',
    '',
    '- first item',
    '- second item with a [link](https://example.com/page).',
    '',
    '> quoted line',
    '',
    '![diagram](diagram.png) and https://example.com/bare',
  ].join('\n'))
  assert.equal(/```/.test(prose), false)
  assert.equal(/const hidden/.test(prose), false)
  assert.equal(/https?:\/\//.test(prose), false)
  assert.match(prose, /Heading/)
  assert.match(prose, /Here is bold, italic, and inline code\./)
  assert.match(prose, /first item second item with a link\./)
  assert.match(prose, /quoted line/)
  assert.match(prose, /diagram/)
  assert.equal(cleanForSpeech('The rate is 12.5 per second.'), 'The rate is 12 point 5 per second.')
  assert.equal(cleanForSpeech('It is 2× faster and 5% lighter at 45°.'), 'It is 2 times faster and 5 percent lighter at 45 degrees.')
  assert.equal(cleanForSpeech('Version 4.10.2 shipped.'), 'Version 4 point 10 point 2 shipped.')
  assert.equal(
    cleanForSpeech('**The button did change it — only for the *next* sentence.** It saved.'),
    'The button did change it — only for the next sentence. It saved.',
  )
})

test('keeps decimals inside one sentence', () => {
  const { splitChunks } = bundleInternals()
  const chunks = splitChunks('The playhead fired 12.5 times per second, about 3.14 radians, and 7.0 exactly.')
  assert.equal(chunks.length, 1, 'decimal points must not end a sentence')
  assert.match(chunks[0], /12\.5 times per second/)
  assert.match(chunks[0], /3\.14 radians/)
  assert.match(chunks[0], /7\.0 exactly/)
})

test('splits prose into sentence groups within the budget', () => {
  const { splitChunks } = bundleInternals()
  assert.deepEqual(splitChunks('   '), [])
  assert.deepEqual(splitChunks('One only.'), ['One only.'])
  const long = `${'Sentence number one is here. '.repeat(20)}Tail.`
  const chunks = splitChunks(long, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`)
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim())
  const runaway = splitChunks(`word ${'x'.repeat(50)} ${'y'.repeat(50)} end`, 40)
  for (const chunk of runaway) assert.ok(chunk.length <= 52)
})

/* -------------------------------------------------------------- session log */

/** One assistant/message window entry. */
function assistantEvent (seq, turn, id, blocks, interrupted) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 1,
      data: {
        turn,
        step: 0,
        message: { id, role: 'assistant', content: blocks },
        stream: [],
        ...(interrupted === true ? { interrupted: true } : {}),
      },
    },
  }
}

/** Session service stub over one fixed window. */
function sessionsOf (entries) {
  return {
    sessions: {
      binding: () => ({
        eventSource: {
          getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: null }),
          subscribe: () => () => {},
        },
      }),
    },
  }
}

test('reads one reply out of the durable window', () => {
  const { readAssistantText, findLastAssistant } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'First **answer**.' }]),
      assistantEvent(3, 1, 'm-2', [{ type: 'text', text: 'Second answer.' }]),
      assistantEvent(4, 2, 'm-3', [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Final answer.' }]),
      { type: 'event', event: { type: 'turn/start', seq: 5, time: 1, data: { turn: 2 } } },
      { type: 'event', event: { type: 'turn/end', seq: 6, time: 1, data: { turn: 2, reason: { kind: 'completed' } } } },
    ]),
  }
  assert.equal(readAssistantText(ctx, 's1', 'm-1'), 'First answer.')
  assert.equal(readAssistantText(ctx, 's1', 'm-2'), 'Second answer.')
  assert.equal(readAssistantText(ctx, 's1', 'm-3'), 'Final answer.')
  assert.equal(readAssistantText(ctx, 's1', 'missing'), '')
  assert.deepEqual(findLastAssistant(ctx, 's1'), { id: 'm-3', text: 'Final answer.' })
})

test('finds the answer of one completed turn only', () => {
  const { findTurnAnswer } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'Old answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
      { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 2 } } },
      assistantEvent(5, 2, 'm-2', [{ type: 'tool-call', name: 'bash' }]),
      assistantEvent(6, 2, 'm-3', [{ type: 'text', text: 'New answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 7, time: 1, data: { turn: 2, reason: { kind: 'completed' } } } },
    ]),
  }
  assert.deepEqual(findTurnAnswer(ctx, 's1', 2), { id: 'm-3', text: 'New answer.' })
  assert.deepEqual(findTurnAnswer(ctx, 's1', 1), { id: 'm-1', text: 'Old answer.' })
  assert.equal(findTurnAnswer(ctx, 's1', 9), null)
})

test('an interrupted reply is not offered for autoplay', () => {
  const { findLastAssistant } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'Half a thought' }], true),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'aborted' } } } },
    ]),
  }
  assert.equal(findLastAssistant(ctx, 's1'), null)
})

/* ------------------------------------------------------------------ engine */

test('speaks a short reply in one request and returns to idle', async () => {
  const environment = makeEnvironment()
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'First sentence. Second sentence. Third sentence.')
  assert.equal(environment.spoken.length, 1)
  assert.equal(environment.played.length, 1)
  assert.deepEqual(
    { server: environment.requests[0].server, model: environment.requests[0].model, voice: environment.requests[0].voice },
    { server: 'audio-cpp', model: 'kokoro', voice: 'bella' },
    'the request carries the selection resolved from discovery')
  assert.equal('speed' in environment.requests[0], false, 'the rate is applied at playback, not synth')
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().messageId, null)
  await engine.speak('m-2', 'Sentence with words. '.repeat(40))
  assert.ok(environment.spoken.length > 2, 'a long reply is pipelined in several requests')
  dom.window.close()
})

test('publishes loading then playing while speaking', async () => {
  const environment = makeEnvironment()
  const { engine, dom } = makeEngine(environment)
  const seen = []
  const unsubscribe = engine.state.subscribe(() => seen.push(engine.state.getSnapshot().status))
  const pending = engine.speak('m-1', 'One. Two.')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual([...new Set(seen.filter((status) => status !== 'idle'))], ['loading', 'playing'])
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle')
  unsubscribe()
  dom.window.close()
})

test('a rate change applies to the playing audio, not a new request', async () => {
  const environment = makeEnvironment({ duration: 40 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const element = environment.elements.at(-1)
  assert.ok(element !== undefined, 'a chunk is playing')
  assert.equal(element.playbackRate, 1, 'it starts at the configured rate')
  engine.setRate(1.5)
  assert.equal(element.playbackRate, 1.5, 'the playing element is retimed in place')
  assert.equal(element.preservesPitch, true, 'pitch is preserved')
  assert.equal('speed' in environment.requests[0], false, 'no request carries a rate')
  engine.setRate(2)
  assert.equal(element.playbackRate, 2)
  engine.stop()
  await pending
  dom.window.close()
})

test('stop abandons playback and clears the state', async () => {
  const environment = makeEnvironment({ duration: 40 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', 'Sentence with words. '.repeat(40))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(engine.state.getSnapshot().status, 'playing')
  engine.stop()
  await pending
  assert.equal(environment.pauses.length, 1, 'stop must pause the playing element')
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().messageId, null)
  dom.window.close()
})

test('a model that cannot speak is replaced once, and remembered', async () => {
  const environment = makeEnvironment({ failModels: ['chat-model'] })
  const chatOnly = {
    servers: [{
      id: 'ollama',
      name: 'ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: [
        { id: 'chat-model', label: 'chat-model', voices: [] },
        { id: 'lfm3-audio:latest', label: 'lfm3-audio:latest', voices: [] },
      ],
    }],
    defaults: { server: 'ollama', model: 'chat-model', voice: null, speed: 1 },
    speeds: [1],
    maxChars: 4000,
  }
  const { engine, dom, settings, info } = makeEngine(environment, chatOnly)
  settings.save({ model: 'chat-model' })
  await engine.speak('m-1', 'Try to read this aloud.')
  const attempted = environment.requests.map((row) => row.model)
  assert.deepEqual(attempted, ['chat-model', 'lfm3-audio:latest'], 'the refusal triggers one retry with a speakable model')
  assert.equal(engine.state.getSnapshot().status, 'idle', 'and then it plays')
  assert.equal(settings.getSnapshot().model, 'lfm3-audio:latest', 'the working model is remembered')
  assert.ok(info !== undefined)
  dom.window.close()
})

test('a dropped connection is retried once, then reported as a network failure', async () => {
  const environment = makeEnvironment({ duration: 30, failNetworkTimes: 1 })
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'One sentence that survives a dropped connection.')
  assert.equal(engine.state.getSnapshot().status, 'idle', 'the retry recovers')
  assert.ok(environment.played.length >= 1, 'and the audio plays')

  const dead = makeEnvironment({ duration: 30, failNetworkTimes: 99 })
  const second = makeEngine(dead)
  await second.engine.speak('m-1', 'One sentence that keeps failing.')
  const state = second.engine.state.getSnapshot()
  assert.equal(state.status, 'failed')
  assert.equal(state.error.code, 'network', 'transport failures are their own code')
  second.dom.window.close()
  dom.window.close()
})

test('a chunk the engine finds too dense is split and retried', async () => {
  const environment = makeEnvironment({ duration: 30, phonemeLimit: 120 })
  const { engine, dom } = makeEngine(environment)
  const text = `${'This sentence is deliberately long so the phoneme budget is exceeded. '.repeat(4)}End.`
  const pending = engine.speak('m-1', text)
  await new Promise((resolve) => setTimeout(resolve, 40))
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle', 'the reply still finishes')
  const attempted = environment.requests.map((row) => row.text.length)
  assert.ok(attempted.some((length) => length > 120), 'the dense chunk was tried first')
  assert.ok(attempted.some((length) => length <= 120 && length > 0), 'and a smaller piece went through')
  assert.ok(attempted.length >= 3, 'splitting produced more requests')
  assert.ok(environment.played.length >= 2, 'both halves were played')
  dom.window.close()
})

test('a failed reply stays visible with its message', async () => {
  const environment = makeEnvironment({ failSpeak: true })
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'This sentence will fail.')
  const state = engine.state.getSnapshot()
  assert.equal(state.status, 'failed', 'the failure is not swallowed')
  assert.equal(state.error.code, 'server')
  assert.match(state.error.message, /does not support/)
  engine.dismiss()
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().error, null)
  dom.window.close()
})

test('reports an empty reply and a blocked autoplay', async () => {
  const { engine, dom } = makeEngine(makeEnvironment())
  await engine.speak('m-1', '')
  assert.deepEqual(engine.state.getSnapshot().error, { code: 'empty', message: null })
  dom.window.close()

  const blocked = makeEnvironment({ blocked: true })
  const second = makeEngine(blocked)
  await second.engine.speak('m-2', 'Audible text here.')
  assert.equal(second.engine.state.getSnapshot().error.code, 'blocked')
  second.dom.window.close()
})

/* ------------------------------------------------------------- highlighting */

test('finds the spoken sentence in rendered prose', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div data-chat-turn="1"><p>First sentence here, with <strong>bold</strong> words.</p></div>' + '<div data-chat-turn="1"><p>Second one is   spaced out.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const range = findTextRange(rows, 'with bold words.')
  assert.ok(range !== null)
  assert.equal(range.toString().replace(/\s+/g, ' '), 'with bold words.')
  assert.equal(findTextRange(rows, 'not rendered anywhere'), null)
  /* Whitespace collapse: the doubled spaces must still match. */
  assert.equal(findTextRange(rows, 'Second one is spaced out.')?.toString().replace(/\s+/g, ' '), 'Second one is spaced out.')

  const first = findTextRange(rows, 'sentence', false)
  const last = findTextRange(rows, 'Second', true)
  assert.match(first.toString(), /sentence/)
  assert.equal(last.toString(), 'Second')
  dom.window.close()
})

test('matches a sentence whose markup changed its punctuation and spacing', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* The engine speaks cleaned prose; the DOM keeps the code span, the dashes and
     the quoted link that the cleanup removed. */
  body.innerHTML = '<div data-chat-turn="1"><p>Use <code>npm i</code> — then open <a href="#">the docs</a>, and continue.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const range = findTextRange(rows, 'Use npm i then open the docs, and continue.')
  assert.ok(range !== null, 'word-level matching bridges markup differences')
  assert.match(range.toString().replace(/\s+/g, ' '), /Use npm i .* the docs, and continue\./)
  dom.window.close()
})

test('matches across words the engine never says', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* Bare URLs and image alt text are dropped from speech but still rendered. */
  body.innerHTML = '<div data-chat-turn="1"><p>Open https://example.com/x now, then read the chart.</p>' +
    '<p><img alt="a chart">Then continue with the summary.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const first = findTextRange(rows, 'Open now, then read the chart.')
  assert.ok(first !== null, 'a dropped URL must not break the run')
  assert.match(first.toString(), /^Open https:\/\/example\.com\/x now, then read the chart\.$/)
  const second = findTextRange(rows, 'Then continue with the summary.')
  assert.ok(second !== null, 'image alt text the engine never says must not break the run')
  assert.equal(second.toString(), 'Then continue with the summary.')
  dom.window.close()
})

test('marks the message itself when the sentence cannot be found', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div data-chat-turn="1"><p>Something else entirely.</p></div>'
  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('A sentence that is not rendered at all.', [...body.children])
  const marked = dom.window.document.querySelector('[data-dsh-tts-reading]')
  assert.ok(marked !== null, 'the message row is marked instead of nothing')
  assert.equal(marked.getAttribute('data-chat-turn'), '1')
  highlighter.clear()
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('the caption shows the sentence being read', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({ duration: 60 })
  const mod = loadBundle(dom, environment)
  const registrations = []
  const entries = [assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'A brand new answer. It has two sentences.' }])]
  mod.apply(fakeContext(registrations, entries))
  await settle()
  const caption = registrations.find((row) => row.spec.id === 'tts-caption')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key) => key
  await act(async () => {
    root.render(React.createElement(caption.component, { ...caption.injected, sessionId: 's1', t }))
  })
  assert.equal(container.querySelector('.dsh-tts-player'), null, 'hidden while idle')

  const action = registrations.find((row) => row.spec.id === 'tts-listen')
  await act(async () => {
    action.injected.read('s1', 'm-1')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const strip = container.querySelector('.dsh-tts-player')
  assert.ok(strip !== null, 'the player appears while reading')
  assert.match(strip.textContent, /0:\d\d \/ \d:\d\d/, 'the player shows position and length')
  assert.match(strip.getAttribute('title') ?? '', /A brand new answer|First|answer/i, 'the sentence rides the tooltip')
  assert.equal(strip.querySelectorAll('.dsh-tts-player-text').length, 0, 'no caption line in the bar')
  assert.equal(strip.querySelectorAll('.dsh-tts-pbtn').length, 3, 'previous, play/pause, next')
  assert.ok(strip.querySelector('.dsh-tts-seek') !== null, 'the seek bar is there')
  const rate = strip.querySelector('select.dsh-tts-rate')
  assert.ok(rate !== null, 'the player carries the speaking rate as a dropdown')
  assert.equal(rate.value, '1')
  assert.equal(rate.options.length, 5, 'every configured rate is offered')
  const close = strip.querySelector('.dsh-tts-close')
  assert.ok(close !== null, 'the player can be closed')
  assert.equal(close.getAttribute('aria-label'), 'player.close')
  await act(async () => {
    rate.value = '1.5'
    rate.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.match(dom.window.localStorage.getItem('dsh.tts.settings.v1') ?? '', /"speed":1\.5/, 'the picked rate persists')
  await act(async () => {
    close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(container.querySelector('.dsh-tts-player'), null, 'closing stops the voice and hides the bar')
  assert.ok(environment.pauses.length >= 1, 'the audio element was paused')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('matches a sentence whose middle diverged from the domestic text', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* The engine is told "12 point 5 times per second, and 3 point 14 radians";
     the transcript renders the numerals and the multiplication sign. */
  body.innerHTML = '<div data-chat-turn="1"><p>The playhead fired 12.5×/s, and 3.14 radians per turn.</p></div>'
  const mod = loadBundle(dom, makeEnvironment())
  const { findTextRange, findAnchorRange } = mod.__internals
  const rows = [...body.children]
  const chunk = 'The playhead fired 12 point 5 times per second, and 3 point 14 radians per turn.'
  assert.equal(findTextRange(rows, chunk), null, 'the words themselves no longer line up')
  const anchored = findAnchorRange(rows, chunk)
  assert.ok(anchored !== null, 'anchors still find the sentence')
  assert.match(anchored.toString(), /^The playhead fired 12\.5/)
  dom.window.close()
})

test('paints the current sentence and clears it afterwards', () => {
  const dom = makeDom()
  const painted = new Map()
  const registrations = []
  dom.window.Highlight = class {
    constructor (range) { this.range = range; registrations.push(range.toString()) }
  }
  dom.window.CSS = { highlights: { set: (name, value) => painted.set(name, value), delete: (name) => painted.delete(name) } }
  const body = dom.window.document.body
  body.innerHTML = '<div><p>Alpha sentence. Beta sentence.</p></div>'

  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('Beta sentence.', body)
  assert.equal(painted.size, 1, 'the CSS highlight registry holds the range')
  assert.equal(registrations.at(-1), 'Beta sentence.')
  highlighter.clear()
  assert.equal(painted.size, 0, 'clearing removes the registry entry')
  dom.window.close()
})

test('falls back to marking the block when the browser has no highlight API', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div><p>Alpha sentence. Beta sentence.</p></div>'
  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('Alpha sentence.', body)
  const marked = dom.window.document.querySelector('[data-dsh-tts-reading]')
  assert.ok(marked !== null, 'the containing block is marked')
  assert.ok(marked.textContent.includes('Alpha sentence.'))
  highlighter.clear()
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('cast splits a reply by heading and gives each part its own voice', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const { buildCast, castSegments } = mod.__internals
  const voices = [
    { id: 'bella', label: 'Bella' },
    { id: 'michael', label: 'Michael' },
    { id: 'emma', label: 'Emma' },
  ]
  const raw = [
    '## Intro',
    'The first part talks about setup.',
    '',
    '## Second section',
    'The second part talks about usage.',
    '',
    'Alice: and this labelled line introduces a speaker.',
  ].join('\n')
  const segments = castSegments(raw)
  assert.equal(segments.length, 3, 'headings and labels start segments')
  assert.deepEqual(segments.map((segment) => segment.key), ['Intro', 'Second section', 'Alice'])

  const { chunks, cast } = buildCast(raw, voices)
  assert.equal(cast.length, 3, 'three speakers, three voices')
  assert.deepEqual(cast.map((row) => row.voice), ['bella', 'michael', 'emma'])
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.voice))], ['bella', 'michael', 'emma'])
  assert.ok(chunks.every((chunk) => typeof chunk.text === 'string' && chunk.text.length > 0))
  dom.window.close()
})

test('a speaker keeps one voice across its segments', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const voices = [{ id: 'bella', label: 'Bella' }, { id: 'michael', label: 'Michael' }]
  const raw = ['Alice: first line.', 'Bob: second line.', 'Alice: third line.'].join('\n')
  const { cast } = mod.__internals.buildCast(raw, voices)
  assert.deepEqual(cast.map((row) => [row.key, row.voice]), [['Alice', 'bella'], ['Bob', 'michael']],
    'the same speaker reuses its voice')
  dom.window.close()
})

test('cast falls back to a single voice for a one-part reply or one voice', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  assert.equal(mod.__internals.buildCast('Just one paragraph.', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]).chunks, null)
  assert.equal(mod.__internals.buildCast('## A\nOne.\n## B\nTwo.', [{ id: 'only', label: 'Only' }]).chunks, null)
  dom.window.close()
})

test('the engine paints each chunk while speaking and clears on stop', async () => {
  const environment = makeEnvironment({ duration: 30 })
  const { engine, dom, highlighter } = makeEngine(environment)
  const calls = []
  const original = highlighter.show
  highlighter.show = (text, scope) => { calls.push(text); original(text, scope) }
  /* The engine captured the highlighter object, so patched methods are seen. */
  const pending = engine.speak('m-1', 'One sentence. Two sentence. Three sentence.')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls.length >= 1, 'each chunk is highlighted before it plays')
  engine.stop()
  await pending
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('a cast plan sends one voice per chunk', async () => {
  const environment = makeEnvironment({ duration: 30 })
  const { engine, dom } = makeEngine(environment)
  const plan = [
    { text: 'Bella reads this one.', voice: 'bella', voiceLabel: 'Bella' },
    { text: 'Michael reads this one.', voice: 'michael', voiceLabel: 'Michael' },
  ]
  const pending = engine.speak('m-1', plan)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const voices = environment.requests.map((row) => row.voice)
  assert.deepEqual(voices.slice(0, 2), ['bella', 'michael'], 'each chunk carries its own voice')
  assert.equal(engine.state.getSnapshot().voice, 'Bella', 'the player knows who is speaking')
  engine.stop()
  await pending
  dom.window.close()
})

test('seeks, skips chapters, pauses and resumes', async () => {
  const environment = makeEnvironment({ duration: 40, chunkSeconds: 4 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const started = engine.state.getSnapshot()
  assert.equal(started.status, 'playing')
  assert.ok(started.duration > 0, 'the timeline has a length')

  engine.pause()
  assert.equal(engine.state.getSnapshot().status, 'paused')
  const pausedAt = engine.state.getSnapshot().position
  engine.resume()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().status, 'playing')

  engine.skip(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(engine.state.getSnapshot().chunk >= 1, 'next chapter moves the playhead')

  engine.skip(-1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = engine.state.getSnapshot().chunk
  engine.seek(0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().chunk, 0, 'seeking back to zero restarts the reply')
  assert.ok(engine.state.getSnapshot().position < 1)

  engine.stop()
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().duration, 0)
  assert.ok(Number.isFinite(pausedAt))
  assert.ok(before >= 0)
  dom.window.close()
})

test('replay restarts the chapter being read', async () => {
  const environment = makeEnvironment({ duration: 40, chunkSeconds: 4 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  engine.skip(2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const at = engine.state.getSnapshot().chunk
  engine.replay()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().chunk, at, 'replay stays on the same chapter')
  assert.equal(engine.state.getSnapshot().status, 'playing')
  engine.stop()
  await pending
  dom.window.close()
})

/* --------------------------------------------------------------------- ui */

test('mounts both slot surfaces and renders the listen control', async () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions'])

  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  assert.deepEqual(surfaces(registrations).map((row) => row.spec.name), [
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'conversation.input.dock',
    'conversation.input.dock',
    'conversation.input.right',
  ])
  assert.deepEqual(surfaces(registrations).map((row) => row.spec.id), [
    'tts-listen',
    'tts-read-aloud',
    'tts-caption',
    'stt-listening',
    'stt-dictate',
  ])
  assert.ok(dom.window.document.head.querySelector('style[data-plugin-css]') !== null, 'stylesheet is injected')

  const action = surfaces(registrations)[0]
  const markup = renderToStaticMarkup(React.createElement(action.component, {
    ...action.injected,
    messageId: 'm-1',
    sessionId: 's1',
    t: (key) => key,
  }))
  assert.match(markup, /aria-label="action.listen"/)
  assert.match(markup, /data-icon="play"/)

  const control = surfaces(registrations)[1]
  const trigger = renderToStaticMarkup(React.createElement(control.component, {
    ...control.injected,
    sessionId: 's1',
    t: (key) => key,
  }))
  assert.match(trigger, /dsh-tts-trigger/)
  assert.match(trigger, /aria-haspopup="dialog"/)
  dom.window.close()
})

test('opens the settings panel and persists choices', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const control = registrations.find((row) => row.spec.name === 'conversation.input.right')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const props = { ...control.injected, sessionId: 's1', t }

  await act(async () => {
    root.render(React.createElement(control.component, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const trigger = container.querySelector('.dsh-tts-trigger')
  assert.ok(trigger !== null, 'trigger must render')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  const panel = dom.window.document.querySelector('.dsh-tts-panel')
  assert.ok(panel !== null, 'panel must portal into the body')
  assert.match(panel.textContent, /panel\.title/)
  assert.equal(panel.querySelectorAll('.dsh-tts-chip').length, 7, 'two models and five voices — rates live in the player')

  const voiceChip = [...panel.querySelectorAll('.dsh-tts-chip')].find((chip) => chip.textContent === 'Michael')
  assert.ok(voiceChip !== undefined)
  await act(async () => {
    voiceChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('michael'), true)

  const modelChip = [...panel.querySelectorAll('.dsh-tts-chip')].find((chip) => chip.textContent === 'qwen-cv')
  assert.ok(modelChip !== undefined, 'models discovered on the server are offered')
  await act(async () => {
    modelChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('qwen-cv'), true)
  assert.equal(panel.querySelectorAll('.dsh-tts-chip').length, 4, 'the voice row follows the selected model')

  const toggle = panel.querySelector('[role=switch]')
  assert.equal(toggle.getAttribute('aria-checked'), 'true')
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('"autoplay":false'), true)

  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('autoplay reads a newly completed turn', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  const entries = [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }]
  const registrations = []
  const context = fakeContext(registrations, entries)
  mod.apply(context)
  await settle()
  const control = registrations.find((row) => row.spec.name === 'conversation.input.right')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(control.component, { ...control.injected, sessionId: 's1', t: (key) => key }))
  })

  context.publish(() => {
    entries.push(
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'A brand new answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
    )
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(environment.spoken, ['A brand new answer.'])
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

/** Internals of one freshly loaded bundle. */
function bundleInternals () {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  dom.window.close()
  return mod.__internals
}

test('registers the dictation control and the listening bar', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions'])
  const registrations = []
  mod.apply(fakeContext(registrations))
  await settle()
  const stt = surfaces(registrations).filter((row) => row.spec.id.startsWith('stt-'))
  assert.deepEqual(stt.map((row) => row.spec.id), ['stt-listening', 'stt-dictate'])
  assert.deepEqual(stt.map((row) => row.spec.name), ['conversation.input.dock', 'conversation.input.right'])
  assert.ok(dom.window.document.head.querySelector('style[data-plugin-css]') !== null)
  dom.window.close()
})

test('writes a valid 16-bit mono WAV', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const blob = mod.__internals.wavBlob(samples, 16000)
  assert.equal(blob.type, 'audio/wav')
  return blob.arrayBuffer().then((buffer) => {
    const view = new DataView(buffer)
    const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length))
    assert.equal(text(0, 4), 'RIFF')
    assert.equal(text(8, 4), 'WAVE')
    assert.equal(text(12, 4), 'fmt ')
    assert.equal(view.getUint16(20, true), 1, 'PCM')
    assert.equal(view.getUint16(22, true), 1, 'mono')
    assert.equal(view.getUint32(24, true), 16000, 'rate')
    assert.equal(view.getUint16(34, true), 16, 'bits')
    assert.equal(text(36, 4), 'data')
    assert.equal(view.getUint32(40, true), samples.length * 2)
    assert.equal(view.getInt16(44 + 2 * 3, true), 0x7fff, 'full positive clamps')
    assert.equal(view.getInt16(44 + 2 * 4, true), -0x8000, 'full negative clamps')
    dom.window.close()
  })
})

test('records, transcribes, and inserts at the captured caret', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)

  const trigger = container.querySelector('.dsh-stt-trigger')
  assert.ok(trigger !== null)
  assert.match(trigger.textContent, /trigger/, 'the trigger is labelled')

  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(container.querySelector('.dsh-stt-trigger[data-recording]') !== null, true, 'recording state')

  await act(async () => {
    container.querySelector('.dsh-stt-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  assert.equal(environment.inserts.length, 1, 'the transcript is inserted once')
  assert.equal(environment.inserts[0].text, 'hello world')
  assert.deepEqual(environment.inserts[0].span, { rev: 1, from: 0, to: 0 }, 'insertion uses the captured caret')
  const upload = environment.http.find((row) => row.url.includes('/stt/transcribe'))
  assert.ok(upload !== undefined, 'audio was uploaded')
  assert.match(upload.url, /language=auto/)
  assert.match(upload.url, /server=ollama/)
  assert.match(upload.url, /model=lfm3-audio/)
  assert.ok(environment.tracks.stopped >= 1, 'the microphone is released')

  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('retries the insertion at the current caret when the draft moved', async () => {
  const environment = makeEnvironment()
  const { root, restore, dom } = await mountControl(environment, { rejectFirstInsert: true })
  const trigger = dom.window.document.querySelector('.dsh-stt-trigger')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => {
    dom.window.document.querySelector('.dsh-stt-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.equal(environment.inserts.length, 2, 'the insert is retried once')
  assert.deepEqual(environment.inserts[1].span, { rev: 1, from: 0, to: 0 })
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('reports a failed transcription to the host log', async () => {
  const environment = makeEnvironment({ failTranscribe: true })
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-trigger'), 20)
  const bar = dom.window.document.querySelector('.dsh-stt-bar')
  await click(dom, bar.querySelector('.dsh-stt-round[data-primary]'), 40)
  assert.equal(environment.inserts.length, 0, 'nothing is inserted on failure')
  const posted = environment.http.filter((row) => row.url.includes('/audio/log'))
  assert.ok(posted.length >= 1, 'the failure is reported on the shared route')
  const payload = JSON.parse(posted.at(-1).body)
  assert.equal(payload.component, 'stt', 'the shared log names the stt component')
  assert.equal(payload.level, 'error')
  assert.equal(payload.event, 'transcription-failed')
  assert.match(payload.detail.message, /provider exploded/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('explains itself instead of recording when no provider exists', async () => {
  const environment = makeEnvironment({ info: { servers: [], defaults: { server: null, model: null }, languages: ['auto'] } })
  const { container, root, restore, dom } = await mountControl(environment)
  const trigger = container.querySelector('.dsh-stt-trigger')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(container.querySelector('.dsh-stt-trigger[data-recording]'), null, 'no recording without a provider')
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the panel opens')
  assert.match(panel.textContent, /status\.none/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('offers the provider model roster and remembers the choice', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-caret'), 60)
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the caret opens the panel')
  const labels = [...panel.querySelectorAll('.dsh-stt-chip')].map((chip) => chip.textContent)
  assert.ok(labels.includes('lfm3-audio:latest'), 'every model the provider lists is offered')
  assert.ok(labels.includes('llama3.1:8b'))
  const chosen = [...panel.querySelectorAll('.dsh-stt-chip')].find((chip) => chip.textContent === 'llama3.1:8b')
  await click(dom, chosen)
  assert.match(dom.window.localStorage.getItem('dsh.stt.settings.v1') ?? '', /llama3\.1:8b/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('persists the chosen language and sends it', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-caret'), 60)
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the caret opens the panel')
  const japanese = [...panel.querySelectorAll('.dsh-stt-chip')].find((chip) => chip.textContent === 'ja')
  assert.ok(japanese !== undefined, 'languages are offered')
  await click(dom, japanese)
  assert.match(dom.window.localStorage.getItem('dsh.stt.settings.v1') ?? '', /"ja"/)
  await click(dom, container.querySelector('.dsh-stt-caret'), 40)
  assert.equal(dom.window.document.querySelector('.dsh-stt-panel'), null, 'the caret toggles the panel shut')

  await click(dom, container.querySelector('.dsh-stt-trigger'), 60)
  const bar = dom.window.document.querySelector('.dsh-stt-bar')
  if (bar === null) {
    const debug = { root: container.innerHTML.slice(0, 200), body: dom.window.document.body.innerHTML.slice(0, 600), bars: dom.window.document.querySelectorAll('.dsh-stt-bar').length }
    assert.fail(`no bar: ${JSON.stringify(debug)}`)
  }
  await click(dom, bar.querySelector('.dsh-stt-round[data-primary]'), 40)
  const upload = environment.http.filter((row) => row.url.includes('/stt/transcribe')).at(-1)
  assert.match(upload.url, /language=ja/)
  assert.equal(environment.inserts.length, 1)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})


/* --------------------------------------------------------- component switch */

/**
 * Mount the read-aloud control of an applied context and open its settings
 * panel, which hosts the component inventory.
 * @param dom - jsdom the plugin was applied to.
 * @param registrations - the registered surfaces.
 * @returns The container, the portalled panel and the React root.
 */
async function openReadPanel (dom, registrations) {
  const control = registrations.find((row) => row.spec.id === 'tts-read-aloud')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  await act(async () => {
    root.render(React.createElement(control.component, { ...control.injected, sessionId: 's1', t }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await click(dom, container.querySelector('.dsh-tts-trigger'), 10)
  const panel = dom.window.document.querySelector('.dsh-tts-panel')
  assert.ok(panel !== null, 'the read-aloud panel opens')
  return { container, panel, restore, root, t }
}

/** Find the round-trip button inside an open read-aloud panel. */
function roundTripButton (panel) {
  return [...panel.querySelectorAll('button')].find((button) => button.textContent === 'demo.roundtrip')
}

test('a status listing without stt registers no dictation slot and renders no microphone', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({
    status: {
      ...AUDIO_STATUS,
      components: AUDIO_STATUS.components.filter((component) => component.id === 'core' || component.id === 'tts'),
    },
  })
  const mod = loadBundle(dom, environment)
  const registrations = []
  const locales = []
  mod.apply(fakeContext(registrations, [], { locales }))
  await settle()
  assert.deepEqual(surfaces(registrations).map((row) => row.spec.id), ['tts-listen', 'tts-read-aloud', 'tts-caption'])
  assert.deepEqual(locales.map((row) => row.ns), ['tts', 'stt', 'audio'], 'both dictionaries are registered even when a half is off')
  for (const row of locales) assert.deepEqual(Object.keys(row.dicts.zh).sort(), Object.keys(row.dicts.en).sort())

  const { container, root, restore } = await renderAll(dom, registrations)
  assert.equal(container.querySelector('.dsh-stt-trigger'), null, 'the microphone is not rendered')
  assert.equal(container.querySelector('.dsh-stt-group'), null, 'no dictation group is rendered')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('a status listing without tts registers none of the read-aloud slots', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({
    status: {
      ...AUDIO_STATUS,
      components: AUDIO_STATUS.components.filter((component) => component.id === 'core' || component.id === 'stt'),
    },
  })
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  assert.deepEqual(surfaces(registrations).map((row) => row.spec.id), ['stt-listening', 'stt-dictate'])
  assert.equal(surfaces(registrations).some((row) => row.spec.id.startsWith('tts-')), false, 'no read-aloud surface is mounted')
  dom.window.close()
})

test('a 404 status probe registers both halves instead of hiding UI', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({ status: 404 })
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  assert.deepEqual(surfaces(registrations).map((row) => row.spec.id), [
    'tts-listen',
    'tts-read-aloud',
    'tts-caption',
    'stt-listening',
    'stt-dictate',
  ])
  assert.ok(environment.http.some((row) => row.url === '/audio/status'), 'the probe was attempted')
  assert.ok(environment.http.some((row) => row.url.includes('/tts/info')), 'the read-aloud half probed its providers')
  assert.ok(environment.http.some((row) => row.url.includes('/stt/info')), 'the dictation half probed its providers')
  dom.window.close()
})

/* ---------------------------------------------------------------- shared log */

test('both halves log to the shared /audio/log with their component', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({ failEcho: true })
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const { panel, root, restore } = await openReadPanel(dom, registrations)
  const echo = roundTripButton(panel)
  assert.ok(echo !== undefined, 'the round-trip button is in the panel')
  await click(dom, echo, 40)
  const ttsPosts = environment.http
    .filter((row) => row.url === '/audio/log' && row.method === 'POST')
    .map((row) => JSON.parse(row.body))
  const ttsPost = ttsPosts.find((payload) => payload.component === 'tts')
  assert.ok(ttsPost !== undefined, 'the tts event names its component')
  assert.equal(ttsPost.level, 'error')
  assert.equal(ttsPost.event, 'round-trip-failed')
  assert.match(panel.textContent, /echo failed/, 'the failure message is rendered inline')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()

  const sttEnvironment = makeEnvironment({ failTranscribe: true })
  const mounted = await mountControl(sttEnvironment)
  await click(mounted.dom, mounted.container.querySelector('.dsh-stt-trigger'), 20)
  const bar = mounted.dom.window.document.querySelector('.dsh-stt-bar')
  await click(mounted.dom, bar.querySelector('.dsh-stt-round[data-primary]'), 40)
  const sttPosts = sttEnvironment.http
    .filter((row) => row.url === '/audio/log' && row.method === 'POST')
    .map((row) => JSON.parse(row.body))
  const sttPost = sttPosts.find((payload) => payload.component === 'stt')
  assert.ok(sttPost !== undefined, 'the stt event names its component')
  assert.equal(sttPost.event, 'transcription-failed')
  await act(async () => { mounted.root.unmount() })
  mounted.restore()
  mounted.dom.window.close()
})

/* ---------------------------------------------------------------- round-trip */

test('the round-trip test posts /audio/echo and renders the transcript', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const { panel, root, restore } = await openReadPanel(dom, registrations)

  const componentNames = [...panel.querySelectorAll('.dsh-tts-component-name')].map((node) => node.textContent)
  assert.deepEqual(componentNames, ['Core', 'Read aloud', 'Dictation', 'Status'], 'every reported component is listed')

  const echo = roundTripButton(panel)
  assert.ok(echo !== undefined, 'the round-trip button is in the panel')
  await click(dom, echo, 40)
  const post = environment.http.find((row) => row.url === '/audio/echo' && row.method === 'POST')
  assert.ok(post !== undefined, 'the button posts the shared echo route')
  const body = JSON.parse(post.body)
  assert.equal(typeof body.text, 'string')
  assert.ok(body.text.length > 0, 'the request carries the fixed sample sentence')
  assert.match(panel.textContent, /the quick brown fox jumps over the lazy dog/, 'the transcript is rendered inline')
  assert.match(panel.textContent, /demo\.timings/, 'the timings are rendered with the transcript')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

/* ------------------------------------------------------------ configuration */

/** Render one captured configuration page with a synthetic settings form. */
async function renderConfigPage (dom, page, form) {
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(page.component, {
      ...page.injected,
      view: 'page',
      form,
      t: (key) => key,
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { container, root, restore }
}

test('registers one Plugins-screen configuration page per Host row', async () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  assert.deepEqual(pages(registrations).map((row) => row.spec.key), [
    `${mod.__internals.PKG}#audio-core`,
    `${mod.__internals.PKG}#audio-tts`,
    `${mod.__internals.PKG}#audio-stt`,
    `${mod.__internals.PKG}#audio-status`,
  ], 'the key is exactly what the plugin manager dispatches')
  assert.equal(mod.__internals.PKG, 'dsh-plugin-speech')
  dom.window.close()
})

test('a configuration page renders its fields and writes them back', async () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const page = pages(registrations).find((row) => row.spec.key.endsWith('#audio-tts'))
  const calls = []
  const form = {
    state: {
      status: 'ready',
      value: { server: 'audio-cpp', model: 'kokoro', voice: 'af_heart', speed: 1, maxChars: 4000 },
      base: { speed: 1, maxChars: 4000 },
      user: { voice: 'af_heart' },
      revision: 2,
      writable: true,
    },
    mutate: async (ops) => {
      calls.push(ops)
      return true
    },
  }
  const { container, root, restore } = await renderConfigPage(dom, page, form)
  const labels = [...container.querySelectorAll('.dsh-audio-config-label')].map((node) => node.textContent)
  assert.deepEqual(labels, ['config.server', 'config.model', 'config.voice', 'config.speed', 'config.maxChars'])

  /* The model select offers what discovery reported. */
  const model = container.querySelector('#dsh-audio-model')
  const choices = [...model.querySelectorAll('option')].map((option) => option.value)
  assert.equal(choices[0], '', 'an empty choice means "first discovered"')
  assert.ok(choices.includes('kokoro'), 'the discovered model is offered')

  await edit(dom, model, 'qwen-cv', 'change')
  assert.deepEqual(calls.at(-1), [{ op: 'set', path: ['model'], value: 'qwen-cv' }])

  /* A field the user layer set offers a reset that clears it. */
  const reset = [...container.querySelectorAll('.dsh-audio-config-reset')]
  assert.equal(reset.length, 1, 'only the overridden field carries a reset')
  await click(dom, reset[0], 10)
  assert.deepEqual(calls.at(-1), [{ op: 'unset', path: ['voice'] }])

  /* A number field commits on blur, and a refused write is reported. */
  await edit(dom, container.querySelector('#dsh-audio-maxChars'), '2000', 'focusout')
  assert.deepEqual(calls.at(-1), [{ op: 'set', path: ['maxChars'], value: 2000 }])
  assert.match(container.textContent, /config.saved/)

  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('the status page edits its sample sentence and reports a refusal', async () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const page = pages(registrations).find((row) => row.spec.key.endsWith('#audio-status'))
  const calls = []
  const form = {
    state: {
      status: 'ready',
      value: { sample: 'The audio bundle is reading this sentence and hearing it back.' },
      base: {},
      user: {},
      revision: 1,
      writable: true,
    },
    mutate: async (ops) => {
      calls.push(ops)
      return false
    },
  }
  const { container, root, restore } = await renderConfigPage(dom, page, form)
  await edit(dom, container.querySelector('#dsh-audio-sample'), 'Read this back to me.', 'focusout')
  assert.deepEqual(calls.at(-1), [{ op: 'set', path: ['sample'], value: 'Read this back to me.' }])
  assert.match(container.textContent, /config.refused/, 'a refused write says so')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('a configuration page says so when its component is switched off', async () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  await settle()
  const page = pages(registrations).find((row) => row.spec.key.endsWith('#audio-core'))
  const { container, root, restore } = await renderConfigPage(dom, page, undefined)
  assert.match(container.textContent, /config\.unavailable/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})
