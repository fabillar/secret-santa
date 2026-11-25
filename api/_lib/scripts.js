// Lua scripts. Each runs atomically inside Redis, which is how this app prevents
// race conditions (double claims, edits during a drawing, concurrent generation,
// duplicate assignments) without any other coordination service.
//
// Scripts return short status strings ("OK", "LOCKED", ...) that the JS layer
// maps to HTTP errors.

// --- Rate limiting --------------------------------------------------------
// KEYS[1] counter key. ARGV[1] window ms. Returns {count, pttl}.
export const RATE_LIMIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
`;

// --- Read helpers ---------------------------------------------------------
// KEYS[1] id set. ARGV[1] hash key prefix. Returns {{k,v,k,v...}, ...}.
export const LOAD_ALL = `
local ids = redis.call('SMEMBERS', KEYS[1])
local out = {}
for i, id in ipairs(ids) do
  local h = redis.call('HGETALL', ARGV[1] .. id)
  if #h > 0 then table.insert(out, h) end
end
return out
`;

// --- Claiming --------------------------------------------------------------
// KEYS: 1 claims hash, 2 tokens hash, 3 member hash
// ARGV: 1 memberId, 2 tokenHash, 3 now
export const CLAIM = `
if redis.call('EXISTS', KEYS[3]) == 0 then return 'NOT_FOUND' end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 'ALREADY_CLAIMED' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[3], 'claimed', '1', 'claimedAt', ARGV[3])
return 'OK'
`;

// KEYS: 1 claims, 2 tokens, 3 member hash. ARGV: 1 memberId
export const RELEASE_CLAIM = `
if redis.call('EXISTS', KEYS[3]) == 0 then return 'NOT_FOUND' end
local h = redis.call('HGET', KEYS[1], ARGV[1])
if h then
  redis.call('HDEL', KEYS[2], h)
  redis.call('HDEL', KEYS[1], ARGV[1])
end
redis.call('HSET', KEYS[3], 'claimed', '0')
redis.call('HDEL', KEYS[3], 'claimedAt')
return 'OK'
`;

// --- Households -------------------------------------------------------------
// KEYS: 1 households set, 2 household hash. ARGV: 1 id, 2 name, 3 now
export const CREATE_HOUSEHOLD = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'EXISTS' end
redis.call('HSET', KEYS[2], 'id', ARGV[1], 'name', ARGV[2], 'createdAt', ARGV[3])
redis.call('SADD', KEYS[1], ARGV[1])
return 'OK'
`;

// Renaming a household never affects matching, so it is always allowed.
// KEYS: 1 household hash. ARGV: 1 name
export const RENAME_HOUSEHOLD = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_FOUND' end
redis.call('HSET', KEYS[1], 'name', ARGV[1])
return 'OK'
`;

// A household can only be deleted when empty, so deleting one can never change
// an active drawing.
// KEYS: 1 households set, 2 household hash, 3 members set
// ARGV: 1 id, 2 member hash prefix
export const DELETE_HOUSEHOLD = `
if redis.call('EXISTS', KEYS[2]) == 0 then return 'NOT_FOUND' end
local ids = redis.call('SMEMBERS', KEYS[3])
for i, mid in ipairs(ids) do
  if redis.call('HGET', ARGV[2] .. mid, 'householdId') == ARGV[1] then return 'HAS_MEMBERS' end
