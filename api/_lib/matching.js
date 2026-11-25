// Server-side matching engine.
//
// Rules enforced for every pool (Adult and Child are drawn separately):
//   * no self-matching
//   * no matching within the same household
//   * every participant gives to exactly one recipient
//   * every participant receives from exactly one giver (no duplicate recipients)
//
// Strategy: uniform rejection sampling over random permutations (cryptographic
// RNG), which gives every valid arrangement an equal chance. If the constraints
// are tight and sampling does not find one quickly, fall back to a randomized
// bipartite matching (Kuhn's augmenting paths), which always finds a valid
// arrangement when one exists.

import crypto from 'node:crypto';

export class MatchError extends Error {
  constructor(message, code = 'NO_VALID_MATCH') {
    super(message);
    this.code = code;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const eligible = (giver, recipient) =>
  giver.id !== recipient.id && giver.householdId !== recipient.householdId;

// Explain why no arrangement is possible, in terms the organizer can act on.
export function feasibilityProblem(participants, householdNames = {}) {
  const n = participants.length;
  if (n === 0) return 'There are no participants in this pool yet.';
  if (n < 2) return 'At least 2 participants are needed.';
  const counts = new Map();
  for (const p of participants) counts.set(p.householdId, (counts.get(p.householdId) || 0) + 1);
  if (counts.size < 2) return 'Everyone is in the same household, so nobody has anyone to give to. Participants from at least 2 households are needed.';
  for (const [hid, c] of counts) {
    // Members of a household of size c need c distinct recipients outside it.
    if (c > n - c) {
      const label = householdNames[hid] ? `"${householdNames[hid]}"` : 'One household';
      return `${label} has ${c} of the ${n} participants. Each household can have at most half of a pool, otherwise its members run out of people to draw.`;
    }
  }
  return null;
}

export function validateAssignments(participants, assignments) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const givers = Object.keys(assignments);
  if (givers.length !== participants.length) throw new MatchError('Assignment count mismatch', 'INVALID');
  const recipients = new Set();
  for (const g of givers) {
    const giver = byId.get(g);
    const recipient = byId.get(assignments[g]);
    if (!giver || !recipient) throw new MatchError('Unknown participant in assignment', 'INVALID');
    if (giver.id === recipient.id) throw new MatchError('Self-match detected', 'INVALID');
    if (giver.householdId === recipient.householdId) throw new MatchError('Same-household match detected', 'INVALID');
    if (recipients.has(recipient.id)) throw new MatchError('Duplicate recipient detected', 'INVALID');
    recipients.add(recipient.id);
  }
  if (recipients.size !== participants.length) throw new MatchError('Not everyone receives a gift', 'INVALID');
  return true;
}

function sample(participants, attempts) {
  for (let t = 0; t < attempts; t++) {
    const perm = shuffle(participants);
    let ok = true;
    for (let i = 0; i < participants.length; i++) {
      if (!eligible(participants[i], perm[i])) { ok = false; break; }
    }
    if (ok) {
      const out = {};
      participants.forEach((p, i) => { out[p.id] = perm[i].id; });
      return out;
    }
  }
  return null;
}

function bipartite(participants) {
  const givers = shuffle(participants);
  const candidates = new Map(
    givers.map((g) => [g.id, shuffle(participants.filter((r) => eligible(g, r))).map((r) => r.id)]),
  );
  const giverOf = new Map(); // recipientId -> giverId

  const tryAssign = (giverId, seen) => {
    for (const r of candidates.get(giverId)) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (!giverOf.has(r) || tryAssign(giverOf.get(r), seen)) {
        giverOf.set(r, giverId);
        return true;
      }
    }
    return false;
  };

  for (const g of givers) {
    if (!tryAssign(g.id, new Set())) return null;
  }
  const out = {};
  for (const [r, g] of giverOf) out[g] = r;
  return out;
}

/**
 * @param {{id:string, householdId:string}[]} participants
 * @returns {Record<string,string>} giverId -> recipientId
 */
export function generateAssignments(participants, householdNames = {}) {
  const problem = feasibilityProblem(participants, householdNames);
  if (problem) throw new MatchError(problem);

  const result = sample(participants, 20000) || bipartite(participants);
  if (!result) throw new MatchError('No valid arrangement exists for these households.');
  validateAssignments(participants, result);
  return result;
}
