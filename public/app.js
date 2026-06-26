// Vanilla front-end — no dependencies, no build step.

const els = {
  cards: document.getElementById('cards'),
  adminPanel: document.getElementById('admin-panel'),
  newUrl: document.getElementById('new-url'),
  newLabel: document.getElementById('new-label'),
  addBtn: document.getElementById('add-btn'),
  refreshAllBtn: document.getElementById('refresh-all-btn'),
  adminMsg: document.getElementById('admin-msg'),
  cronInfo: document.getElementById('cron-info'),
  whoami: document.getElementById('whoami'),
  sortBy: document.getElementById('sort-by'),
  viewToggle: document.getElementById('view-toggle'),
};

// 'cards' (grid of detailed cards) or 'list' (compact scannable table).
// Persisted so the chosen view survives reloads and the 30s auto-refresh.
let view = localStorage.getItem('view') === 'list' ? 'list' : 'cards';

// The browser handles HTTP Basic auth (native login dialog) and attaches the
// Authorization header to every same-origin request automatically, so the
// frontend never touches credentials. We only need to know our role.
let role = null;

function isAdmin() {
  return role === 'admin';
}

// ---------- formatting helpers ----------

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function relativeTime(iso) {
  if (!iso) return 'noch nie';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'vor ' + s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return 'vor ' + m + ' min';
  const h = Math.round(m / 60);
  if (h < 24) return 'vor ' + h + ' h';
  const d = Math.round(h / 24);
  return 'vor ' + d + ' Tagen';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Derive the edu-sharing portal URL (<origin>/edu-sharing) from a stored
// _about endpoint URL, preserving any path prefix before /edu-sharing.
function eduSharingUrl(url) {
  try {
    const u = new URL(url);
    const marker = '/edu-sharing';
    const idx = u.pathname.indexOf(marker);
    const path = idx >= 0 ? u.pathname.slice(0, idx + marker.length) : marker;
    return u.origin + path;
  } catch {
    return url;
  }
}

// ---------- rendering ----------

function renderCard(e) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = e.id;

  const statusClass = e.lastStatus === 'ok' ? 'ok' : e.lastStatus === 'error' ? 'error' : 'pending';
  const lastSync = e.lastSync
    ? `${relativeTime(e.lastSync)} · ${new Date(e.lastSync).toLocaleString()}`
    : 'noch nie';

  const services = Array.isArray(e.services) ? e.services : [];

  const featuresHtml = renderExtra('Features', e.features);
  const pluginsHtml = renderExtra('Plugins', e.plugins);

  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title"><a href="${escapeHtml(eduSharingUrl(e.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.label || hostOf(e.url))}</a></div>
        <div class="card-url">${escapeHtml(e.url)}</div>
      </div>
      <span class="status"><span class="dot ${statusClass}"></span>${escapeHtml(e.lastStatus || '—')}</span>
    </div>

    <div class="badges">
      <span class="badge version">Version: <strong>${escapeHtml(e.version || 'unbekannt')}</strong></span>
      ${e.rs2 ? '<span class="badge rs2">RS2</span>' : '<span class="badge">RS1</span>'}
      <span class="badge">Services: ${services.length}</span>
    </div>

    <div class="muted">Letzter Abgleich: ${escapeHtml(lastSync)}</div>
    ${e.error ? `<div class="error-text">Fehler: ${escapeHtml(e.error)}</div>` : ''}
    ${
      e.pwLink
        ? `<div class="pw-link"><a href="${escapeHtml(e.pwLink)}" target="_blank" rel="noopener noreferrer">🔑 Zugang / Passwort</a></div>`
        : ''
    }
    ${e.notes ? `<div class="notes">${escapeHtml(e.notes)}</div>` : ''}

    ${featuresHtml}
    ${pluginsHtml}
    <details>
      <summary>Rohdaten (vollständige _about-Antwort)</summary>
      <pre class="raw">lade…</pre>
    </details>
  `;

  // Lazy-load raw JSON when the details element is opened.
  const rawDetails = card.querySelectorAll('details')[card.querySelectorAll('details').length - 1];
  const rawPre = rawDetails.querySelector('pre.raw');
  let loaded = false;
  rawDetails.addEventListener('toggle', async () => {
    if (!rawDetails.open || loaded) return;
    loaded = true;
    try {
      const res = await fetch('/api/endpoints/' + encodeURIComponent(e.id));
      const data = await res.json();
      rawPre.textContent = JSON.stringify(data.endpoint && data.endpoint.raw, null, 2) || 'keine Daten';
    } catch {
      rawPre.textContent = 'Fehler beim Laden';
    }
  });

  if (isAdmin()) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    appendAdminButtons(actions, e, { refreshLabel: 'Jetzt aktualisieren', onEdit: () => openEditForm(card, e) });
    card.appendChild(actions);
  }

  return card;
}

// Build the admin action buttons (refresh / edit / delete) into `container`.
// Shared by the card and list views; `onEdit` decides where the edit form goes.
function appendAdminButtons(container, e, { refreshLabel, onEdit }) {
  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = refreshLabel || 'Aktualisieren';
  refreshBtn.className = 'secondary';
  refreshBtn.onclick = () => refreshOne(e.id);
  const editBtn = document.createElement('button');
  editBtn.textContent = 'Bearbeiten';
  editBtn.className = 'secondary';
  editBtn.onclick = onEdit;
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Löschen';
  delBtn.onclick = () => removeEndpoint(e.id, e.label || hostOf(e.url));
  container.appendChild(refreshBtn);
  container.appendChild(editBtn);
  container.appendChild(delBtn);
}

// Inline editor for an endpoint's label, password link and notes (admin only).
function openEditForm(card, e) {
  if (card.querySelector('.edit-form')) return; // already editing
  const form = document.createElement('form');
  form.className = 'edit-form';
  form.innerHTML = `
    <label class="edit-field">Label
      <input class="edit-label" type="text" value="${escapeHtml(e.label || '')}" />
    </label>
    <label class="edit-field">Passwort-Link (URL, öffnet im neuen Tab)
      <input class="edit-pw" type="text" placeholder="z. B. https://vault.example/eintrag" value="${escapeHtml(e.pwLink || '')}" />
    </label>
    <label class="edit-field">Notiz
      <textarea class="edit-notes" rows="3">${escapeHtml(e.notes || '')}</textarea>
    </label>
    <div class="row">
      <button type="submit">Speichern</button>
      <button type="button" class="secondary cancel">Abbrechen</button>
      <span class="edit-msg muted"></span>
    </div>
  `;
  form.querySelector('.cancel').onclick = () => loadEndpoints();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveEdit(e.id, form);
  });
  card.appendChild(form);
  form.querySelector('.edit-label').focus();
}

async function saveEdit(id, form) {
  const msg = form.querySelector('.edit-msg');
  msg.textContent = 'speichere…';
  msg.className = 'edit-msg muted';
  const body = {
    label: form.querySelector('.edit-label').value,
    pwLink: form.querySelector('.edit-pw').value,
    notes: form.querySelector('.edit-notes').value,
  };
  try {
    const res = await fetch('/api/endpoints/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      loadEndpoints();
    } else {
      msg.textContent = data.error || 'Fehler';
      msg.className = 'edit-msg error-text';
    }
  } catch {
    msg.textContent = 'Netzwerkfehler';
    msg.className = 'edit-msg error-text';
  }
}

// For features/plugins (arrays of objects like {id: "dataprotection"}) we only
// want the bare id, not the surrounding JSON. Fall back to name, then JSON.
function chipLabel(v) {
  if (v && typeof v === 'object') {
    if (v.id != null) return String(v.id);
    if (v.name != null) return String(v.name);
    return JSON.stringify(v);
  }
  return String(v);
}

function renderExtra(title, value) {
  if (value == null) return '';
  let inner;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    inner = `<div class="chips">${value
      .map((v) => `<span class="chip">${escapeHtml(chipLabel(v))}</span>`)
      .join('')}</div>`;
  } else if (typeof value === 'object') {
    inner = `<pre class="raw">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } else {
    inner = `<div>${escapeHtml(String(value))}</div>`;
  }
  return `<details><summary>${escapeHtml(title)}</summary>${inner}</details>`;
}

