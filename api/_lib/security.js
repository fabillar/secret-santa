import crypto from 'node:crypto';
import { getRedis, keys, runScript } from './redis.js';
import { RATE_LIMIT } from './scripts.js';
import { HttpError, parseCookies, serializeCookie, appendSetCookie, clientIp } from './http.js';

// ---------------------------------------------------------------------------
// Tokens & hashing
// ---------------------------------------------------------------------------
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(value) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters long');
  }
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, atomic INCR+PEXPIRE in Lua)
// ---------------------------------------------------------------------------
// Pass { global: true } to count all clients together instead of per IP.
export async function rateLimit(req, bucket, limit, windowMs, { global = false } = {}) {
  const id = global ? 'global' : sha256(clientIp(req)).slice(0, 32);
  const [count, ttl] = await runScript(RATE_LIMIT, [keys.rateLimit(bucket, id)], [windowMs]);
  if (Number(count) > limit) {
    const err = new HttpError(429, 'Too many requests. Please wait a moment and try again.', 'RATE_LIMITED');
    err.retryAfter = Math.max(1, Math.ceil(Number(ttl) / 1000));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admin sessions: random session id stored in Redis with a TTL, sent to the
// browser in an HMAC-signed, HttpOnly, Secure, SameSite=Strict cookie.
// ---------------------------------------------------------------------------
const ADMIN_COOKIE = 'ss_admin';
const ADMIN_TTL_SECONDS = 8 * 60 * 60;

export function checkAdminPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error('ADMIN_PASSWORD is not configured');
  // Compare fixed-length digests so timing does not leak length or content.
  return safeEqual(sha256(candidate), sha256(expected));
}

export async function createAdminSession(req, res) {
  const sid = randomToken(24);
  const redis = getRedis();
  await redis.set(
    keys.adminSession(sid),
    JSON.stringify({ createdAt: Date.now(), ipHash: sha256(clientIp(req)).slice(0, 16) }),
    { ex: ADMIN_TTL_SECONDS },
  );
  appendSetCookie(res, serializeCookie(ADMIN_COOKIE, `${sid}.${hmac(sid)}`, { maxAge: ADMIN_TTL_SECONDS }));
}

function readAdminSid(req) {
  const raw = parseCookies(req)[ADMIN_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(sid)) return null;
  if (!safeEqual(sig, hmac(sid))) return null;
  return sid;
}

export async function isAdmin(req) {
  const sid = readAdminSid(req);
  if (!sid) return false;
  const exists = await getRedis().exists(keys.adminSession(sid));
  return Number(exists) === 1;
}

export async function requireAdmin(req) {
  if (!(await isAdmin(req))) throw new HttpError(401, 'Admin login required', 'UNAUTHORIZED');
}

export async function destroyAdminSession(req, res) {
  const sid = readAdminSid(req);
  if (sid) await getRedis().del(keys.adminSession(sid));
  appendSetCookie(res, serializeCookie(ADMIN_COOKIE, '', { maxAge: 0 }));
}

// ---------------------------------------------------------------------------
// Participant identities. A device can hold several claimed names (e.g. a
// parent who claims for their kids), so the HttpOnly cookie holds up to
// MAX_IDENTITIES raw tokens joined by "~". Only SHA-256 hashes of the tokens
// are stored in Redis.
// ---------------------------------------------------------------------------
const PARTICIPANT_COOKIE = 'ss_participant';
const PARTICIPANT_TTL_SECONDS = 180 * 24 * 60 * 60;
export const MAX_IDENTITIES = 12;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export function isValidTokenFormat(t) {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

export function readParticipantTokens(req) {
  const raw = parseCookies(req)[PARTICIPANT_COOKIE];
  if (!raw) return [];
  return [...new Set(raw.split('~').filter(isValidTokenFormat))].slice(0, MAX_IDENTITIES);
}

export function writeParticipantTokens(res, tokens) {
  const list = [...new Set(tokens.filter(isValidTokenFormat))].slice(-MAX_IDENTITIES);
  appendSetCookie(
    res,
    serializeCookie(PARTICIPANT_COOKIE, list.join('~'), {
      maxAge: list.length ? PARTICIPANT_TTL_SECONDS : 0,
      sameSite: 'Strict',
    }),
  );
}

// Resolve the tokens in the request cookie to member ids. Tokens that no longer
// map to anything (e.g. the admin released the claim) are dropped.
export async function resolveParticipants(req) {
  const tokens = readParticipantTokens(req);
  if (!tokens.length) return { tokens: [], identities: [] };
  const redis = getRedis();
  const hashes = tokens.map(sha256);
  const ids = await redis.hmget(keys.tokens, ...hashes);
  const list = normalizeHmget(ids, hashes);
  const identities = [];
  tokens.forEach((t, i) => {
    if (list[i]) identities.push({ token: t, memberId: list[i] });
  });
  return { tokens, identities };
}

// @upstash/redis returns HMGET as an object keyed by field (or null); local
// test clients may return an array. Normalize to an array aligned with fields.
export function normalizeHmget(result, fields) {
  if (!result) return fields.map(() => null);
  if (Array.isArray(result)) return result.map((v) => v ?? null);
  return fields.map((f) => result[f] ?? null);
}
