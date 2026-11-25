// Admin: households
// GET    /api/admin/households
// POST   /api/admin/households { name }
// PUT    /api/admin/households { id, name }
// DELETE /api/admin/households?id=...   (only when the household has no members)
import { endpoint, sendJson, readJson, queryParam, HttpError } from '../_lib/http.js';
import { keys, runScript } from '../_lib/redis.js';
import { CREATE_HOUSEHOLD, RENAME_HOUSEHOLD, DELETE_HOUSEHOLD } from '../_lib/scripts.js';
import { requireAdmin, rateLimit, randomId } from '../_lib/security.js';
import { loadHouseholds, loadMembers } from '../_lib/data.js';
import * as v from '../_lib/validate.js';

async function list() {
  const [households, members] = await Promise.all([loadHouseholds(), loadMembers()]);
  return households.map((h) => ({ ...h, memberCount: members.filter((m) => m.householdId === h.id).length }));
}

export default endpoint(['GET', 'POST', 'PUT', 'DELETE'], async (req, res) => {
  await requireAdmin(req);
  await rateLimit(req, 'admin', 300, 60_000);

  if (req.method === 'GET') {
    sendJson(res, 200, { households: await list() });
    return;
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = v.name(body.name, 'Household name');
    const existing = await loadHouseholds();
    if (existing.some((h) => v.nameKey(h.name) === v.nameKey(name))) {
      throw new HttpError(409, 'A household with that name already exists.', 'DUPLICATE_NAME');
    }
    const id = randomId();
    const r = await runScript(CREATE_HOUSEHOLD, [keys.households, keys.household(id)], [id, name, Date.now()]);
    if (r !== 'OK') throw new Error(`Unexpected result ${r}`);
    sendJson(res, 201, { households: await list() });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const id = v.id(body.id);
    const name = v.name(body.name, 'Household name');
    const r = await runScript(RENAME_HOUSEHOLD, [keys.household(id)], [name]);
    if (r === 'NOT_FOUND') throw new HttpError(404, 'Household not found', 'NOT_FOUND');
    sendJson(res, 200, { households: await list() });
    return;
  }

  // DELETE
  const id = v.id(queryParam(req, 'id'));
  const r = await runScript(
    DELETE_HOUSEHOLD,
    [keys.households, keys.household(id), keys.members],
    [id, keys.memberPrefix],
  );
  if (r === 'NOT_FOUND') throw new HttpError(404, 'Household not found', 'NOT_FOUND');
  if (r === 'HAS_MEMBERS') throw new HttpError(409, 'Move or remove everyone in this household first.', 'HAS_MEMBERS');
  sendJson(res, 200, { households: await list() });
});