// The periodic refresh re-renders every card from scratch, which would
// collapse any <details> the user has opened. Snapshot the open/closed state
// (keyed by endpoint id + summary label) before re-rendering and reapply it
// afterwards so expanded sections stay open across refreshes.
function captureOpenState() {
  const state = {};
  for (const card of els.cards.querySelectorAll('.card')) {
    const id = card.dataset.id;
    if (!id) continue;
    const opens = {};
    for (const d of card.querySelectorAll('details')) {
      const summary = d.querySelector('summary');
      opens[summary ? summary.textContent : ''] = d.open;
    }
    state[id] = opens;
  }
  return state;
}

function restoreOpenState(state) {
  for (const card of els.cards.querySelectorAll('.card')) {
    const opens = state[card.dataset.id];
    if (!opens) continue;
    for (const d of card.querySelectorAll('details')) {
      const summary = d.querySelector('summary');
      if (opens[summary ? summary.textContent : '']) d.open = true;
    }
  }
}

// Parse a version string into numeric components so "10.0" sorts after "9.0"
// (a plain string compare would put "10" before "9"). Unknown versions sort
// last. Example: "9.1" -> [9, 1].
function versionKey(v) {
  if (v == null || v === '') return null;
  const parts = String(v)
    .split(/[^0-9]+/)
    .filter((s) => s !== '')
    .map(Number);
  return parts.length ? parts : null;
}

