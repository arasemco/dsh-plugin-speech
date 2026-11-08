/**
 * The bundle contract itself: one package, three component rows. These checks
 * are the ones the Host applies when it composes the layer and picks up the
 * browser half, kept here so a rename cannot silently break the composition —
 * a subpath row, for example, is skipped by the client-half scan, so exactly one
 * row has to name the bare package.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')

/**
 * The `id` / `name` pairs the bundle patch inserts, in declaration order.
 * The patch is a plain list of rows under one `insert:`; parsing it here keeps
 * the check dependency-free instead of pulling a YAML reader into the package.
 * @returns the inserted rows.
 */
function rowsOf () {
  const rows = []
  let current = null
  for (const line of patch.split('\n')) {
    const row = /^\s+- id: (\S+)$/.exec(line)
    if (row !== null) {
      current = { id: row[1] }
      rows.push(current)
      continue
    }
    const name = /^\s+name: (\S+)$/.exec(line)
    if (name !== null && current !== null) current.name = name[1]
  }
  return rows
}

/** Module path of the row's own entry, keyed by row id. */
const MODULE_OF = {
  speech: 'index.js',
  'speech-tts': 'tts/index.js',
  'speech-stt': 'stt/index.js',
}

const rows = rowsOf()

test('the package declares itself a bundle with a browser half', () => {
  assert.equal(manifest.name, 'dsh-plugin-speech')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

test('the patch inserts one row per component, with unique ids', () => {
  assert.deepEqual(rows.map((row) => row.id), ['speech', 'speech-tts', 'speech-stt'])
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'the webserver and Loader key by these ids')
})

test('every row names a module this package exports', () => {
  for (const row of rows) {
    const subpath = row.name === manifest.name ? '.' : `.${row.name.slice(manifest.name.length)}`
    assert.ok(Object.hasOwn(manifest.exports, subpath), `${row.name} must be an exported subpath`)
    assert.ok(manifest.files.includes(MODULE_OF[row.id]), `${row.id} must ship its module`)
  }
})

test('exactly one row names the bare package, which is what finds the browser half', () => {
  /* client-modules resolves a row's package manifest only for a specifier that
     is the package name itself: `dsh-plugin-speech/x` locates no manifest, so a
     bundle whose rows are all subpaths would ship a client half nobody mounts. */
  const bare = rows.filter((row) => row.name === manifest.name)
  assert.equal(bare.length, 1, 'one row must carry the package name')
  assert.equal(bare[0].id, 'speech', 'and it is the engine row that owns the package root export')
  assert.equal(manifest.exports['.'], './index.js')
})

test('every component exposes apply and inject', async () => {
  for (const [id, modulePath] of Object.entries(MODULE_OF)) {
    const module = await import(new URL(modulePath, root))
    assert.equal(typeof module.apply, 'function', `${id} applies`)
    assert.ok(Array.isArray(module.inject), `${id} declares its services`)
    assert.equal(typeof module.Config, 'function', `${id} publishes its config schema`)
  }
})

test('the bundle card carries its own title and description', () => {
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.includes('Read replies aloud and dictate prompts'))
})

test('the package ships what the patch and the browser need, and nothing else', () => {
  for (const required of ['index.js', 'tts/index.js', 'stt/index.js', 'lib/client.js', 'lib/audio.js', 'lib/http.js', 'README.md', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(required), `${required} must ship`)
  }
})

test('every row reuses the shared modules instead of restating them', () => {
  /* One implementation per concern: the JSON/route plumbing and the engine are
     imported, never copied per row. */
  const expected = {
    'index.js': ['./lib/audio.js', './lib/http.js'],
    'tts/index.js': ['../lib/http.js', '../lib/audio.js'],
    'stt/index.js': ['../lib/http.js', '../lib/audio.js'],
  }
  for (const [module, imports] of Object.entries(expected)) {
    const source = readFileSync(new URL(module, root), 'utf8')
    for (const specifier of imports) {
      assert.match(source, new RegExp(`from '${specifier.replace(/[/.]/g, '\\$&')}'`), `${module} imports ${specifier}`)
    }
    assert.doesNotMatch(source, /function (json|readJson|number|follow|baseUrl)\b/, `${module} must not restate a shared helper`)
  }
})

