// POST /api/claim { memberId }
// Atomically claims a family member's name for this device. The raw access
// token is returned once (as a recovery code) and stored in an HttpOnly cookie;
// only its SHA-256 hash is persisted in Redis.
import { endpoint, sendJson, readJson, HttpError } from './_lib/http.js';
import { keys, runScript } from './_lib/redis.js';
import { CLAIM } from './_lib/scripts.js';
import * as v from './_lib/validate.js';
import {
  rateLimit, randomToken, sha256, readParticipantTokens, writeParticipantTokens, MAX_IDENTITIES,
} from './_lib/security.js';
import { loadMember } from './_lib/data.js';

export default endpoint(['POST'], async (req, res) => {
  await rateLimit(req, 'claim', 15, 10 * 60_000);
  const body = await readJson(req);
  const memberId = v.id(body.memberId, 'memberId');

  const existing = readParticipantTokens(req);
  if (existing.length >= MAX_IDENTITIES) {
    throw new HttpError(400, `This device already holds ${MAX_IDENTITIES} names.`, 'TOO_MANY_IDENTITIES');
  }

  const token = randomToken(32);
  const result = await runScript(
    CLAIM,
    [keys.claims, keys.tokens, keys.member(memberId)],
    [memberId, sha256(token), Date.now()],
  );

  if (result === 'NOT_FOUND') throw new HttpError(404, 'That name no longer exists.', 'NOT_FOUND');
  if (result === 'ALREADY_CLAIMED') {
    throw new HttpError(409, 'Someone has already claimed that name. If it was you on another device, use your recovery code. Otherwise ask the organizer.', 'ALREADY_CLAIMED');
  }
  if (result !== 'OK') throw new Error(`Unexpected claim result: ${result}`);

  writeParticipantTokens(res, [...existing, token]);
  const member = await loadMember(memberId);
  sendJson(res, 200, {
    member: { id: member.id, name: member.name, category: member.category },
    recoveryCode: token,
  });
});