function compareVersion(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  if (ka == null && kb == null) return 0;
  if (ka == null) return 1; // unknown last
  if (kb == null) return -1;
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (ka[i] || 0) - (kb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Problems first, then pending, then ok.
const STATUS_RANK = { error: 0, pending: 1, ok: 2 };

function sortEndpoints(list) {
  const by = els.sortBy ? els.sortBy.value : 'label';
  const arr = list.slice();
  arr.sort((a, b) => {
    switch (by) {
      case 'url':
        return String(a.url).localeCompare(String(b.url));
      case 'status':
        return (
          (STATUS_RANK[a.lastStatus] ?? 9) - (STATUS_RANK[b.lastStatus] ?? 9) ||
          String(a.label || '').localeCompare(String(b.label || ''))
        );
      case 'version':
        return compareVersion(a.version, b.version);
      case 'label':
      default:
        return String(a.label || hostOf(a.url)).localeCompare(String(b.label || hostOf(b.url)));
    }
  });
  return arr;
}

// Compact, scannable table. One row per endpoint plus an admin actions column;
// "Bearbeiten" opens the edit form in a full-width row beneath the entry.
function renderList(list) {
  const table = document.createElement('table');
  table.className = 'list-table';

  const cols = ['Status', 'Label', 'Version', 'RS', 'Services', 'Letzter Abgleich'];
  if (isAdmin()) cols.push('Aktionen');
  table.innerHTML =
    '<thead><tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead>';

  const tbody = document.createElement('tbody');
  for (const e of list) {
    const statusClass =
      e.lastStatus === 'ok' ? 'ok' : e.lastStatus === 'error' ? 'error' : 'pending';
    const services = Array.isArray(e.services) ? e.services : [];

    const tr = document.createElement('tr');
    tr.dataset.id = e.id;

    const notesIcon = e.notes
      ? `<span class="row-note" title="${escapeHtml(e.notes)}">📝</span>`
      : '';
    const pwIcon = e.pwLink
      ? `<a class="row-pw" href="${escapeHtml(e.pwLink)}" target="_blank" rel="noopener noreferrer" title="Zugang / Passwort">🔑</a>`
      : '';

    tr.innerHTML = `
      <td><span class="status"><span class="dot ${statusClass}"></span>${escapeHtml(
        e.lastStatus || '—'
      )}</span></td>
      <td class="list-label-cell">
        <div class="list-label"><a href="${escapeHtml(
          eduSharingUrl(e.url)
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          e.label || hostOf(e.url)
        )}</a> ${pwIcon} ${notesIcon}</div>
        <div class="card-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</div>
      </td>
      <td>${escapeHtml(e.version || 'unbekannt')}</td>
      <td>${
        e.rs2 ? '<span class="badge rs2">RS2</span>' : '<span class="badge">RS1</span>'
      }</td>
      <td>${services.length}</td>
      <td class="muted">${escapeHtml(e.lastSync ? relativeTime(e.lastSync) : 'noch nie')}</td>
    `;

    if (isAdmin()) {
      const td = document.createElement('td');
      td.className = 'list-actions';
      appendAdminButtons(td, e, {
        refreshLabel: 'Aktualisieren',
        onEdit: () => openListEdit(tbody, tr, e),
      });
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // Wrap in a scroll container so the table scrolls horizontally on narrow
  // screens instead of squashing columns into each other.
  const wrap = document.createElement('div');
  wrap.className = 'list-wrap';
  wrap.appendChild(table);
  return wrap;
}

// Open the edit form for a list row in a full-width detail row right below it.
function openListEdit(tbody, tr, e) {
  if (tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('list-edit-row')) {
    return; // already editing
  }
  const editRow = document.createElement('tr');
  editRow.className = 'list-edit-row';
  const td = document.createElement('td');
  td.colSpan = isAdmin() ? 7 : 6;
  editRow.appendChild(td);
  tbody.insertBefore(editRow, tr.nextSibling);
  openEditForm(td, e);
}

async function loadEndpoints() {
  try {
    const res = await fetch('/api/endpoints');
    const data = await res.json();
    const openState = captureOpenState();
    els.cards.classList.toggle('list-mode', view === 'list');
    els.cards.innerHTML = '';
    if (!data.endpoints || data.endpoints.length === 0) {
      els.cards.innerHTML =
        '<div class="muted">Noch keine Endpunkte. Als Admin anmelden und hinzufügen.</div>';
      return;
    }
    const sorted = sortEndpoints(data.endpoints);
    if (view === 'list') {
      els.cards.appendChild(renderList(sorted));
    } else {
      for (const e of sorted) {
        els.cards.appendChild(renderCard(e));
      }
    }
    restoreOpenState(openState);
  } catch {
    els.cards.innerHTML = '<div class="error-text">Konnte Endpunkte nicht laden.</div>';
  }
}

// ---------- admin actions ----------

function setAdminMsg(msg, isError) {
  els.adminMsg.textContent = msg || '';
  els.adminMsg.className = isError ? 'error-text' : 'muted';
}

// Determine our role from the server. The browser has already supplied Basic
// credentials (via its native dialog) to load this page, so they ride along.
async function loadRole() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json();
      role = data.role;
      els.whoami.textContent = `Angemeldet als ${data.user} (${
        role === 'admin' ? 'Admin' : 'nur Lesen'
      })`;
    }
  } catch {
    /* ignore — page already required auth to load */
  }
  updateAdminUi();
}

async function addEndpoint() {
  const url = els.newUrl.value.trim();
  const label = els.newLabel.value.trim();
  if (!url) {
    setAdminMsg('Bitte URL eingeben', true);
    return;
  }
  setAdminMsg('füge hinzu…');
  try {
    const res = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label }),
    });
    const data = await res.json();
    if (res.ok) {
      els.newUrl.value = '';
      els.newLabel.value = '';
      setAdminMsg('Hinzugefügt: ' + (data.endpoint && data.endpoint.url));
      loadEndpoints();
    } else {
      setAdminMsg(data.error || 'Fehler', true);
    }
  } catch {
    setAdminMsg('Netzwerkfehler', true);
  }
}

