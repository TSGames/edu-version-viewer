// Vanilla front-end — no dependencies, no build step.

const els = {
  cards: document.getElementById('cards'),
  adminToggle: document.getElementById('admin-toggle'),
  adminPanel: document.getElementById('admin-panel'),
  loginRow: document.getElementById('login-row'),
  adminUser: document.getElementById('admin-user'),
  adminPass: document.getElementById('admin-pass'),
  loginBtn: document.getElementById('login-btn'),
  loginStatus: document.getElementById('login-status'),
  adminActions: document.getElementById('admin-actions'),
  newUrl: document.getElementById('new-url'),
  newLabel: document.getElementById('new-label'),
  addBtn: document.getElementById('add-btn'),
  refreshAllBtn: document.getElementById('refresh-all-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  adminMsg: document.getElementById('admin-msg'),
  cronInfo: document.getElementById('cron-info'),
};

let authHeader = sessionStorage.getItem('authHeader') || null;

function authHeaders(extra) {
  const h = Object.assign({}, extra);
  if (authHeader) h['Authorization'] = authHeader;
  return h;
}

function isAdmin() {
  return Boolean(authHeader);
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

// ---------- rendering ----------

function renderCard(e) {
  const card = document.createElement('div');
  card.className = 'card';

  const statusClass = e.lastStatus === 'ok' ? 'ok' : e.lastStatus === 'error' ? 'error' : 'pending';
  const lastSync = e.lastSync
    ? `${relativeTime(e.lastSync)} · ${new Date(e.lastSync).toLocaleString()}`
    : 'noch nie';

  const services = Array.isArray(e.services) ? e.services : [];
  const servicesHtml = services.length
    ? `<div class="chips">${services
        .map((s) => `<span class="chip">${escapeHtml(s)}</span>`)
        .join('')}</div>`
    : '<div class="muted">keine Services gemeldet</div>';

  const featuresHtml = renderExtra('Features', e.features);
  const pluginsHtml = renderExtra('Plugins', e.plugins);

  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title">${escapeHtml(e.label || hostOf(e.url))}</div>
        <div class="card-url">${escapeHtml(e.url)}</div>
      </div>
      <span class="status"><span class="dot ${statusClass}"></span>${escapeHtml(e.lastStatus || '—')}</span>
    </div>

    <div class="badges">
      <span class="badge version">Version: <strong>${escapeHtml(e.version || 'unbekannt')}</strong></span>
      ${e.renderservice ? `<span class="badge">Renderservice: ${escapeHtml(e.renderservice)}</span>` : ''}
      <span class="badge">Services: ${services.length}</span>
    </div>

    <div class="muted">Letzter Abgleich: ${escapeHtml(lastSync)}</div>
    ${e.error ? `<div class="error-text">Fehler: ${escapeHtml(e.error)}</div>` : ''}

    <details>
      <summary>Services / Module (${services.length})</summary>
      ${servicesHtml}
    </details>
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
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Jetzt aktualisieren';
    refreshBtn.className = 'secondary';
    refreshBtn.onclick = () => refreshOne(e.id);
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Löschen';
    delBtn.onclick = () => removeEndpoint(e.id, e.label || hostOf(e.url));
    actions.appendChild(refreshBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
  }

  return card;
}

function renderExtra(title, value) {
  if (value == null) return '';
  let inner;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    inner = `<div class="chips">${value
      .map((v) => `<span class="chip">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`)
      .join('')}</div>`;
  } else if (typeof value === 'object') {
    inner = `<pre class="raw">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } else {
    inner = `<div>${escapeHtml(String(value))}</div>`;
  }
  return `<details><summary>${escapeHtml(title)}</summary>${inner}</details>`;
}

async function loadEndpoints() {
  try {
    const res = await fetch('/api/endpoints');
    const data = await res.json();
    els.cards.innerHTML = '';
    if (!data.endpoints || data.endpoints.length === 0) {
      els.cards.innerHTML =
        '<div class="muted">Noch keine Endpunkte. Als Admin anmelden und hinzufügen.</div>';
      return;
    }
    for (const e of data.endpoints) {
      els.cards.appendChild(renderCard(e));
    }
  } catch {
    els.cards.innerHTML = '<div class="error-text">Konnte Endpunkte nicht laden.</div>';
  }
}

// ---------- admin actions ----------

function setAdminMsg(msg, isError) {
  els.adminMsg.textContent = msg || '';
  els.adminMsg.className = isError ? 'error-text' : 'muted';
}

async function login() {
  const user = els.adminUser.value || 'admin';
  const pass = els.adminPass.value || '';
  const header = 'Basic ' + btoa(user + ':' + pass);
  els.loginStatus.textContent = 'prüfe…';
  try {
    const res = await fetch('/api/me', { headers: { Authorization: header } });
    if (res.ok) {
      authHeader = header;
      sessionStorage.setItem('authHeader', header);
      els.loginStatus.textContent = '';
      updateAdminUi();
      loadEndpoints();
    } else {
      els.loginStatus.textContent = 'Anmeldung fehlgeschlagen';
    }
  } catch {
    els.loginStatus.textContent = 'Fehler bei der Anmeldung';
  }
}

function logout() {
  authHeader = null;
  sessionStorage.removeItem('authHeader');
  updateAdminUi();
  loadEndpoints();
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
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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
      headers: authHeaders(),
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
    const res = await fetch('/api/refresh', { method: 'POST', headers: authHeaders() });
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
      headers: authHeaders(),
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
  if (isAdmin()) {
    els.loginRow.classList.add('hidden');
    els.adminActions.classList.remove('hidden');
  } else {
    els.loginRow.classList.remove('hidden');
    els.adminActions.classList.add('hidden');
  }
}

// ---------- wiring ----------

els.adminToggle.addEventListener('click', () => {
  els.adminPanel.classList.toggle('hidden');
});
els.loginBtn.addEventListener('click', login);
els.adminPass.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
els.logoutBtn.addEventListener('click', logout);
els.addBtn.addEventListener('click', addEndpoint);
els.newLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addEndpoint();
});
els.refreshAllBtn.addEventListener('click', refreshAll);

updateAdminUi();
loadEndpoints();
setInterval(loadEndpoints, 30000); // auto-refresh list
