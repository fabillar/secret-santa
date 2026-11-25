// Participant page.
import { api, h, toast, formatDate } from './common.js';
import { Wheel } from './wheel.js';

const $ = (id) => document.getElementById(id);
const state = { public: null, mine: [], claiming: null, spinning: null };

// ---------------------------------------------------------------- dialogs
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) d.close();
  });
}

// ---------------------------------------------------------------- loading
async function load() {
  try {
    const [pub, me] = await Promise.all([api('/api/state'), api('/api/me')]);
    state.public = pub;
    state.mine = me.identities;
    render();
  } catch (err) {
    $('names').replaceChildren(h('p', { class: 'error', text: err.message }));
  }
}

function render() {
  renderHeader();
  renderMine();
  renderNames();
}

function renderHeader() {
  const s = state.public.settings;
  $('event-name').textContent = s.eventName || 'Family Secret Santa';
  document.title = s.eventName || 'Family Secret Santa';
  const items = [];
  if (s.exchangeDate) items.push(['When', formatDate(s.exchangeDate)]);
  if (s.location) items.push(['Where', s.location]);
  if (s.adultBudget) items.push(['Adult gifts', s.adultBudget]);
  if (s.childBudget) items.push(['Kid gifts', s.childBudget]);
  $('details').replaceChildren(...items.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
  $('notes').textContent = s.notes || '';
  $('notes').classList.toggle('hidden', !s.notes);
}

function renderMine() {
  const mine = state.mine;
  $('mine-section').classList.toggle('hidden', mine.length === 0);
  $('steps').classList.toggle('hidden', mine.length > 0);
  $('claim-lede').textContent = mine.length
    ? 'Claiming for someone else in your house too? Tap their name.'
    : "Tap your own name to claim it. Parents can claim their kids' names on the same phone.";

  $('mine').replaceChildren(
    ...mine.map((m) => {
      const pool = m.category === 'child' ? 'Kids drawing' : 'Adults drawing';
      let body;
      if (m.recipient) {
        body = h('p', { class: 'gives' }, `${m.name.split(' ')[0]} is buying for`, h('strong', { text: m.recipient.name }),
          m.recipient.household ? h('span', { class: 'hint', text: `${m.recipient.household} household` }) : null);
      } else if (m.drawingStatus !== 'active') {
        body = h('p', { class: 'hint' }, 'The ', pool.toLowerCase(), " hasn't started yet. Check back once the organizer starts it.");
      } else if (!m.inDrawing) {
        body = h('p', { class: 'hint', text: 'This name was added after the drawing was made. Ask the organizer to redo the drawing.' });
      } else {
        body = h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => openWheel(m) }, `Spin for ${m.name.split(' ')[0]}`));
      }
      return h('article', { class: 'tag' },
        h('div', { class: 'who', text: m.name }),
        h('div', { class: 'meta', text: [m.household && `${m.household} household`, pool].filter(Boolean).join(', ') }),
        body,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'ghost small', onclick: () => forget(m) }, 'Remove from this device')),
      );
    }),
  );
}

function renderNames() {
  const { members, households } = state.public;
  const q = $('search').value.trim().toLowerCase();
  const mineIds = new Set(state.mine.map((m) => m.id));
  if (!members.length) {
    $('search-wrap').classList.add('hidden');
    $('names').replaceChildren(h('p', { class: 'empty', text: "The organizer hasn't added anyone yet. Check back soon." }));
    return;
  }
  $('search-wrap').classList.remove('hidden');

  const groups = households
    .map((hh) => ({ hh, list: members.filter((m) => m.householdId === hh.id && (!q || m.name.toLowerCase().includes(q))) }))
    .filter((g) => g.list.length);

  if (!groups.length) {
    $('names').replaceChildren(h('p', { class: 'hint', text: `No names match "${$('search').value}".` }));
    return;
  }

  $('names').replaceChildren(
    ...groups.map(({ hh, list }) =>
      h('div', { class: 'household' },
        h('h3', { text: hh.name }),
        h('ul', { class: 'names' },
          ...list.map((m) => {
            const yours = mineIds.has(m.id);
            const label = yours ? `${m.name}, claimed by you` : m.claimed ? `${m.name}, already claimed` : `Claim ${m.name}`;
            return h('li', {},
              h('button', {
                type: 'button', class: 'name-btn', disabled: m.claimed, 'aria-label': label,
                onclick: () => openClaim(m),
              }, m.name, m.category === 'child' ? h('span', { class: 'kid', text: 'kid' }) : null));
          }),
        ),
      ),
    ),
  );
}

$('search').addEventListener('input', renderNames);

