---
description: "Speech for the DSH Web GUI in one bundle, as four switchable components: the shared OpenAI audio protocol, read-aloud, dictation, and a component inventory."
kind: "package-bundle"
---

# dsh-plugin-speech

One package, one install, **four components**. The bundle carries a single
OpenAI-compatible audio protocol layer — provider discovery, the synthesis and
transcription calls, one shared event log — and three consumers on top of it.
This package exists to test the multi-component shape of a DSH bundle: every
component is a separate Loader row with its own switch on the Plugins page,
while the machinery they share is written once.

| Row id | Component | Owns |
|---|---|---|
| `audio-core` | Audio protocol | Discovery of the configured providers for each direction, the wire calls, `/audio/log`, the component registry |
| `audio-tts` | Read replies aloud | `/tts/info`, `/tts/speak`, `/tts/cast`, the multi-voice prompt section |
| `audio-stt` | Dictation | `/stt/info`, `/stt/transcribe` |
| `audio-status` | Bundle inventory | `/audio/status` (mounted components, provider summary), `/audio/echo` (round-trip self-test) |

`audio-core` names the package itself; the other three name subpaths
(`dsh-plugin-speech/tts`, …). Each row is its own module file, so no module-level
state is shared between components — the surfaces reach the protocol through the
`audioProtocol` service that `audio-core` provides.

## Layout

One package, four row modules, and the shared modules they import:

```text
core/index.js        audio-core    provides audioProtocol, mounts /audio/log
tts/index.js         audio-tts     /tts/info, /tts/speak, /tts/cast
stt/index.js         audio-stt     /stt/info, /stt/transcribe
status/index.js      audio-status  /audio/status, /audio/echo
lib/protocol.js      the engine: discovery, wire calls, event log, component registry
lib/http.js          JSON responses, bounded bodies, the route-table dispatcher
lib/config.js        the config readers every row clamps through
lib/client.js        the browser half — one bundle, because the shell evaluates it as a script
{core,tts,stt,status}/locale/en.json + zh.json   the row title and description, per component
```

Every row reuses the same HTTP plumbing, the same config readers, and the same
protocol engine; nothing about a server, model, or voice is baked into any of
them. The browser half keeps the mirror image: one panel chrome (anchor
placement, outside-click, Escape), one chip row, one field renderer, and one
selection resolver for both bands.

## Components and their switches

Each row is independent. Switch `audio-tts` off and the Listen control and
player disappear from the browser, `/tts/*` answers 404, and dictation keeps
working untouched; switch `audio-core` off and the three consumers wait for the
service, mounting again the moment it is back. The browser asks
`/audio/status` once and mounts only the halves the Host lists — a failed probe
mounts both rather than hiding UI.

`/audio/echo` speaks a sentence through the read-aloud engine and transcribes the
returned WAV back through dictation: one click in the read-aloud panel, or

```sh
curl -s -X POST http://127.0.0.1:3080/audio/echo \
  -H 'content-type: application/json' \
  -d '{"text":"The audio bundle is reading this sentence and hearing it back."}'
```

## Routes

| Route | Method | Answers |
|---|---|---|
| `/audio/log` | GET / POST / DELETE | The bundle's one event log; entries carry `component`, filter by `level` and `component` |
| `/audio/status` | GET | Mounted components, their routes, provider discovery summary, log counts |
| `/audio/echo` | POST | `{ text }` → `{ transcript, speakMs, transcribeMs, … }` |
| `/tts/info` | GET | Speech servers, their models and voices, defaults |
| `/tts/speak` | POST | `{ text, server?, model?, voice?, speed? }` → `audio/wav` |
| `/tts/cast` | GET / POST | The multi-voice experiment flag the Host mirrors into a prompt section |
| `/stt/info` | GET | Providers that accept transcriptions, their models, defaults |
| `/stt/transcribe` | POST | WAV in → `{ text }` via `<provider>/audio/transcriptions` |

