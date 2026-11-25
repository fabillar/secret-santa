// GET  /api/me                                   -> names claimed on this device + their status
// POST /api/me { action: "recover", code }       -> add a name to this device using a recovery code
// POST /api/me { action: "forget", memberId }    -> remove a name from this device (claim is kept)
//
// A participant only ever sees their own recipient, and only after they have
// revealed it with the wheel.
import { endpoint, sendJson, readJson, HttpError } from './_lib/http.js';
import { getRedis, keys } from './_lib/redis.js';
import * as v from './_lib/validate.js';
import {
  rateLimit, sha256, isValidTokenFormat, resolveParticipants, writeParticipantTokens, MAX_IDENTITIES,
  normalizeHmget,
} from './_lib/security.js';
import { loadMembers, loadHouseholds, loadAllDrawings } from './_lib/data.js';

async function describeIdentities(identities) {
  if (!identities.length) return [];
  const redis = getRedis();
  const [members, households, drawings] = await Promise.all([loadMembers(), loadHouseholds(), loadAllDrawings()]);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const hhName = new Map(households.map((h) => [h.id, h.name]));

  const out = [];
  for (const { memberId } of identities) {
    const m = memberById.get(memberId);
    if (!m) continue;
    const d = drawings[m.category];
    const inDrawing = d.status === 'active' && d.participants.includes(m.id);
    const revealedAt = inDrawing ? d.revealed[m.id] || null : null;
    let recipient = null;
    if (revealedAt) {
      const [rid] = normalizeHmget(await redis.hmget(keys.assignments(m.category), m.id), [m.id]);
      const r = rid && memberById.get(rid);
      if (r) recipient = { id: r.id, name: r.name, household: hhName.get(r.householdId) || '' };
    }
    out.push({
      id: m.id,
      name: m.name,
      category: m.category,
      household: hhName.get(m.householdId) || '',
      drawingStatus: d.status,
      inDrawing,
      revealedAt,
      recipient,
    });
  }
  return out;
}

export default endpoint(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    await rateLimit(req, 'me', 120, 60_000);
    const { tokens, identities } = await resolveParticipants(req);
    // Drop tokens that no longer resolve (e.g. the organizer released the claim).
    if (identities.length !== tokens.length) writeParticipantTokens(res, identities.map((i) => i.token));
    sendJson(res, 200, { identities: await describeIdentities(identities) });
    return;
  }

  const body = await readJson(req);

  if (body.action === 'recover') {
    await rateLimit(req, 'recover', 10, 15 * 60_000);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!isValidTokenFormat(code)) throw new HttpError(400, 'That recovery code is not valid.', 'BAD_CODE');
    const memberId = await getRedis().hget(keys.tokens, sha256(code));
    if (!memberId) throw new HttpError(404, 'That recovery code is not valid.', 'BAD_CODE');
    const { identities } = await resolveParticipants(req);
    const tokens = identities.map((i) => i.token).filter((t) => t !== code);
    if (tokens.length >= MAX_IDENTITIES) throw new HttpError(400, 'This device holds too many names.', 'TOO_MANY_IDENTITIES');
    tokens.push(code);
    writeParticipantTokens(res, tokens);
    sendJson(res, 200, { identities: await describeIdentities([...identities.filter((i) => i.token !== code), { token: code, memberId }]) });
    return;
  }

  if (body.action === 'forget') {
    await rateLimit(req, 'me-write', 30, 60_000);
    const memberId = v.id(body.memberId, 'memberId');
    const { identities } = await resolveParticipants(req);
    const remaining = identities.filter((i) => i.memberId !== memberId);
    writeParticipantTokens(res, remaining.map((i) => i.token));
    sendJson(res, 200, { identities: await describeIdentities(remaining) });
    return;
  }

  throw new HttpError(400, 'Unknown action', 'BAD_ACTION');
});
