/**
 * dsh-plugin-speech — configuration reading shared by the bundle's rows.
 *
 * Every row's `apply` receives raw profile config: values may be strings from
 * YAML, a single value where a list is expected, or `undefined`. These helpers
 * normalize that once, so no row invents its own clamping rules.
 */

/**
 * Clamp one numeric config value.
 * @param value - raw config value (number or numeric string).
 * @param fallback - value used when the input is not finite.
 * @param min - lowest accepted value.
 * @param max - highest accepted value.
 * @returns The clamped number.
 */
export function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Strip trailing slashes so endpoint building is predictable.
 * @param value - base URL as configured.
 * @returns The URL without a trailing slash.
 */
export function baseUrl (value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Walk one path through a settings value.
 * @param value - section root.
 * @param path - path segments from the provider directory.
 * @returns The value at that path, or undefined.
 */
export function follow (value, path) {
  let current = value
  for (const key of path ?? []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * Read a config value as a non-empty numeric list, falling back when unset.
 * @param value - raw config value.
 * @param fallback - list used when the input is empty.
 * @returns The list.
 */
export function numbers (value, fallback) {
  const list = (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'number' ? entry : Number.parseFloat(entry)))
    .filter((entry) => Number.isFinite(entry))
  return list.length > 0 ? list : fallback
}

/** The shared protocol symbol a volatile config reference carries. */
const VOLATILE = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a config field arrived as a live reference rather than a plain value.
 * A field declared `.volatile()` in a schema reaches the plugin as one of these,
 * so a settings write can update it without re-applying the plugin.
 * @param value - raw config field value.
 * @returns True for a volatile reference.
 */
export function isVolatile (value) {
  return typeof value === 'object' && value !== null && VOLATILE in value
}

/**
 * Read the current value of one config field.
 * @param value - raw config field value, volatile reference or plain.
 * @returns The value now.
 */
export function liveValue (value) {
  return isVolatile(value) ? value.get() : value
}

/**
 * Resolve a row's config against its defaults with one live getter per field.
 *
 * Reading a field at the moment it is used is what makes a `.volatile()` field
 * really live: the settings service updates those references in place, so a
 * value copied at apply time would ignore every later edit. Ordinary fields also
 * pass through here — the Loader re-applies the row when one of those changes, and
 * the getters then read the new config.
 * @param config - the Loader-parsed config.
 * @param defaults - the row's fallback values, one entry per option.
 * @param clamps - per-field normalizers `(value, fallback) => value`.
 * @returns An options object whose properties read the live config.
 */
export function liveOptions (config, defaults, clamps = {}) {
  const options = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const clamp = clamps[key] ?? ((value) => value)
    Object.defineProperty(options, key, {
      enumerable: true,
      get: () => clamp(liveValue(config?.[key]) ?? fallback, fallback),
      set: () => { throw new Error(`dsh-plugin-speech: option ${key} is read-only`) },
    })
  }
  return options
}
