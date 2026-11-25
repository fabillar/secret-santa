// Admin: family members
// GET    /api/admin/members
// POST   /api/admin/members { name, householdId, category }
// POST   /api/admin/members { action: "release", id }   -> un-claim a name (lost device etc.)
// PUT    /api/admin/members { id, name, householdId, category }
// DELETE /api/admin/members?id=...
//
// Structural changes (adding/removing people, changing household or category)
// are rejected while the affected pool has an active drawing. Name-only edits
// are allowed because they do not change any match.
import { endpoint, sendJson, readJson, queryParam, HttpError } from '../_lib/http.js';
import { keys, runScript } from '../_lib/redis.js';
import { CREATE_MEMBER, UPDATE_MEMBER, DELETE_MEMBER, RELEASE_CLAIM } from '../_lib/scripts.js';
import { requireAdmin, rateLimit, randomId } from '../_lib/security.js';
import { loadMembers } from '../_lib/data.js';
import * as v from '../_lib/validate.js';

const LOCKED_MSG =
  'This pool has an active drawing, so its participants and households are locked. Reset that drawing first (Drawings tab) to make this change.';

function fail(result) {
  switch (result) {
    case 'OK': return;
    case 'NOT_FOUND': throw new HttpError(404, 'Family member not found', 'NOT_FOUND');
    case 'LOCKED': throw new HttpError(423, LOCKED_MSG, 'LOCKED');
    case 'NO_HOUSEHOLD': throw new HttpError(400, 'Choose an existing household', 'NO_HOUSEHOLD');
    case 'DUPLICATE_NAME': throw new HttpError(409, 'Someone with that name already exists. Add a last initial to tell them apart.', 'DUPLICATE_NAME');
    default: throw new Error(`Unexpected result ${result}`);
  }
}

export default endpoint(['GET', 'POST', 'PUT', 'DELETE'], async (req, res) => {
  await requireAdmin(req);
  await rateLimit(req, 'admin', 300, 60_000);

  if (req.method === 'GET') {
    sendJson(res, 200, { members: await loadMembers() });
    return;
  }

  if (req.method === 'POST') {
    const body = await readJson(req);

    if (body.action === 'release') {
      const id = v.id(body.id);
      fail(await runScript(RELEASE_CLAIM, [keys.claims, keys.tokens, keys.member(id)], [id]));
      sendJson(res, 200, { members: await loadMembers() });
      return;
    }

    const name = v.name(body.name);
    const householdId = v.id(body.householdId, 'householdId');
    const category = v.category(body.category);
    const id = randomId();
    fail(await runScript(
      CREATE_MEMBER,
      [keys.members, keys.member(id), keys.household(householdId), keys.memberNames, keys.drawing(category), keys.configVersion],
      [id, name, v.nameKey(name), householdId, category, Date.now()],
    ));
    sendJson(res, 201, { members: await loadMembers() });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const id = v.id(body.id);
    const name = v.name(body.name);
    const householdId = v.id(body.householdId, 'householdId');
    const category = v.category(body.category);
    fail(await runScript(
      UPDATE_MEMBER,
      [keys.member(id), keys.memberNames, keys.drawing('adult'), keys.drawing('child'), keys.configVersion, keys.household(householdId)],
      [id, name, v.nameKey(name), householdId, category],
    ));
    sendJson(res, 200, { members: await loadMembers() });
    return;
  }

  // DELETE
  const id = v.id(queryParam(req, 'id'));
  fail(await runScript(
    DELETE_MEMBER,
    [keys.members, keys.member(id), keys.memberNames, keys.drawing('adult'), keys.drawing('child'), keys.claims, keys.tokens, keys.configVersion],
    [id],
  ));
  sendJson(res, 200, { members: await loadMembers() });
});
