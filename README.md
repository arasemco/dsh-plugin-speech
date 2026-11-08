---
description: "Speech for the DSH Web GUI in one bundle: the shared OpenAI audio protocol with read-aloud and dictation as two independently switchable rows."
kind: "package-bundle"
---

# dsh-plugin-speech

One package, one install, **three rows**: the engine and two consumers. The
bundle carries a single OpenAI-compatible audio protocol layer — provider
discovery, the synthesis and transcription calls, one shared event log, the
component inventory and its round-trip self test — and the read-aloud and
dictation surfaces on top of it. Every row is a separate Loader entry with its
own switch on the Plugins page, while the machinery they share is written once.

| Row id | Component | Owns |
|---|---|---|
| `speech` | Engine | Discovery of the configured providers for each direction, the wire calls, `/audio/log`, `/audio/status`, `/audio/echo`, the component registry |
| `speech-tts` | Read replies aloud | `/tts/info`, `/tts/speak`, `/tts/cast`, the multi-voice prompt section |
| `speech-stt` | Dictation | `/stt/info`, `/stt/transcribe` |

`speech` names the package itself; the other two name subpaths
(`dsh-plugin-speech/tts`, `dsh-plugin-speech/stt`). Each row is its own module
file, so no module-level state is shared between rows — the surfaces reach the
engine through the `speechAudio` service that `speech` provides.

## Layout

One package, three row modules, and the shared modules they import:

```text
index.js             speech         the engine: discovery, wire calls, event log, inventory, /audio routes
tts/index.js         speech-tts     /tts/info, /tts/speak, /tts/cast
stt/index.js         speech-stt     /stt/info, /stt/transcribe
lib/audio.js         the engine itself: providers, models, voices, the wire calls, the event log
lib/http.js          JSON responses, bounded bodies, the route-table dispatcher with its origin fence
lib/client.js        the browser half — one bundle, because the shell evaluates it as a script
```

Every row reuses the same HTTP plumbing and the same engine; nothing about a
server, model, or voice is baked into any of them. The browser half keeps the
mirror image: one panel chrome (anchor placement, outside-click, Escape), one
chip row, one field renderer, and one selection resolver for both bands.

## Components and their switches

Each row is independent. Switch `speech-tts` off and the Listen control and
player disappear from the browser, `/tts/*` answers 404, and dictation keeps
working untouched; switch `speech` off and the two consumers wait for the
service, mounting again the moment it is back. The browser asks `/audio/status`
once and mounts only the halves the Host lists — a failed probe mounts both
rather than hiding UI.

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

The routes accept only same-origin requests: a request whose `Sec-Fetch-Site`
says cross-site, or whose `Origin` host is not the serving host, is answered 403;
a POST must carry the content type its route declares (JSON, or `audio/*` for the
upload, whose WAV container is checked too).

Discovery is capability-based, not name-based: a provider is offered when the
audio route answers at all, every model it lists is offered (audio.cpp declares
`task: "tts"`, Ollama speaks from models that declare nothing), and declaration
only decides ordering.

Discovery probes only endpoints on this machine or the local network — loopback,
link-local, and RFC 1918/4193 addresses — because the probe spends the profile's
credential on a provider configured for text. A remote engine is probed when the
`speech` row lists it in `endpoints`, which is also how a non-provider audio
server is added. A server whose whole catalogue declares itself TTS ranks
after the servers that may actually transcribe.

## Install

```sh
dsh plugin --profile web add <spec>
```

where `<spec>` is the published package, a git URL, or `file:/path/to/dsh-plugin-speech`
for a local checkout. The package declares `dsh.bundle.patch`, so the install
composes the three rows without hand-editing the profile.

This package supersedes `dsh-plugin-tts` and `dsh-plugin-stt`: it owns the same
`/tts/*` and `/stt/*` routes, and the webserver rejects a duplicate route at
boot. Remove those two bundles from the profile before adding this one.

## Configuration

Each row publishes a schemastery `Config`, so the settings service has a form for
it and the Plugins screen gives that row a **Configure** page: open
*Plugins → Speech*, press Configure on a row, and change the same fields the
patch accepts. The page writes the profile's own `cordis.patch.yml` (the user
layer) as an id-targeted override of that row, then the Loader reconciles the row
live — no restart.

The file stays the source of truth, so either way of editing shows up in the
other: an override made by hand appears in the page as a field with a Reset
control, and a Reset removes the override and re-inherits the row's default.

The fields the page edits are `.volatile()` config fields — the only kind the
settings service publishes — and the rows read them at use time, so saving in the
page reaches the running row without a restart.

Nothing about this machine is baked into the package; machine-specific values
belong in the profile's own patch, for example:

```yaml
- id: speech
  config:
    voiceCatalog:
      - /home/agent/stacks/ai/audio-cpp-server.json
    endpoints: []
- id: speech-tts
  config:
    server: audio-cpp
    model: kokoro
    voice: af_heart
    speeds: [0.75, 1, 1.25, 1.5, 2]
    cacheBytes: 25165824
- id: speech-stt
  config:
    server: ollama
    model: lfm3-audio:latest
    language: auto
```

| Row | Config | On the page |
|---|---|---|
| `speech` | `endpoints`, `discoveryTtlMs`, `failureTtlMs`, `probeTimeoutMs`, `logLimit`, `speakTimeoutMs`, `transcribeTimeoutMs`, `voiceCatalog`, `sample` | voice catalog paths, discovery TTL, log size, the round-trip sentence |
| `speech-tts` | `server`, `model`, `voice`, `speed`, `speeds`, `maxChars`, `cacheBytes` | server, model, voice (from discovery), speed, max characters |
| `speech-stt` | `server`, `model`, `language`, `maxAudioBytes` | server, model, language (from discovery), max recording size |

A field left empty on the page is cleared from the user layer, so the row
inherits its default again — that is what the Reset control does explicitly.

## Tests

```sh
npm install
npm test                       # every suite except the live engines
npm run test:live              # the deployment's real engines; skips when absent
```

`core.test.mjs` drives discovery against fake engines, `host.test.mjs` the
routes, the shared log, the inventory, and the row boundaries, `client.test.mjs`
renders both halves in jsdom with the status-gated slot registration,
`bundle.test.mjs` checks the bundle contract (one exported module per row,
exactly one bare-package row so the browser half is found, a config schema per
row), and `live.test.mjs` talks to `audio.cpp` and Ollama, including the
speak-and-hear round trip.

## Requirements

- A provider implementing `POST /audio/speech` (audio.cpp with Kokoro) and one
  implementing `POST /audio/transcriptions` (Ollama with `lfm3-audio`, or the
  same engine when it serves ASR). Both are ordinary model providers configured
  in the profile; this package ships no model and no recognizer.
- The Host half does all audio I/O, so the browser never reaches the engine
  directly: no CORS, the engines stay on loopback, and any browser that can open
  the GUI can speak and listen.
