/**
 * Host-side harness: boot the bundle's components on one fake Host and serve
 * their routes over a real HTTP listener, so a test drives exactly what the
 * Loader composes in a profile.
 *
 * The four rows are applied in declaration order, the way the Loader does:
 * `speech-core` first (it provides `audioProtocol`), then whichever surface rows
 * the case asks for. A row that a case leaves out is simply never applied, which
 * is the same observable state as switching it off on the Plugins page.
 */

import { createServer } from 'node:http'

import { apply as applyCore } from '../core/index.js'
import { apply as applyTts } from '../tts/index.js'
import { apply as applyStt } from '../stt/index.js'
import { apply as applyStatus } from '../status/index.js'

/** Component id → the module's apply, in the order a profile composes them. */
const ROWS = {
  core: applyCore,
  tts: applyTts,
  stt: applyStt,
  status: applyStatus,
}

/**
 * Build the fake Host context one row sees.
 * @param routes - the route table shared by every row.
 * @param services - the service table shared by every row.
 * @param providers - provider profiles the fake settings expose.
 * @returns A Cordis-shaped context.
 */
function fakeContext (routes, services, providers) {
  const ctx = {
    effect (fn) { fn() },
    provide (name, value) {
      services[name] = value
      return () => { delete services[name] }
    },
    webServer: {
      register (route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] },
    llm: {
      listConfigurableProviders: () => Object.keys(providers).map((provider) => ({
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
      })),
    },
    logger: { debug () {}, warn () {}, error () {} },
  }
  return ctx
}

/**
 * Compose the requested rows and serve their routes.
 * @param options - provider profiles, the rows to mount, and per-row config.
 * @returns The bundle origin, a close handle, and the live route table.
 */
export async function mountAudio ({ providers = {}, rows = ['core', 'tts', 'stt', 'status'], config = {} } = {}) {
  const routes = new Map()
  const services = {}
  const sections = new Map()
  const mounted = []
  for (const id of rows) {
    const ctx = { ...fakeContext(routes, services, providers) }
    /* The prompt registry is an optional service the cast experiment injects. */
    ctx.inject = (needed, callback) => {
      if (!needed.includes('systemPrompt')) return () => {}
      callback({
        effect: (fn) => fn(),
        systemPrompt: {
          section: (section) => {
            sections.set(section.name, section)
            return () => sections.delete(section.name)
          },
        },
      })
      return () => {}
    }
    /* Only core needs the provider directory; surfaces reach it through the service. */
    if (id !== 'core') ctx.audioProtocol = services.audioProtocol
    ROWS[id](ctx, { discoveryTtlMs: 0, ...(config[id] ?? {}) })
    mounted.push(id)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    /* Longest prefix wins, exactly as the Host router dispatches. */
    const match = [...routes.entries()]
      .filter(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`))
      .sort((left, right) => right[0].length - left[0].length)[0]
    if (match === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'router', message: 'no route' } }))
      return
    }
    match[1].handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    rows: mounted,
    services,
    sections,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * A fake OpenAI-compatible audio server.
 * @param spec - `models` rows, `voices` by model id, and which routes answer.
 * @returns Its base URL plus a close handle and the requests it received.
 */
export async function fakeEngine (spec = {}) {
  const received = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: spec.models ?? [] }))
        return
      }
      if (spec.voices !== false && path === '/audio/voices') {
        const voices = spec.voices?.[url.searchParams.get('model')] ?? []
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices }))
        return
      }
      if (spec.speech !== false && path === '/audio/speech') {
        received.push({ path, method: req.method, type: req.headers['content-type'] ?? '', body })
        if (spec.speechError !== undefined) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: spec.speechError } }))
          return
        }
        /* A minimal RIFF header: enough to prove audio came back. */
        res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from('RIFF....WAVEfmt '))
        return
      }
      if (spec.transcriptions !== false && path === '/audio/transcriptions') {
        received.push({ path, method: req.method, type: req.headers['content-type'] ?? '', body })
        if (!(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'expected multipart' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: spec.transcript ?? '  transcribed by the fake engine  ' }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such route' } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A tiny valid WAV: `seconds` of 16 kHz mono silence (44-byte header included). */
export function wavBytes (seconds = 0.2) {
  const frames = Math.round(16000 * seconds)
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 2, 40)
  return buffer
}