// ---------------------------------------------------------------- claiming
function openClaim(member) {
  state.claiming = member;
  $('claim-dialog-text').textContent = `You're claiming ${member.name}${member.category === 'child' ? ' (kids drawing)' : ''}.`;
  $('claim-error').classList.add('hidden');
  $('claim-confirm').disabled = false;
  $('claim-dialog').showModal();
}

$('claim-confirm').addEventListener('click', async () => {
  const m = state.claiming;
  if (!m) return;
  $('claim-confirm').disabled = true;
  try {
    const res = await api('/api/claim', { method: 'POST', body: { memberId: m.id } });
    $('claim-dialog').close();
    $('code-name').textContent = res.member.name;
    $('code-value').textContent = res.recoveryCode;
    $('code-dialog').showModal();
    await load();
  } catch (err) {
    $('claim-error').textContent = err.message;
    $('claim-error').classList.remove('hidden');
    $('claim-confirm').disabled = false;
    if (err.code === 'ALREADY_CLAIMED') load();
  }
});

$('code-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('code-value').textContent);
    toast('Recovery code copied');
  } catch {
    toast('Copy failed. Select the code and copy it manually.', { bad: true });
  }
});

async function forget(m) {
  if (!confirm(`Remove ${m.name} from this device? The name stays claimed. You'll need the recovery code to get it back here.`)) return;
  try {
    const res = await api('/api/me', { method: 'POST', body: { action: 'forget', memberId: m.id } });
    state.mine = res.identities;
    render();
    toast(`${m.name} removed from this device`);
  } catch (err) {
    toast(err.message, { bad: true });
  }
}

// ---------------------------------------------------------------- recovery
$('recover-open').addEventListener('click', () => {
  $('recover-error').classList.add('hidden');
  $('recover-code').value = '';
  $('recover-dialog').showModal();
});

$('recover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/me', { method: 'POST', body: { action: 'recover', code: $('recover-code').value.trim() } });
    state.mine = res.identities;
    $('recover-dialog').close();
    await load();
    toast('Name added to this device');
  } catch (err) {
    $('recover-error').textContent = err.message;
    $('recover-error').classList.remove('hidden');
  }
});

// ---------------------------------------------------------------- wheel
const wheel = new Wheel($('wheel'));
let spinResult = null;

let spinning = false;

function previewNames(m) {
  const { members } = state.public;
  const me = members.find((x) => x.id === m.id);
  const names = members
    .filter((x) => x.category === m.category && x.id !== m.id && (!me || x.householdId !== me.householdId))
    .map((x) => x.name);
  return names.length ? names : ['?'];
}

function openWheel(m) {
  state.spinning = m;
  spinResult = null;
  $('wheel-for').textContent = m.name;
  $('reveal').replaceChildren();
  $('reveal').classList.remove('pop');
  $('wheel-spin').disabled = false;
  $('wheel-spin').classList.remove('hidden');
  $('wheel-close').disabled = false;
  $('wheel-close').textContent = 'Close';
  $('wheel-dialog').showModal();
  wheel.resize();
  wheel.setNames(previewNames(m));
  $('wheel-spin').focus();
}

$('wheel-spin').addEventListener('click', async () => {
  const m = state.spinning;
  if (!m || spinning) return;
  spinning = true;
  $('wheel-spin').disabled = true;
  $('wheel-close').disabled = true;
  $('reveal').replaceChildren(h('p', { class: 'hint', text: 'Spinning…' }));
  try {
    // The assignment was fixed on the server when the drawing was generated.
    // This fetches it; the wheel then animates to that predetermined answer.
    spinResult = await api('/api/spin', { method: 'POST', body: { memberId: m.id } });
  } catch (err) {
    $('reveal').replaceChildren(h('p', { class: 'error', text: err.message }));
    $('wheel-close').disabled = false;
    spinning = false;
    return;
  }
  if (spinResult.wheel.length) wheel.setNames(spinResult.wheel);
  await wheel.spinTo(spinResult.recipient.name);
  spinning = false;
  const first = m.name.split(' ')[0];
  $('reveal').replaceChildren(
    h('p', { text: `${first}, you're buying for` }),
    h('p', { class: 'big', text: spinResult.recipient.name }),
    spinResult.recipient.household ? h('p', { class: 'hint', text: `${spinResult.recipient.household} household. Keep it secret!` }) : null,
  );
  $('reveal').classList.add('pop');
  $('wheel-spin').classList.add('hidden');
  $('wheel-close').disabled = false;
  $('wheel-close').textContent = 'Done';
  $('wheel-close').focus();
});

// Don't let Escape close the dialog mid-spin.
$('wheel-dialog').addEventListener('cancel', (e) => {
  if (spinning) e.preventDefault();
});

$('wheel-dialog').addEventListener('close', () => {
  if (spinResult) load();
});

window.addEventListener('resize', () => {
  if ($('wheel-dialog').open) wheel.resize();
});

load();
