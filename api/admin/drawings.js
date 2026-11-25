// Admin: drawings
// GET  /api/admin/drawings                               -> status, progress & readiness per pool
// POST /api/admin/drawings { action: "generate", pool }  -> compute + validate + persist assignments
// POST /api/admin/drawings { action: "reset", pool, confirm: "RESET <POOL>" }
//
// Progress shows WHO has revealed, never WHO got WHOM. No endpoint returns the
// full assignment table.
import { endpoint, sendJson, readJson, HttpError } from '../_lib/http.js';
import { getRedis, keys, POOLS, runScript } from '../_lib/redis.js';
import { COMMIT_DRAWING, RESET_DRAWING, RELEASE_LOCK } from '../_lib/scripts.js';
import { requireAdmin, rateLimit, randomToken } from '../_lib/security.js';
import { loadMembers, loadHouseholds, loadAllDrawings } from '../_lib/data.js';
import { generateAssignments, feasibilityProblem, MatchError } from '../_lib/matching.js';
import * as v from '../_lib/validate.js';

async function overview() {
  const [members, households, drawings] = await Promise.all([loadMembers(), loadHouseholds(), loadAllDrawings()]);
  const hhName = Object.fromEntries(households.map((h) => [h.id, h.name]));
  const out = {};
  for (const pool of POOLS) {
    const d = drawings[pool];
    const poolMembers = members.filter((m) => m.category === pool);
    const roster = (d.status === 'active' ? d.participants : poolMembers.map((m) => m.id))
      .map((id) => members.find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => ({
        id: m.id,
        name: m.name,
        household: hhName[m.householdId] || '',
        claimed: m.claimed,
        revealed: Boolean(d.revealed[m.id]),
        revealedAt: d.revealed[m.id] || null,
      }));
    out[pool] = {
      status: d.status,
      generatedAt: d.generatedAt,
      participantCount: d.status === 'active' ? d.participantCount : poolMembers.length,
      revealedCount: d.revealedCount,
      claimedCount: roster.filter((r) => r.claimed).length,
      roster,
      problem: d.status === 'active' ? null : feasibilityProblem(poolMembers, hhName),
    };
  }
  return out;
}

async function generate(pool) {
  const redis = getRedis();
  const lockKey = keys.drawingLock(pool);
  const owner = randomToken(16);
  const got = await redis.set(lockKey, owner, { nx: true, px: 15_000 });
  if (got !== 'OK') throw new HttpError(409, 'A drawing is already being generated. Try again in a moment.', 'IN_PROGRESS');

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Number(await redis.exists(keys.drawing(pool))) === 1) {
        throw new HttpError(409, `The ${pool} drawing already exists. Reset it first to draw again.`, 'EXISTS');
      }
      // Read the config version BEFORE the data, so any concurrent edit is detected at commit time.
      const version = (await redis.get(keys.configVersion)) ?? '0';
      const [members, households] = await Promise.all([loadMembers(), loadHouseholds()]);
      const hhName = Object.fromEntries(households.map((h) => [h.id, h.name]));
      const participants = members.filter((m) => m.category === pool);

      let assignments;
      try {
        assignments = generateAssignments(participants, hhName);
      } catch (err) {
        if (err instanceof MatchError) throw new HttpError(422, err.message, err.code);
        throw err;
      }

      const pairs = Object.entries(assignments).flat();
      const result = await runScript(
        COMMIT_DRAWING,
        [keys.drawing(pool), keys.assignments(pool), keys.progress(pool), keys.configVersion],
        [String(version), Date.now(), pool, JSON.stringify(participants.map((p) => p.id)), ...pairs],
      );
      if (result === 'OK') return;
      if (result === 'EXISTS') throw new HttpError(409, `The ${pool} drawing already exists.`, 'EXISTS');
      if (result !== 'STALE') throw new Error(`Unexpected commit result ${result}`);
      // STALE: family list changed mid-generation; recompute with fresh data.
    }
    throw new HttpError(409, 'The family list kept changing during the drawing. Please try again.', 'STALE');
  } finally {
    await runScript(RELEASE_LOCK, [lockKey], [owner]).catch(() => {});
  }
}

export default endpoint(['GET', 'POST'], async (req, res) => {
  await requireAdmin(req);
  await rateLimit(req, 'admin', 300, 60_000);

  if (req.method === 'GET') {
    sendJson(res, 200, { drawings: await overview() });
    return;
  }

  const body = await readJson(req);
  const pool = v.pool(body.pool);

  if (body.action === 'generate') {
    await rateLimit(req, 'admin-generate', 20, 60_000);
    await generate(pool);
    sendJson(res, 200, { drawings: await overview() });
    return;
  }

  if (body.action === 'reset') {
    const expected = `RESET ${pool.toUpperCase()}`;
    if (body.confirm !== expected) {
      throw new HttpError(400, `To reset, type ${expected} exactly.`, 'CONFIRM_REQUIRED');
    }
    // Don't reset while a generation is mid-flight for this pool.
    const redis = getRedis();
    const owner = randomToken(16);
    const got = await redis.set(keys.drawingLock(pool), owner, { nx: true, px: 15_000 });
    if (got !== 'OK') throw new HttpError(409, 'A drawing is being generated right now. Try again in a moment.', 'IN_PROGRESS');
    try {
      await runScript(RESET_DRAWING, [keys.drawing(pool), keys.assignments(pool), keys.progress(pool)], []);
    } finally {
      await runScript(RELEASE_LOCK, [keys.drawingLock(pool)], [owner]).catch(() => {});
    }
    sendJson(res, 200, { drawings: await overview() });
    return;
  }

  throw new HttpError(400, 'Unknown action', 'BAD_ACTION');
});
