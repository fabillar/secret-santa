// GET /api/state — public, read-only overview used by the participant page.
// Contains names, households and claim status only. Never assignments.
import { endpoint, sendJson } from './_lib/http.js';
import { rateLimit } from './_lib/security.js';
import { loadMembers, loadHouseholds, loadSettings, loadAllDrawings } from './_lib/data.js';

export default endpoint(['GET'], async (req, res) => {
  await rateLimit(req, 'state', 120, 60_000);
  const [members, households, settings, drawings] = await Promise.all([
    loadMembers(),
    loadHouseholds(),
    loadSettings(),
    loadAllDrawings(),
  ]);

  const publicDrawings = {};
  for (const [pool, d] of Object.entries(drawings)) {
    publicDrawings[pool] = {
      status: d.status,
      generatedAt: d.generatedAt,
      participantCount: d.participantCount,
      revealedCount: d.revealedCount,
    };
  }

  sendJson(res, 200, {
    settings,
    households: households.map(({ id, name }) => ({ id, name })),
    members: members.map(({ id, name, householdId, category, claimed }) => ({ id, name, householdId, category, claimed })),
    drawings: publicDrawings,
  });
});
