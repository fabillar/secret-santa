// Admin: gift exchange details shown to everyone on the participant page.
// GET /api/admin/settings
// PUT /api/admin/settings { eventName, exchangeDate, location, adultBudget, childBudget, notes }
import { endpoint, sendJson, readJson } from '../_lib/http.js';
import { getRedis, keys } from '../_lib/redis.js';
import { requireAdmin, rateLimit } from '../_lib/security.js';
import { loadSettings } from '../_lib/data.js';
import * as v from '../_lib/validate.js';

export default endpoint(['GET', 'PUT'], async (req, res) => {
  await requireAdmin(req);
  await rateLimit(req, 'admin', 300, 60_000);

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const next = {
      eventName: v.text(body.eventName, 'Event name', 80, { required: true }),
      exchangeDate: v.isoDate(body.exchangeDate, 'Exchange date'),
      location: v.text(body.location, 'Location', 120),
      adultBudget: v.text(body.adultBudget, 'Adult budget', 40),
      childBudget: v.text(body.childBudget, 'Child budget', 40),
      notes: v.text(body.notes, 'Notes', 1000),
    };
    await getRedis().hset(keys.settings, { ...next, updatedAt: String(Date.now()) });
  }

  sendJson(res, 200, { settings: await loadSettings() });
});