Discovery is capability-based, not name-based: a provider is offered when the
audio route answers at all, every model it lists is offered (audio.cpp declares
`task: "tts"`, Ollama speaks from models that declare nothing), and declaration
only decides ordering. A server whose whole catalogue declares itself TTS ranks
after the servers that may actually transcribe.

## Install

```sh
dsh plugin --profile web add <spec>
```

where `<spec>` is the published package, a git URL, or `file:/path/to/dsh-plugin-speech`
for a local checkout. The package declares `dsh.bundle.patch`, so the install
composes the four rows without hand-editing the profile.

This package supersedes `dsh-plugin-tts` and `dsh-plugin-stt`: it owns the same
`/tts/*` and `/stt/*` routes, and the webserver rejects a duplicate route at
boot. Remove those two bundles from the profile before adding this one.

## Configuration

Each row publishes a schemastery `Config`, so the settings service has a form for
it and the Plugins screen gives that component a **Configure** page: open
*Plugins → Audio*, press Configure on a component, and change the same fields
the patch accepts. The page writes the profile's own `cordis.patch.yml` (the
user layer) as an id-targeted override of that row, then the Loader reconciles
the row live — no restart.

The file stays the source of truth, so either way of editing shows up in the
other: an override made by hand appears in the page as a field with a Reset
control, and a Reset removes the override and re-inherits the row's default.

The fields the page edits are `.volatile()` config fields — the only kind the
settings service publishes — and the rows read them at use time, so saving in the
page reaches the running row without a restart.

Nothing about this machine is baked into the package; machine-specific values
belong in the profile's own patch, for example:

```yaml
- id: audio-core
  config:
    voiceCatalog:
      - /home/agent/stacks/ai/audio-cpp-server.json
    endpoints: []
- id: audio-tts
  config:
    server: audio-cpp
    model: kokoro
    voice: af_heart
    speeds: [0.75, 1, 1.25, 1.5, 2]
    cacheBytes: 25165824
- id: audio-stt
  config:
    server: ollama
    model: lfm3-audio:latest
    language: auto
```

| Row | Config | On the page |
|---|---|---|
| `audio-core` | `endpoints`, `discoveryTtlMs`, `failureTtlMs`, `probeTimeoutMs`, `logLimit`, `speakTimeoutMs`, `transcribeTimeoutMs`, `voiceCatalog` | voice catalog paths, discovery TTL, log size |
| `audio-tts` | `server`, `model`, `voice`, `speed`, `speeds`, `maxChars`, `cacheBytes` | server, model, voice (from discovery), speed, max characters |
| `audio-stt` | `server`, `model`, `language`, `maxAudioBytes` | server, model, language (from discovery), max recording size |
| `audio-status` | `sample` | the round-trip sentence |

A field left empty on the page is cleared from the user layer, so the row
inherits its default again — that is what the Reset control does explicitly.

## Tests

```sh
npm install --no-save --no-package-lock react@18 react-dom@18 jsdom
node --test test/client.test.mjs test/core.test.mjs test/host.test.mjs test/bundle.test.mjs
node --test test/live.test.mjs   # the deployment's real engines; skips when absent
```

`core.test.mjs` drives discovery against fake engines, `host.test.mjs` the
routes, the shared log, the inventory, and the component boundaries,
`client.test.mjs` renders both halves in jsdom with the status-gated slot
registration, `bundle.test.mjs` checks the bundle contract (one exported module
per row, exactly one bare-package row so the browser half is found, a display
title for every component), and `live.test.mjs` talks to `audio.cpp` and Ollama,
including the speak-and-hear round trip.

## Requirements

- A provider implementing `POST /audio/speech` (audio.cpp with Kokoro) and one
  implementing `POST /audio/transcriptions` (Ollama with `lfm3-audio`, or the
  same engine when it serves ASR). Both are ordinary model providers configured
  in the profile; this package ships no model and no recognizer.
- The Host half does all audio I/O, so the browser never reaches the engine
  directly: no CORS, the engines stay on loopback, and any browser that can open
  the GUI can speak and listen.
