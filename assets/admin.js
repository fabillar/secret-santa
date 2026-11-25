// Organizer dashboard. Authentication is an HttpOnly cookie set by the server;
// this script never sees the password after submitting it, nor any secret.
import { api, h, toast, formatTime, ApiError } from './common.js';

const $ = (id) => document.getElementById(id);
const data = { households: [], members: [], drawings: null, settings: null };
const POOL_LABEL = { adult: 'Adults drawing', child: 'Kids drawing' };

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) d.close();
  });
}

function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    showLogin();
    toast('Your session ended. Sign in again.', { bad: true });
    return;
  }
  toast(err.message, { bad: true });
}

// ---------------------------------------------------------------- auth
function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('password').focus();
}

async function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  await refreshAll();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  try {
    await api('/api/admin/session', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/admin/session', { method: 'DELETE' }); } catch { /* ignore */ }
  showLogin();
});

// ---------------------------------------------------------------- tabs
const tabs = ['family', 'drawings', 'event'];
for (const t of tabs) {
  $(`tab-${t}`).addEventListener('click', () => selectTab(t));
}
function selectTab(name) {
  for (const t of tabs) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  if (name === 'drawings') refreshDrawings().catch(handleError);
}

// ---------------------------------------------------------------- data
async function refreshAll() {
  try {
    const [hh, mm, dr, st] = await Promise.all([
      api('/api/admin/households'),
      api('/api/admin/members'),
      api('/api/admin/drawings'),
      api('/api/admin/settings'),
    ]);
    data.households = hh.households;
    data.members = mm.members;
    data.drawings = dr.drawings;
    data.settings = st.settings;
    renderFamily();
    renderDrawings();
    renderSettings();
  } catch (err) {
    handleError(err);
  }
}

async function refreshDrawings() {
  data.drawings = (await api('/api/admin/drawings')).drawings;
  renderDrawings();
}

const householdName = (id) => data.households.find((x) => x.id === id)?.name || '—';
const locked = (pool) => data.drawings?.[pool]?.status === 'active';

// ---------------------------------------------------------------- family
function householdOptions(select, selected) {
  select.replaceChildren(
    ...data.households.map((hh) => h('option', { value: hh.id, selected: hh.id === selected }, hh.name)),
  );
}

function renderFamily() {
  $('admin-title').textContent = data.settings?.eventName || 'Organizer';
  householdOptions($('member-household'), $('member-household').value);
  $('member-form').querySelector('button').disabled = data.households.length === 0;

  // Households
  if (!data.households.length) {
    $('households-table').replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'hint', text: 'Add a household first, then add the people in it.' }))));
  } else {
    $('households-table').replaceChildren(
      h('thead', {}, h('tr', {}, h('th', { text: 'Household' }), h('th', { text: 'People' }), h('th', {}))),
      h('tbody', {}, ...data.households.map((hh) =>
        h('tr', {},
          h('td', { text: hh.name }),
          h('td', { text: String(hh.memberCount) }),
          h('td', { class: 'actions' },
            h('button', { type: 'button', class: 'ghost small', onclick: () => renameHousehold(hh) }, 'Rename'),
            h('button', { type: 'button', class: 'danger small', disabled: hh.memberCount > 0, title: hh.memberCount ? 'Remove its people first' : null, onclick: () => deleteHousehold(hh) }, 'Delete'),
          ),
        ))),
    );
  }

  // Members
  if (!data.members.length) {
    $('members-table').replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'hint', text: 'Nobody added yet.' }))));
    return;
  }
  $('members-table').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Household' }), h('th', { text: 'Drawing' }), h('th', { text: 'Claimed' }), h('th', {}))),
    h('tbody', {}, ...data.members.map((m) =>
      h('tr', {},
        h('td', { text: m.name }),
        h('td', { text: householdName(m.householdId) }),
        h('td', {}, h('span', { class: `pill ${m.category}`, text: m.category === 'child' ? 'Kids' : 'Adults' })),
        h('td', {}, h('span', { class: `pill ${m.claimed ? 'yes' : 'no'}`, text: m.claimed ? 'Yes' : 'No' })),
        h('td', { class: 'actions' },
          h('button', { type: 'button', class: 'ghost small', onclick: () => openEdit(m) }, 'Edit'),
          m.claimed ? h('button', { type: 'button', class: 'ghost small', onclick: () => release(m), title: 'Lets someone claim this name again' }, 'Release') : null,
          h('button', { type: 'button', class: 'danger small', disabled: locked(m.category), title: locked(m.category) ? 'Reset this drawing first' : null, onclick: () => deleteMember(m) }, 'Delete'),
        ),
      ))),
  );
}

