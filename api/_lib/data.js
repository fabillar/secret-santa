// Read-side helpers shared by the endpoints.
import { keys, POOLS, runScript, pairsToObject, hgetallSafe } from './redis.js';
import { LOAD_ALL } from './scripts.js';

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export async function loadMembers() {
  const rows = await runScript(LOAD_ALL, [keys.members], [keys.memberPrefix]);
  return (rows || [])
    .map(pairsToObject)
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id,
      name: m.name,
      householdId: m.householdId,
      category: m.category,
      claimed: m.claimed === '1',
      claimedAt: m.claimedAt ? Number(m.claimedAt) : null,
      createdAt: m.createdAt ? Number(m.createdAt) : null,
    }))
    .sort(byName);
}

export async function loadHouseholds() {
  const rows = await runScript(LOAD_ALL, [keys.households], [keys.householdPrefix]);
  return (rows || [])
    .map(pairsToObject)
    .filter((h) => h.id)
    .map((h) => ({ id: h.id, name: h.name, createdAt: h.createdAt ? Number(h.createdAt) : null }))
    .sort(byName);
}

export async function loadMember(id) {
  const m = await hgetallSafe(keys.member(id));
  if (!m.id) return null;
  return { id: m.id, name: m.name, householdId: m.householdId, category: m.category, claimed: m.claimed === '1' };
}

export const SETTINGS_FIELDS = ['eventName', 'exchangeDate', 'location', 'adultBudget', 'childBudget', 'notes'];

export const DEFAULT_SETTINGS = {
  eventName: 'Family Secret Santa',
  exchangeDate: '',
  location: '',
  adultBudget: '',
  childBudget: '',
  notes: '',
};

export async function loadSettings() {
  const s = await hgetallSafe(keys.settings);
  const out = { ...DEFAULT_SETTINGS };
  for (const f of SETTINGS_FIELDS) if (typeof s[f] === 'string') out[f] = s[f];
  return out;
}

// Drawing status for one pool. Never includes assignments.
export async function loadDrawing(pool) {
  const meta = await hgetallSafe(keys.drawing(pool));
  if (!meta.status) {
    return { pool, status: 'none', generatedAt: null, participantCount: 0, revealedCount: 0, participants: [], revealed: {} };
  }
  const progress = await hgetallSafe(keys.progress(pool));
  let participants = [];
  try { participants = JSON.parse(meta.participants || '[]'); } catch { participants = []; }
  const revealed = {};
  for (const [k, v] of Object.entries(progress)) revealed[k] = Number(v);
  return {
    pool,
    status: meta.status,
    generatedAt: Number(meta.generatedAt) || null,
    participantCount: Number(meta.participantCount) || 0,
    revealedCount: Object.keys(revealed).length,
    participants,
    revealed,
  };
}

export async function loadAllDrawings() {
  const entries = await Promise.all(POOLS.map(async (p) => [p, await loadDrawing(p)]));
  return Object.fromEntries(entries);
}
