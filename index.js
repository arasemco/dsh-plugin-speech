/**
 * dsh-plugin-speech — the engine row and the browser half.
 *
 * Owns the shared audio engine: provider discovery, the wire calls, and the
 * server/model selection the two surface rows use. It provides that engine as
 * the `speechAudio` service; `speech-tts` and `speech-stt` inject it and
 * contribute only their routes and their preferences.
 *
 * This row is the bare package name on purpose: the shell discovers a package's
 * browser half only from a Loader row whose specifier is the package itself.
 * Switching this row off leaves the two surface rows waiting for the engine.
 */
import { DEFAULTS, createAudio, number } from './lib/audio.js'

export const name = 'speech'

/** Required host services: configured providers and their settings. */
export const inject = ['settings', 'llm']

/**
 * Mount the engine and provide it to the surface rows.
 * @param ctx - host context carrying settings and the provider directory.
 * @param config - endpoint overrides and probe/transfer budgets.
 */
export function apply (ctx, config = {}) {
  const options = {
    endpoints: Array.isArray(config.endpoints) ? config.endpoints : [],
    discoveryTtlMs: number(config.discoveryTtlMs, DEFAULTS.discoveryTtlMs, 0, 600000),
    failureTtlMs: number(config.failureTtlMs, DEFAULTS.failureTtlMs, 0, 3600000),
    probeTimeoutMs: number(config.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 250, 120000),
    speakTimeoutMs: number(config.speakTimeoutMs, DEFAULTS.speakTimeoutMs, 1000, 3600000),
    transcribeTimeoutMs: number(config.transcribeTimeoutMs, DEFAULTS.transcribeTimeoutMs, 1000, 3600000),
    maxResponseBytes: number(config.maxResponseBytes, DEFAULTS.maxResponseBytes, 1024, 512 * 1024 * 1024),
    voiceModels: number(config.voiceModels, DEFAULTS.voiceModels, 0, 100),
    voiceConcurrency: number(config.voiceConcurrency, DEFAULTS.voiceConcurrency, 1, 16),
  }
  const audio = createAudio(ctx, options)
  /* Fiber-scoped: the service disappears with this row, taking its rows with it. */
  ctx.provide('speechAudio', audio)
}
