// POST /api/spin { memberId }
// Returns the predetermined recipient for a name claimed on this device and
// records the reveal. The wheel in the browser is purely an animation that
// lands on this server-chosen result; the assignment already exists in Redis
// before any wheel can spin.
import { endpoint, sendJson, readJson, HttpError } from './_lib/http.js';
import { keys, runScript } from './_lib/redis.js';
import { REVEAL } from './_lib/scripts.js';
import * as v from './_lib/validate.js';
import { rateLimit, resolveParticipants } from './_lib/security.js';
import { loadMembers, loadHouseholds, loadDrawing } from './_lib/data.js';

export default endpoint(['POST'], async (req, res) => {
  await rateLimit(req, 'spin', 30, 60_000);
  const body = await readJson(req);
  const memberId = v.id(body.memberId, 'memberId');

  const { identities } = await resolveParticipants(req);
  if (!identities.some((i) => i.memberId === memberId)) {
    throw new HttpError(403, 'You can only spin for a name you have claimed on this device.', 'NOT_YOURS');
  }

  const members = await loadMembers();
  const me = members.find((m) => m.id === memberId);
  if (!me) throw new HttpError(404, 'That name no longer exists.', 'NOT_FOUND');
  const pool = me.category;

  const [status, recipientId, revealedAt, first] = await runScript(
    REVEAL,
    [keys.drawing(pool), keys.assignments(pool), keys.progress(pool)],
    [memberId, Date.now()],
  );
  if (status === 'NO_DRAWING') {
    throw new HttpError(409, `The ${pool} drawing has not been generated yet. Check back once the organizer starts it.`, 'NO_DRAWING');
  }
  if (status === 'NOT_IN_DRAWING') {
    throw new HttpError(409, 'You were added after this drawing was generated. Please ask the organizer.', 'NOT_IN_DRAWING');
  }

  const byId = new Map(members.map((m) => [m.id, m]));
  const households = await loadHouseholds();
  const hhName = new Map(households.map((h) => [h.id, h.name]));
  const recipient = byId.get(recipientId);
  if (!recipient) throw new Error('Assignment points at a missing member');

  // Wheel slices: everyone this person could have drawn (other households in
  // the same pool). Names are already public, so this leaks nothing.
  const drawing = await loadDrawing(pool);
  const wheel = drawing.participants
    .filter((id) => id !== memberId && byId.get(id)?.householdId !== me.householdId)
    .map((id) => byId.get(id)?.name)
    .filter(Boolean);

  sendJson(res, 200, {
    recipient: { id: recipient.id, name: recipient.name, household: hhName.get(recipient.householdId) || '' },
    revealedAt: Number(revealedAt),
    firstReveal: first === '1',
    wheel,
  });
});