test('every row publishes a native config schema, so it has a Plugins-screen form', async () => {
  /* The settings service publishes a form for a row only when the row's module
     exports a schemastery schema; the Loader validates the row's config through
     it. Without one, the row shows neither a schema nor a configuration page. */
  for (const [id, modulePath] of Object.entries(MODULE_OF)) {
    const module = await import(new URL(modulePath, root))
    assert.ok(module.Config !== undefined, `${id} exports Config`)
    assert.equal(Reflect.get(module.Config, Symbol.for('schemastery')), true, `${id}'s Config is a native schema`)
    assert.equal(typeof module.Config.toJSON, 'function', `${id}'s Config serializes for the client`)
    const parsed = module.Config({})
    assert.equal(typeof parsed, 'object', `${id}'s Config accepts an empty section`)
  }
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'] !== undefined, true, 'the package declares the schema dependency')
})

/** The value a parsed schema field stands for: a volatile field is a live reference. */
function valueOf (field) {
  const write = Symbol.for('cosmokit.volatile.write')
  return typeof field === 'object' && field !== null && write in field ? field.get() : field
}

test('each schema default is the value the row falls back to', async () => {
  const cases = {
    speech: { discoveryTtlMs: 15000, logLimit: 200, sample: 'The audio bundle is reading this sentence and hearing it back.' },
    'speech-tts': { speed: 1, maxChars: 4000, speeds: [0.75, 1, 1.25, 1.5, 2] },
    /* A nullable preference has no schema fallback: unset is the default. */
    'speech-stt': { maxAudioBytes: 32 * 1024 * 1024, language: undefined },
  }
  for (const [row, expected] of Object.entries(cases)) {
    const module = await import(new URL(MODULE_OF[row], root))
    const defaults = module.Config({})
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(valueOf(defaults[field]), value, `${row}.${field} defaults to the row's own fallback`)
    }
  }
})

test('the fields a configuration page edits are volatile, which is what publishes them', async () => {
  /* `settings.describe()` projects each row's schema through volatileForm: only
     `.volatile()` fields survive, and an entry with none is skipped entirely —
     no settings namespace, no form, no configuration page. The page's field list
     and the schema's volatile marks therefore have to say the same thing. */
  const pageFields = {
    speech: ['voiceCatalog', 'discoveryTtlMs', 'logLimit', 'sample'],
    'speech-tts': ['server', 'model', 'voice', 'speed', 'maxChars'],
    'speech-stt': ['server', 'model', 'language', 'maxAudioBytes'],
  }
  for (const [row, fields] of Object.entries(pageFields)) {
    const module = await import(new URL(MODULE_OF[row], root))
    const volatileFields = Object.entries(module.Config.dict ?? {})
      .filter(([, child]) => child?.meta?.volatile === true)
      .map(([name]) => name)
    assert.deepEqual(volatileFields.sort(), [...fields].sort(), `${row}: the volatile fields are exactly the page's fields`)
  }
  /* The browser half must edit exactly what the schema publishes. */
  const client = readFileSync(new URL('lib/client.js', root), 'utf8')
  for (const [row, fields] of Object.entries(pageFields)) {
    const rowId = row
    const start = client.indexOf(`rowId: '${rowId}'`)
    assert.ok(start >= 0, `a page exists for ${rowId}`)
    const rest = client.slice(start)
    const end = rest.indexOf('rowId:', 10)
    const block = end < 0 ? rest : rest.slice(0, end)
    const listed = [...block.matchAll(/name: '([a-zA-Z]+)'/g)].map((match) => match[1])
    assert.deepEqual(listed, fields, `${rowId}: the page shows exactly the volatile fields`)
  }
})

test('the browser half keys its configuration pages by this package name', () => {
  const client = readFileSync(new URL('lib/client.js', root), 'utf8')
  const declared = /const PKG_ID = '([^']+)'/.exec(client)
  assert.ok(declared !== null, 'the client declares the package it configures')
  assert.equal(declared[1], manifest.name, 'a page key is <package>#<row id>, so the name must match the manifest')
  for (const rowId of ['speech', 'speech-tts', 'speech-stt']) {
    assert.ok(client.includes(`rowId: '${rowId}'`), `a page exists for ${rowId}`)
    assert.ok(patch.includes(`id: ${rowId}`), `the patch declares ${rowId}`)
  }
})

test('the engine row reads its identity from the package root it ships beside', () => {
  /* `files` ships no package.json copy inside a subdirectory, so the version the
     inventory reports comes from the manifest in the same directory. */
  const engine = readFileSync(new URL('index.js', root), 'utf8')
  assert.match(engine, /new URL\('\.\/package\.json', import\.meta\.url\)/)
})