$('household-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/admin/households', { method: 'POST', body: { name: $('household-name').value } });
    data.households = res.households;
    $('household-name').value = '';
    renderFamily();
    toast('Household added');
  } catch (err) { handleError(err); }
});

async function renameHousehold(hh) {
  const name = prompt('Rename household', hh.name);
  if (!name || name === hh.name) return;
  try {
    data.households = (await api('/api/admin/households', { method: 'PUT', body: { id: hh.id, name } })).households;
    renderFamily();
    toast('Household renamed');
  } catch (err) { handleError(err); }
}

async function deleteHousehold(hh) {
  if (!confirm(`Delete the ${hh.name} household?`)) return;
  try {
    data.households = (await api(`/api/admin/households?id=${encodeURIComponent(hh.id)}`, { method: 'DELETE' })).households;
    renderFamily();
    toast('Household deleted');
  } catch (err) { handleError(err); }
}

$('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/admin/members', {
      method: 'POST',
      body: { name: $('member-name').value, householdId: $('member-household').value, category: $('member-category').value },
    });
    data.members = res.members;
    $('member-name').value = '';
    $('member-name').focus();
    await refreshCounts();
    toast('Person added');
  } catch (err) { handleError(err); }
});

async function refreshCounts() {
  data.households = (await api('/api/admin/households')).households;
  renderFamily();
}

let editing = null;
function openEdit(m) {
  editing = m;
  $('edit-name').value = m.name;
  householdOptions($('edit-household'), m.householdId);
  $('edit-category').value = m.category;
  $('edit-error').classList.add('hidden');
  $('edit-dialog').showModal();
}

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/admin/members', {
      method: 'PUT',
      body: { id: editing.id, name: $('edit-name').value, householdId: $('edit-household').value, category: $('edit-category').value },
    });
    data.members = res.members;
    $('edit-dialog').close();
    await refreshCounts();
    toast('Changes saved');
  } catch (err) {
    if (err.status === 401) return handleError(err);
    $('edit-error').textContent = err.message;
    $('edit-error').classList.remove('hidden');
  }
});

async function release(m) {
  if (!confirm(`Release ${m.name}? Whoever claimed it loses access, and anyone can claim the name again. Their match stays the same.`)) return;
  try {
    data.members = (await api('/api/admin/members', { method: 'POST', body: { action: 'release', id: m.id } })).members;
    renderFamily();
    toast(`${m.name} released`);
  } catch (err) { handleError(err); }
}

