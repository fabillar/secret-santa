// Redis initialization module.
//
// Upstash Redis is the ONLY persistent store for this app. This module creates a
// single shared REST client (reused across warm invocations of a serverless
// function) from the UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars.
//
// Files in /api whose names start with "_" are not deployed as endpoints by
// Vercel, so nothing in api/_lib is reachable from the browser.

import { Redis } from '@upstash/redis';

let client = null;

export function getRedis() {
  // Test hook: tests inject a compatible client backed by a local redis-server.
  if (globalThis.__SS_TEST_REDIS__) return globalThis.__SS_TEST_REDIS__;
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN environment variables');
  }

  client = new Redis({
    url,
    token,
    // Keep every value a plain string. Automatic JSON deserialization would turn
    // "1" into 1 and break strict comparisons, so all parsing is done explicitly.
    automaticDeserialization: false,
  });
  return client;
}

// ---------------------------------------------------------------------------
// Key structure. Everything lives under one prefix so the database can be shared
// or wiped safely.
// ---------------------------------------------------------------------------
const P = process.env.REDIS_KEY_PREFIX || 'ss:';

export const POOLS = ['adult', 'child'];

export const keys = {
  prefix: P,
  members: `${P}family:members`,                    // SET    member ids
  memberPrefix: `${P}family:member:`,              // prefix for member hashes
  member: (id) => `${P}family:member:${id}`,        // HASH   id,name,nameKey,householdId,category,claimed,claimedAt,createdAt
  memberNames: `${P}family:member-names`,           // HASH   normalized name -> member id (uniqueness)
  households: `${P}family:households`,              // SET    household ids
  householdPrefix: `${P}family:household:`,
  household: (id) => `${P}family:household:${id}`,  // HASH   id,name,createdAt
  configVersion: `${P}family:config-version`,       // STRING incremented on every matching-relevant change
  drawing: (pool) => `${P}drawings:${pool}`,         // HASH   status,generatedAt,participantCount,configVersion,participants(JSON)
  assignments: (pool) => `${P}assignments:${pool}`,  // HASH   giverId -> recipientId   (PRIVATE)
  progress: (pool) => `${P}progress:${pool}`,        // HASH   giverId -> revealedAt timestamp
  drawingLock: (pool) => `${P}lock:drawing:${pool}`, // STRING short-lived generation mutex
  tokens: `${P}participants:tokens`,                // HASH   sha256(token) -> member id
  claims: `${P}participants:claims`,                // HASH   member id -> sha256(token)
  settings: `${P}settings:app`,                     // HASH   event/gift exchange details
  adminSession: (sid) => `${P}admin:session:${sid}`, // STRING session record with TTL
  rateLimit: (bucket, id) => `${P}ratelimit:${bucket}:${id}`,
};

// Run a Lua script atomically. Wrapped so the call signature stays in one place.
export async function runScript(script, keyList, args) {
  const redis = getRedis();
  return redis.eval(script, keyList, args.map(String));
}

// With automaticDeserialization disabled, HGETALL comes back as a raw flat
// [field, value, ...] array (or null/[] when the hash is empty). Normalize to an
// object either way.
export async function hgetallSafe(key) {
  const redis = getRedis();
  const res = await redis.hgetall(key);
  if (!res) return {};
  if (Array.isArray(res)) return pairsToObject(res);
  return res;
}

// Convert a flat [k1, v1, k2, v2, ...] array (raw Lua HGETALL reply) to an object.
export function pairsToObject(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i + 1 < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}
