// Small HTTP helpers that work with the plain Node (req, res) objects Vercel
// passes to serverless functions.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const MAX_BODY = 32 * 1024;

export async function readJson(req) {
  // Vercel's Node runtime usually pre-parses JSON into req.body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    return parseJson(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large', 'TOO_LARGE');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  if (!text) return {};
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request body too large', 'TOO_LARGE');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object', 'BAD_JSON');
  }
}

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Strict', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}; Secure`;
  if (httpOnly) c += '; HttpOnly';
  if (maxAge !== undefined) c += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  return c;
}

export function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}

export function queryParam(req, name) {
  if (req.query && typeof req.query[name] === 'string') return req.query[name];
  try {
    return new URL(req.url, 'http://localhost').searchParams.get(name);
  } catch {
    return null;
  }
}

export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// CSRF defence in depth (cookies are already SameSite=Strict): state-changing
// requests must be JSON and, when the browser sends an Origin header, it must
// match the host serving the API.
export function assertSafeMutation(req) {
  const ct = String(req.headers?.['content-type'] || '');
  if (!ct.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json', 'BAD_CONTENT_TYPE');
  }
  const origin = req.headers?.origin;
  if (origin) {
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    let originHost;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!host || originHost !== host) {
      throw new HttpError(403, 'Cross-origin request rejected', 'BAD_ORIGIN');
    }
  }
}

// Wrap an endpoint: method allow-list, JSON errors, no stack traces leaked.
export function endpoint(methods, fn) {
  return async function handler(req, res) {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') assertSafeMutation(req);
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        sendJson(res, err.status, { error: err.message, code: err.code });
      } else {
        console.error('[api error]', err);
        sendJson(res, 500, { error: 'Something went wrong. Please try again.', code: 'INTERNAL' });
      }
    }
  };
}