async function refreshOne(id) {
  setAdminMsg('aktualisiere…');
  try {
    const res = await fetch('/api/endpoints/' + encodeURIComponent(id) + '/refresh', {
      method: 'POST',
    });
    if (res.ok) {
      setAdminMsg('aktualisiert');
      loadEndpoints();
    } else {
      setAdminMsg('Aktualisierung fehlgeschlagen', true);
    }
  } catch {
    setAdminMsg('Netzwerkfehler', true);
  }
}

async function refreshAll() {
  setAdminMsg('aktualisiere alle…');
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (res.ok) {
      setAdminMsg('alle aktualisiert');
      loadEndpoints();
    } else {
      setAdminMsg('Aktualisierung fehlgeschlagen', true);
    }
  } catch {
    setAdminMsg('Netzwerkfehler', true);
  }
}

async function removeEndpoint(id, label) {
  if (!confirm('Endpunkt "' + label + '" wirklich löschen?')) return;
  try {
    const res = await fetch('/api/endpoints/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
    if (res.ok) {
      setAdminMsg('gelöscht');
      loadEndpoints();
    } else {
      setAdminMsg('Löschen fehlgeschlagen', true);
    }
  } catch {
    setAdminMsg('Netzwerkfehler', true);
  }
}

function updateAdminUi() {
  // Admin panel (add/refresh) only for admins; viewers see read-only.
  els.adminPanel.classList.toggle('hidden', !isAdmin());
  loadEndpoints(); // re-render so per-card admin buttons appear/disappear
}

// ---------- wiring ----------

els.addBtn.addEventListener('click', addEndpoint);
els.newLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addEndpoint();
});
els.newUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addEndpoint();
});
els.refreshAllBtn.addEventListener('click', refreshAll);
els.sortBy.addEventListener('change', loadEndpoints);

function updateViewToggle() {
  for (const btn of els.viewToggle.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
}

els.viewToggle.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-view]');
  if (!btn || btn.dataset.view === view) return;
  view = btn.dataset.view;
  localStorage.setItem('view', view);
  updateViewToggle();
  loadEndpoints();
});
updateViewToggle();

loadRole();
loadEndpoints();

// Auto-refresh the list every 30s, but skip while an edit form is open — the
// periodic re-render rebuilds all cards/rows and would otherwise discard the
// admin's in-progress edits. The next tick after saving/cancelling resumes it.
setInterval(() => {
  if (els.cards.querySelector('.edit-form')) return;
  loadEndpoints();
}, 30000);