end
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], ARGV[1])
return 'OK'
`;

// --- Members ----------------------------------------------------------------
// KEYS: 1 members set, 2 member hash, 3 household hash, 4 names hash,
//       5 drawing hash for the member's pool, 6 config version
// ARGV: 1 id, 2 name, 3 nameKey, 4 householdId, 5 category, 6 now
export const CREATE_MEMBER = `
if redis.call('EXISTS', KEYS[5]) == 1 then return 'LOCKED' end
if redis.call('EXISTS', KEYS[3]) == 0 then return 'NO_HOUSEHOLD' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'EXISTS' end
if redis.call('HSETNX', KEYS[4], ARGV[3], ARGV[1]) == 0 then return 'DUPLICATE_NAME' end
redis.call('HSET', KEYS[2], 'id', ARGV[1], 'name', ARGV[2], 'nameKey', ARGV[3],
  'householdId', ARGV[4], 'category', ARGV[5], 'claimed', '0', 'createdAt', ARGV[6])
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[6])
return 'OK'
`;

// Name-only edits (typo fixes) are allowed while a drawing is active because
// they do not change who is matched with whom. Household/category changes are
// structural and require the affected drawing(s) to be reset first.
// KEYS: 1 member hash, 2 names hash, 3 adult drawing, 4 child drawing,
//       5 config version, 6 new household hash
// ARGV: 1 id, 2 name, 3 nameKey, 4 householdId, 5 category
export const UPDATE_MEMBER = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'NOT_FOUND' end
local cur = redis.call('HMGET', KEYS[1], 'nameKey', 'householdId', 'category')
local structural = (cur[2] ~= ARGV[4]) or (cur[3] ~= ARGV[5])
if structural then
  local oldD = KEYS[4]
  if cur[3] == 'adult' then oldD = KEYS[3] end
  local newD = KEYS[4]
  if ARGV[5] == 'adult' then newD = KEYS[3] end
  if redis.call('EXISTS', oldD) == 1 or redis.call('EXISTS', newD) == 1 then return 'LOCKED' end
  if redis.call('EXISTS', KEYS[6]) == 0 then return 'NO_HOUSEHOLD' end
end
if cur[1] ~= ARGV[3] then
  local owner = redis.call('HGET', KEYS[2], ARGV[3])
  if owner and owner ~= ARGV[1] then return 'DUPLICATE_NAME' end
  if cur[1] then redis.call('HDEL', KEYS[2], cur[1]) end
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[1])
end
redis.call('HSET', KEYS[1], 'name', ARGV[2], 'nameKey', ARGV[3], 'householdId', ARGV[4], 'category', ARGV[5])
if structural then redis.call('INCR', KEYS[5]) end
return 'OK'
`;

// KEYS: 1 members set, 2 member hash, 3 names hash, 4 adult drawing,
//       5 child drawing, 6 claims, 7 tokens, 8 config version
// ARGV: 1 id
export const DELETE_MEMBER = `
if redis.call('EXISTS', KEYS[2]) == 0 then return 'NOT_FOUND' end
local cur = redis.call('HMGET', KEYS[2], 'category', 'nameKey')
local d = KEYS[5]
if cur[1] == 'adult' then d = KEYS[4] end
if redis.call('EXISTS', d) == 1 then return 'LOCKED' end
if cur[2] then redis.call('HDEL', KEYS[3], cur[2]) end
local h = redis.call('HGET', KEYS[6], ARGV[1])
if h then
  redis.call('HDEL', KEYS[7], h)
  redis.call('HDEL', KEYS[6], ARGV[1])
end
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[8])
return 'OK'
`;

// --- Drawings ---------------------------------------------------------------
// Distributed mutex release: only delete the lock if we still own it.
// KEYS: 1 lock key. ARGV: 1 owner token
export const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// Persist a complete, pre-validated assignment set. Fails if a drawing already
// exists for this pool or if the family configuration changed after the
// assignments were computed (optimistic concurrency on the config version).
// KEYS: 1 drawing hash, 2 assignments hash, 3 progress hash, 4 config version
// ARGV: 1 expected config version, 2 generatedAt, 3 pool, 4 participants JSON,
//       5.. giverId, recipientId pairs
export const COMMIT_DRAWING = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'EXISTS' end
local v = redis.call('GET', KEYS[4])
if not v then v = '0' end
if v ~= ARGV[1] then return 'STALE' end
redis.call('DEL', KEYS[2], KEYS[3])
local n = 0
local seen = {}
for i = 5, #ARGV, 2 do
  local giver = ARGV[i]
  local rec = ARGV[i + 1]
  if giver == rec then return redis.error_reply('SELF_MATCH') end
  if seen[rec] then return redis.error_reply('DUPLICATE_RECIPIENT') end
  seen[rec] = true
  redis.call('HSET', KEYS[2], giver, rec)
  n = n + 1
end
redis.call('HSET', KEYS[1], 'status', 'active', 'pool', ARGV[3], 'generatedAt', ARGV[2],
  'participantCount', tostring(n), 'configVersion', v, 'participants', ARGV[4])
return 'OK'
`;

// KEYS: 1 drawing, 2 assignments, 3 progress. Returns number of keys removed.
export const RESET_DRAWING = `
return redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
`;

// Look up a participant's recipient and record that they revealed it.
// KEYS: 1 drawing, 2 assignments, 3 progress. ARGV: 1 giverId, 2 now
// Returns {status, recipientId, revealedAt, firstReveal}
export const REVEAL = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NO_DRAWING', '', '', '0'} end
local r = redis.call('HGET', KEYS[2], ARGV[1])
if not r then return {'NOT_IN_DRAWING', '', '', '0'} end
local first = redis.call('HSETNX', KEYS[3], ARGV[1], ARGV[2])
local at = redis.call('HGET', KEYS[3], ARGV[1])
return {'OK', r, at, tostring(first)}
`;
