/**
 * dsh-plugin-speech — HTTP plumbing for the two surface rows.
 *
 * One place knows how a route answers: JSON with a length and no caching, a
 * bounded body, a route table that 404s an unknown path and 405s a known path
 * with the wrong method, and the same-origin fence every mutating route needs.
 *
 * The fence exists because raw `webServer` routes bypass the host's `/api` trust
 * check. A browser page from another origin can still send a simple
 * `text/plain` POST to a loopback listener, so every route here refuses a
 * cross-site request and every JSON reader refuses a foreign content type.
 */

/** Upper bound for one JSON request body. */
export const JSON_LIMIT = 64 * 1024

/** Whether one request came from this listener's own page. */
export function isSameOrigin (req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Send one JSON response, always closing the response. */
export function json (res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Answer one cross-site request and report whether the route must stop. */
export function guard (req, res) {
  if (isSameOrigin(req)) return false
  json(res, 403, { error: { code: 'origin', message: 'cross-site request refused' } })
  return true
}

/** Collect a request body under a hard byte limit. */
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
 * Read one JSON request body, refusing a foreign content type.
 * @param req - node request.
 * @param limit - largest accepted body.
 * @returns the parsed body, `{}` when empty.
 */
export async function readJson (req, limit = JSON_LIMIT) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/json')) {
    const error = new Error('content-type must be application/json')
    error.status = 415
    throw error
  }
  const body = await readBody(req, limit)
  if (body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return parsed === null || typeof parsed !== 'object' ? {} : parsed
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/** Report a body-read failure the way every route does. */
export function bodyError (res, error) {
  return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
}

/**
 * Turn a route table into a `webServer` handler.
 * @param table - rows of `{ method, path, handle }`; `GET` also answers `HEAD`.
 * @returns the handler for `webServer.register({ kind: 'prefix', … })`.
 */
export function routes (table) {
  return async function handler (req, res) {
    if (guard(req, res)) return
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
    return entry.handle(req, res, url)
  }
}