async function deleteMember(m) {
  if (!confirm(`Delete ${m.name}? If they claimed their name, that claim goes too.`)) return;
  try {
    data.members = (await api(`/api/admin/members?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })).members;
    await refreshCounts();
    toast(`${m.name} deleted`);
  } catch (err) { handleError(err); }
}

// ---------------------------------------------------------------- drawings
function renderDrawings() {
  if (!data.drawings) return;
  $('pools').replaceChildren(...['adult', 'child'].map((pool) => {
    const d = data.drawings[pool];
    const active = d.status === 'active';
    const pct = active && d.participantCount ? Math.round((d.revealedCount / d.participantCount) * 100) : 0;

    const head = h('div', { class: 'pool-head' },
      h('div', {},
        h('h2', { text: POOL_LABEL[pool] }),
        h('p', { class: `status ${active ? 'active' : ''}` },
          active ? `Drawn ${formatTime(d.generatedAt)}. Family list is locked for this drawing.` : 'Not drawn yet'),
        h('p', { class: 'hint', text: `${d.participantCount} ${d.participantCount === 1 ? 'person' : 'people'}, ${d.claimedCount} claimed so far.` }),
      ),
      active
        ? h('button', { type: 'button', class: 'danger', onclick: () => openReset(pool) }, 'Reset drawing')
        : h('button', { type: 'button', class: 'primary', disabled: Boolean(d.problem), onclick: (e) => generate(pool, e.currentTarget) }, 'Make the drawing'),
    );

    const progress = active
      ? [h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Spin progress' }, h('span', { style: `width:${pct}%` })),
        h('p', { class: 'hint', text: `${d.revealedCount} of ${d.participantCount} spun so far.` })]
      : [];

    const problem = d.problem ? h('p', { class: 'problem', text: d.problem }) : null;

    const roster = d.roster.length
      ? h('div', { class: 'table-scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Household' }), h('th', { text: 'Claimed' }), h('th', { text: 'Spun' }))),
        h('tbody', {}, ...d.roster.map((r) => h('tr', {},
          h('td', { text: r.name }),
          h('td', { text: r.household }),
          h('td', {}, h('span', { class: `pill ${r.claimed ? 'yes' : 'no'}`, text: r.claimed ? 'Yes' : 'No' })),
          h('td', {}, h('span', { class: `pill ${r.revealed ? 'yes' : 'no'}`, text: r.revealed ? formatTime(r.revealedAt) : 'Not yet' })),
        )))))
      : null;

    return h('section', { class: 'pool' }, head, problem, ...progress, roster);
  }));
}

async function generate(pool, btn) {
  if (!confirm(`Make the ${POOL_LABEL[pool].toLowerCase()} now? Matches are saved right away and the family list for this drawing is locked until you reset it.`)) return;
  btn.disabled = true;
  try {
    data.drawings = (await api('/api/admin/drawings', { method: 'POST', body: { action: 'generate', pool } })).drawings;
    renderDrawings();
    renderFamily();
    toast(`${POOL_LABEL[pool]} made. Everyone can spin now.`);
  } catch (err) {
    btn.disabled = false;
    handleError(err);
  }
}

let resetting = null;
function openReset(pool) {
  resetting = pool;
  $('reset-title').textContent = `Reset ${POOL_LABEL[pool].toLowerCase()}`;
  $('reset-phrase').textContent = `RESET ${pool.toUpperCase()}`;
  $('reset-confirm').value = '';
  $('reset-error').classList.add('hidden');
  $('reset-dialog').showModal();
}

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    data.drawings = (await api('/api/admin/drawings', {
      method: 'POST', body: { action: 'reset', pool: resetting, confirm: $('reset-confirm').value.trim() },
    })).drawings;
    $('reset-dialog').close();
    renderDrawings();
    renderFamily();
    toast(`${POOL_LABEL[resetting]} reset. The family list is unlocked.`);
  } catch (err) {
    if (err.status === 401) return handleError(err);
    $('reset-error').textContent = err.message;
    $('reset-error').classList.remove('hidden');
  }
});

// ---------------------------------------------------------------- settings
const SETTINGS = ['eventName', 'exchangeDate', 'location', 'adultBudget', 'childBudget', 'notes'];
function renderSettings() {
  for (const f of SETTINGS) $(`s-${f}`).value = data.settings?.[f] || '';
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(SETTINGS.map((f) => [f, $(`s-${f}`).value]));
  try {
    data.settings = (await api('/api/admin/settings', { method: 'PUT', body })).settings;
    renderSettings();
    renderFamily();
    toast('Event details saved');
  } catch (err) { handleError(err); }
});

// ---------------------------------------------------------------- boot
(async () => {
  try {
    const { authenticated } = await api('/api/admin/session');
    if (authenticated) await showApp();
    else showLogin();
  } catch (err) {
    showLogin();
    toast(err.message, { bad: true });
  }
})();
