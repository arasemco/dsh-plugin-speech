/**
 * dsh-plugin-speech — HTTP plumbing shared by the bundle's rows.
 *
 * The Host routes of all four components answer JSON and read bounded bodies;
 * this module is the only place that knows how. A row declares a route table
 * and `routes()` turns it into the `webServer` handler, including the 404 for an
 * unknown path and the 405 naming the methods the path does accept.
 */

/** Upper bound for a route that reads a small JSON object. */
export const JSON_LIMIT = 64 * 1024

/**
 * Send one JSON response, always closing the response.
 * @param res - node response.
 * @param status - HTTP status.
 * @param body - serializable body.
 */
export function json (res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Collect a request body under a hard byte limit.
 * @param req - node request.
 * @param limit - largest accepted body.
 * @param tooLarge - message used when the limit is exceeded.
 * @returns The raw body bytes.
 */
export async function readBody (req, limit, tooLarge = 'request body too large') {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(tooLarge)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Read one JSON request body under a hard byte limit.
 * @param req - node request.
 * @param limit - largest accepted body.
 * @returns The parsed body, `{}` when empty.
 */
export async function readJson (req, limit = JSON_LIMIT) {
  const body = await readBody(req, limit)
  if (body.length === 0) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/**
 * Report a body-read failure the way every row does.
 * @param res - node response.
 * @param error - the thrown error, carrying its status.
 * @returns The response that was sent.
 */
export function bodyError (res, error) {
  return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
}

/**
 * Whether a request could have been made by a page on another site.
 *
 * The routes are plain `webServer` prefixes, so nothing upstream checks the
 * caller: a cross-site form or `fetch` with a simple content type would reach a
 * handler. Browsers label such requests — `Sec-Fetch-Site` for fetch/XHR and an
 * `Origin` that cannot equal this server's `Host` for a cross-site post — and a
 * request from a non-browser client carries neither header, so it stays
 * testable and scriptable.
 * @param req - node request.
 * @returns The rejection message, or null when the request may pass.
 */
export function foreignRequest (req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `cross-site request (${site})`
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let host
    try {
      host = new URL(origin).host
    } catch {
      return 'unreadable Origin'
    }
    if (host !== req.headers.host) return `origin ${origin} does not match the page`
  }
  return null
}

/**
 * Whether a POST body matches what the route declared it reads.
 * @param req - node request.
 * @param body - `'json'` or `'audio'`.
 * @returns True when the declared content type is present.
 */
export function acceptsBody (req, body) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  /* No declared type is a bodyless POST (a manual curl, an empty form); the
     handler still rejects an empty or unparsable body on its own. */
  if (type === '') return true
  if (body === 'json') return type === 'application/json'
  /* A recording may announce itself as audio/* or as opaque bytes; the WAV
     container is checked by the route that consumes it. */
  return type.startsWith('audio/') || type === 'application/octet-stream'
}

/**
 * Turn a row's route table into a `webServer` handler.
 *
 * A table entry is `{ method, path, handle, body }`; `GET` also answers `HEAD`
 * and `'*'` accepts any method (the log owner's table). A `body` declares the
 * content type a POST must carry. The handler answers 403 to a foreign origin,
 * 415 to the wrong content type, 404 for an unknown path, and 405 with the
 * accepted methods for a known path.
 * @param table - the rows of the table.
 * @returns A handler for `webServer.register({ kind: 'prefix', … })`.
 */
export function routes (table) {
  return async function handler (req, res) {
    const foreign = foreignRequest(req)
    if (foreign !== null) {
      return json(res, 403, { error: { code: 'origin', message: foreign } })
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const matching = table.filter((entry) => entry.path === url.pathname)
    if (matching.length === 0) {
      return json(res, 404, { error: { code: 'route', message: `unknown route: ${url.pathname}` } })
    }
    const entry = matching.find((candidate) =>
      candidate.method === '*' ||
      candidate.method === req.method ||
      (candidate.method === 'GET' && req.method === 'HEAD'))
    if (entry === undefined) {
      const methods = [...new Set(matching.map((candidate) => candidate.method))].join(' or ')
      return json(res, 405, { error: { code: 'method', message: `${methods} ${url.pathname}` } })
    }
    if (req.method === 'POST' && entry.body !== undefined && !acceptsBody(req, entry.body)) {
      return json(res, 415, { error: { code: 'content-type', message: `${entry.path} reads ${entry.body === 'json' ? 'application/json' : 'audio/*'}` } })
    }
    return entry.handle(req, res, url)
  }
}
