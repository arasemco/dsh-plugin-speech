# dsh-plugin-speech

Read replies aloud and dictate prompts in the DeepSeek Harness Web GUI, through
the OpenAI-compatible audio API of the model providers your profile already
configures.

One package, three loads:

| Row | Owns |
|---|---|
| `speech` | The audio engine — provider discovery, the wire calls, selection — and the browser half. It provides `speechAudio`; this row MUST be the bare package name, because the shell finds a package's browser half only from a row whose specifier is the package itself. |
| `speech-tts` | `GET /tts/info`, `POST /tts/speak` → audio/wav; the Listen control, transport bar, and read-aloud settings panel. |
| `speech-stt` | `GET /stt/info`, `POST /stt/transcribe` → `{ text }`; the composer microphone, level bar, and dictation panel. |

Switching `speech-tts` or `speech-stt` off answers 404 on its routes and leaves
the other direction untouched. Switching `speech` off leaves both surface rows
waiting for the engine.

## Why it is safe next to the GUI

- **No credentials to unconfigured routes.** Only providers whose profile sets an
  explicit `baseURL` are probed. An adapter's shipped cloud default is never
  contacted, so an unconfigured provider's endpoint and key are never used.
- **The browser never reaches an engine.** Both halves call the same-origin
  `/tts/*` and `/stt/*` routes; CORS, LAN exposure, and mixed content stay out.
- **Every route is fenced.** A cross-site request and a foreign content type are
  refused before any work happens; bodies are bounded.
- **Discovery degrades.** One pass at a time; a provider whose model list stops
  answering is kept from the previous result instead of being dropped for the
  whole failure TTL; only a "no such route" answer is cached as a refusal.
- **Voice fan-out is capped** (12 models per server, 4 concurrent), so a provider
  listing hundreds of models cannot turn one probe into hundreds of requests.
- **Bounded responses.** An engine answer over 32 MiB is refused, and upstream
  401/403/429 map to distinct errors instead of a generic 400.

Browser behaviour:

- Listen on each finalized reply; autoplay for completed turns; a transport bar
  in the archived player's shape: previous/next sentence, pause/resume, a plain
  range for the seek (click, drag, keyboard), a rate select, the clock as
  `m:ss / m:ss` that replays the current sentence when clicked, and close. A
  jump fetches the chunk around the target, so a missed section resumes
  mid-sentence instead of replaying from the top. The live waveform stays where
  the archive had it: the dictation bar. The spoken sentence is highlighted in
  the reply (Custom Highlight API, with a data-attribute fallback), and a
  settings panel carries server, model, voice, rate, autoplay, and the highlight
  switch. Highlighting is paint-only: turning it off never hides the transport.
- Dictation records in the page, transcodes to 16 kHz mono WAV, and inserts the
  transcript at the caret it had when recording started. One take at a time; an
  unmount discards the take instead of transcribing it; a second stop cannot
  transcribe twice.

Deliberately absent: inventory/status/echo routes, event logs, the multi-voice
cast experiment, per-row configuration pages, voice catalogs, and an audio cache.
Configuration is the profile patch, which is one source of truth.

## Install

```sh
dsh plugin --profile web add /path/to/plugin/speech
```

The package declares `dsh.bundle.patch`, so the install composes the three rows
without hand-editing the profile.

## Configuration

Each row reads the profile patch:

```yaml
- id: speech
  config:
    discoveryTtlMs: 15000      # successful discovery reuse
    failureTtlMs: 300000       # a refused route is retried after this
    probeTimeoutMs: 8000       # one probe/model-list request
    speakTimeoutMs: 120000
    transcribeTimeoutMs: 300000
    maxResponseBytes: 33554432
    voiceModels: 12
    voiceConcurrency: 4
    endpoints: []              # extra { id, name, baseURL, apiKeyEnv } servers
- id: speech-tts
  config:
    server: null               # preferred provider id
    model: null                # preferred model id
    voice: null                # preferred voice id
    speed: 1
    speeds: [0.75, 1, 1.25, 1.5, 2]
    maxChars: 4000
- id: speech-stt
  config:
    server: null
    model: null
    language: null             # null/auto lets the model detect it
    maxAudioBytes: 33554432
```

## Requirements

A provider that implements `POST /audio/speech` (for example audio.cpp with
Kokoro) and/or `POST /audio/transcriptions` (for example Ollama with a
speech-capable model), with an explicit `baseURL` in the profile. The package
ships no engine and no model.

## Test

Dependency-free; the browser half is loaded the way the shell loads it and its
logic and slot wiring are driven without React.

```sh
node --test test/host.test.mjs test/client.test.mjs
```
